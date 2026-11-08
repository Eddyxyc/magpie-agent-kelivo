// Kelivo keeps its providers, assistants and model choices in SQLite
// (kelivo.db). Magpie's agent module runs in moejs and cannot open SQLite, so
// the bridge file Magpie edits is watched by bridge.mjs in the Bun plugin host
// and applied here. This module is plain Bun/Node: it is not imported by the
// agent module.
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { createHash } from "node:crypto"
import { Database } from "bun:sqlite"

export const PROVIDER_KEY = "Magpie"
export const PROVIDER_NAME = "Magpie"
export const SELECTED_MODEL_KEY = "selected_model_v1"
export const PROVIDER_AVATAR = "https://usemagpie.ai/img/icon-256.png"

const OWNER_FILE = /^owner_.*\.json$/
const STORAGE_STATE = /^state-[0-9]{12}\.json$/
const MODEL_ABILITIES = new Set(["tool", "reasoning", "structuredOutput"])
const MODEL_MODALITIES = new Set(["text", "image", "audio", "video", "pdf"])

export function expandHome(value, home = os.homedir()) {
  if (typeof value !== "string") return value
  const text = value.trim()
  if (text === "~") return home
  if (text.startsWith("~/") || text.startsWith("~\\")) {
    return path.join(home, text.slice(2))
  }
  return path.isAbsolute(text) ? text : path.resolve(text)
}

// The folder Kelivo's path_provider hands the app: the Windows company and
// product names, the macOS bundle id, or the Linux executable name.
export function supportDirectoryFor({
  platform = process.platform,
  env = process.env,
  home = os.homedir(),
} = {}) {
  const join = platform === "win32" ? path.win32.join : path.posix.join
  switch (platform) {
    case "win32":
      return join(
        env.APPDATA || join(home, "AppData", "Roaming"),
        "com.psyche",
        "kelivo",
      )
    case "darwin":
      return join(home, "Library", "Application Support", "com.psyche.kelivo")
    default:
      return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "kelivo")
  }
}

// Kelivo on Windows can move its data folder; .kelivo_storage keeps the
// current one in numbered state files.
export function dataDirectoryFor(support) {
  try {
    const control = path.join(support, ".kelivo_storage")
    const files = fs
      .readdirSync(control)
      .filter((name) => STORAGE_STATE.test(name))
      .sort()
    if (files.length === 0) return support
    const state = JSON.parse(
      fs.readFileSync(path.join(control, files[files.length - 1]), "utf8"),
    )
    const active = state?.active?.path
    if (state?.confirmed === true && typeof active === "string" && path.isAbsolute(active)) {
      return active
    }
  } catch {
    // no moved data folder, or a partial one; the support folder is the default
  }
  return support
}

export function discoverPaths({ home = os.homedir(), env = process.env, platform = process.platform, dataDir, db, control } = {}) {
  const join = platform === "win32" ? path.win32.join : path.posix.join
  let data = dataDir || env.KELIVO_DATA_DIR
  let database = db || env.KELIVO_DB
  if (data) {
    data = expandHome(data, home)
  } else {
    const support = supportDirectoryFor({ platform, env, home })
    data = dataDirectoryFor(support)
  }
  const controlPath = control
    ? expandHome(control, home)
    : join(home, ".config", "magpie", "kelivo-agent.json")
  return {
    home,
    data,
    db: database ? expandHome(database, home) : join(data, "kelivo.db"),
    lease: join(data, ".kelivo_business_lease"),
    control: controlPath,
    state: join(path.dirname(controlPath), "kelivo-bridge-state.json"),
  }
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch (error) {
    if (error?.code === "ENOENT") return null
    throw error
  }
}

export function writeJson(file, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, {
      mode,
      flag: "wx",
    })
    fs.renameSync(temp, file)
  } finally {
    fs.rmSync(temp, { force: true })
  }
}

export function sha256(text) {
  return createHash("sha256").update(String(text)).digest("hex")
}

function probe(port, token, timeout = 300) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      try {
        socket.destroy()
      } catch {
        // already gone
      }
      resolve(value)
    }
    const socket = net.connect({ host: "127.0.0.1", port })
    socket.setTimeout(timeout)
    socket.once("connect", () => socket.write(`${token}\n`))
    socket.once("data", (chunk) => finish(String(chunk).trim() === "alive"))
    socket.once("timeout", () => finish(false))
    socket.once("error", () => finish(false))
    socket.once("close", () => finish(false))
  })
}

// Kelivo's business lease publishes one owner_<pid>.json per running instance.
// The file has a loopback probe the app answers; a stale owner file is silent.
export async function isKelivoRunning(leaseDirectory) {
  let files
  try {
    files = fs.readdirSync(leaseDirectory).filter((name) => OWNER_FILE.test(name))
  } catch {
    return false
  }
  for (const name of files) {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(leaseDirectory, name), "utf8"))
      if (
        typeof owner?.instanceId !== "string" ||
        !Number.isInteger(owner?.probePort) ||
        owner.probePort <= 0 ||
        owner.probePort > 65535
      ) {
        continue
      }
      if (await probe(owner.probePort, owner.instanceId)) return true
    } catch {
      // a half-written or stale owner file is not a running app
    }
  }
  return false
}

export function validateControl(control) {
  if (!control || typeof control !== "object") return null
  const baseURL = typeof control.baseURL === "string" ? control.baseURL.trim() : ""
  const key = typeof control.gatewayKey === "string" ? control.gatewayKey : ""
  const model = typeof control.model === "string" ? control.model.trim() : ""
  if (!baseURL || !key || !model) return null
  let parsed
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new Error("Kelivo bridge: invalid gateway URL")
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Kelivo bridge: invalid gateway URL")
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error("Kelivo bridge: invalid gateway URL")
  }
  if (/[\r\n]/.test(key)) throw new Error("Kelivo bridge: invalid gateway key")
  return {
    baseURL: baseURL.replace(/\/+$/, ""),
    key,
    model,
    modelName: typeof control.modelName === "string" ? control.modelName : "",
  }
}

function text(value) {
  return typeof value === "string" ? value : ""
}

function positive(value) {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
}

function price(value) {
  if (typeof value === "string") {
    const n = Number(value)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }
  if (Number.isFinite(value) && value > 0) return value
  return undefined
}

export function sanitizeCatalog(body) {
  const data = Array.isArray(body?.data) ? body.data : []
  const out = []
  const seen = new Set()
  for (const raw of data) {
    if (!raw || typeof raw.id !== "string" || !raw.id || seen.has(raw.id)) continue
    seen.add(raw.id)
    const modalities =
      raw.modalities && typeof raw.modalities === "object" ? raw.modalities : {}
    const input = Array.isArray(modalities.input)
      ? modalities.input.filter((x) => MODEL_MODALITIES.has(x))
      : []
    const output = Array.isArray(modalities.output)
      ? modalities.output.filter((x) => MODEL_MODALITIES.has(x))
      : []
    const levels = Array.isArray(raw.reasoning_levels)
      ? raw.reasoning_levels
          .map((level) => {
            if (level === "none" || level === "off") return "off"
            if (level === "on") return "on"
            return ["auto", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)
              ? level
              : null
          })
          .filter((level, index, all) => level && all.indexOf(level) === index)
      : []
    const pricing = raw.pricing && typeof raw.pricing === "object" ? raw.pricing : {}
    out.push({
      id: raw.id,
      name: text(raw.display_name) || text(raw.magpie_label) || raw.id,
      context: positive(raw.context_window) ?? positive(raw.context_length),
      output: positive(raw.max_output_tokens),
      images: input.includes("image"),
      input,
      outputModalities: output,
      tool: raw.tool_call === true,
      reasoning: raw.reasoning === true,
      levels,
      pricing:
        price(pricing.prompt) || price(pricing.completion) || price(pricing.input_cache_read)
          ? {
              input: price(pricing.prompt),
              output: price(pricing.completion),
              cacheRead: price(pricing.input_cache_read),
              cacheWrite: price(pricing.input_cache_write),
            }
          : null,
    })
  }
  return out
}

export async function fetchCatalog(desired, { timeout = 8000 } = {}) {
  const url = `${desired.baseURL}/models`
  const response = await fetch(url, {
    headers: {
      authorization: `Bearer ${desired.key}`,
      accept: "application/json",
    },
    signal: AbortSignal.timeout(timeout),
  })
  if (!response.ok) throw new Error(`gateway answered ${response.status} for /v1/models`)
  return sanitizeCatalog(await response.json())
}

function modelOverride(model) {
  const override = {
    name: model.name || model.id,
    type: "chat",
    input: model.input?.length ? model.input : ["text"],
    output: model.outputModalities?.length ? model.outputModalities : ["text"],
  }
  const abilities = []
  if (model.tool) abilities.push("tool")
  if (model.reasoning) abilities.push("reasoning")
  if (abilities.length) override.abilities = abilities.filter((x) => MODEL_ABILITIES.has(x))
  if (model.context > 0) override.contextWindow = model.context
  if (model.output > 0) override.maxOutput = model.output
  if (model.reasoning && model.levels?.length) {
    override.reasoning = {
      levels: model.levels,
      canDisable: model.levels.includes("off"),
      dialect: "openaiReasoningEffort",
    }
  }
  if (model.pricing) {
    const pricing = {}
    const perMillion = (value) => Number((value * 1_000_000).toFixed(6))
    // Magpie reports USD per token; Kelivo shows USD per million tokens.
    if (model.pricing.input) pricing.input = perMillion(model.pricing.input)
    if (model.pricing.output) pricing.output = perMillion(model.pricing.output)
    if (model.pricing.cacheRead) pricing.cacheRead = perMillion(model.pricing.cacheRead)
    if (model.pricing.cacheWrite) pricing.cacheWrite = perMillion(model.pricing.cacheWrite)
    if (Object.keys(pricing).length) {
      pricing.currency = "USD"
      override.pricing = pricing
    }
  }
  return override
}

export function buildProviderPayload({ baseURL, key, model, catalog = [] }) {
  const models = []
  const seen = new Set()
  for (const entry of catalog) {
    if (!entry?.id || seen.has(entry.id)) continue
    seen.add(entry.id)
    models.push(entry)
  }
  if (!seen.has(model)) {
    models.unshift({ id: model, name: model, input: ["text"], outputModalities: ["text"] })
  }
  const overrides = {}
  for (const entry of models) overrides[entry.id] = modelOverride(entry)
  return {
    id: PROVIDER_KEY,
    enabled: true,
    name: PROVIDER_NAME,
    apiKey: key,
    baseUrl: baseURL,
    providerType: "openai",
    chatPath: "/chat/completions",
    useResponseApi: false,
    promptCacheKeyEnabled: false,
    models: models.map((entry) => entry.id),
    modelOverrides: overrides,
    customHeaders: [],
    customBody: [],
    proxyEnabled: false,
    proxyHost: "",
    proxyPort: "8080",
    proxyUsername: "",
    proxyPassword: "",
    avatarType: "url",
    avatarValue: PROVIDER_AVATAR,
    avatarMonochrome: false,
    multiKeyEnabled: false,
    apiKeys: [],
    aihubmixAppCodeEnabled: false,
    balanceEnabled: false,
    claudePromptCachingEnabled: false,
    claudePromptCachingTtl: "5m",
  }
}

function sameProvider(existing, wanted) {
  if (!existing) return false
  try {
    const current = JSON.parse(existing)
    if (current.id !== wanted.id) return false
    if (current.baseUrl !== wanted.baseUrl) return false
    if (current.apiKey !== wanted.apiKey) return false
    if (JSON.stringify(current.models) !== JSON.stringify(wanted.models)) return false
    if (JSON.stringify(current.modelOverrides) !== JSON.stringify(wanted.modelOverrides)) return false
    return true
  } catch {
    return false
  }
}

export function openDatabase(dbPath) {
  const db = new Database(dbPath, { create: false, readonly: false })
  db.run("PRAGMA busy_timeout = 5000")
  return db
}

export function hasKelivoTables(db) {
  const names = new Set(
    db
      .query("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => row.name),
  )
  return names.has("provider_rows") && names.has("preference_rows")
}

export function getProviderRow(db, key = PROVIDER_KEY) {
  return (
    db
      .query("SELECT provider_key, sort_order, payload FROM provider_rows WHERE provider_key = ?")
      .get(key) || null
  )
}

export function getPreference(db, key) {
  const row = db
    .query("SELECT value FROM preference_rows WHERE key = ?")
    .get(key)
  if (!row) return { exists: false, value: null }
  try {
    return { exists: true, value: JSON.parse(row.value) }
  } catch {
    return { exists: true, value: null }
  }
}

export function getAssistantRows(db) {
  try {
    return db
      .query("SELECT id, sort_order, payload FROM assistant_rows ORDER BY sort_order, id")
      .all()
  } catch {
    return []
  }
}

function nowMicros() {
  return Date.now() * 1000
}

export function upsertProvider(db, payload, sortOrder, timestamp = nowMicros()) {
  db.run(
    "INSERT INTO provider_rows (provider_key, sort_order, payload, updated_at) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(provider_key) DO UPDATE SET sort_order = excluded.sort_order, " +
      "payload = excluded.payload, updated_at = excluded.updated_at",
    [PROVIDER_KEY, sortOrder, payload, timestamp],
  )
}

export function deleteProvider(db, key = PROVIDER_KEY) {
  db.run("DELETE FROM provider_rows WHERE provider_key = ?", [key])
}

export function setPreference(db, key, value, timestamp = nowMicros()) {
  db.run(
    "INSERT INTO preference_rows (key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, JSON.stringify(value), timestamp],
  )
}

export function deletePreference(db, key) {
  db.run("DELETE FROM preference_rows WHERE key = ?", [key])
}

export function updateAssistantRow(db, id, payload, timestamp = nowMicros()) {
  db.run("UPDATE assistant_rows SET payload = ?, updated_at = ? WHERE id = ?", [
    payload,
    timestamp,
    id,
  ])
}

function nextSortOrder(db) {
  const row = db.query("SELECT MAX(sort_order) AS n FROM provider_rows").get()
  return Number.isInteger(row?.n) ? row.n + 1 : 0
}

function ours(row, state) {
  if (!row) return false
  try {
    const payload = JSON.parse(row.payload)
    return (
      payload.id === PROVIDER_KEY &&
      payload.baseUrl === state.applied.baseURL &&
      sha256(payload.apiKey) === state.applied.keySha256
    )
  } catch {
    return false
  }
}

function sameAssistantModel(payload, model) {
  return payload?.chatModelProvider === PROVIDER_KEY && payload?.chatModelId === model
}

function pointsAtMagpie(payload) {
  return payload?.chatModelProvider === PROVIDER_KEY
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// Assistant rows are written by Dart's jsonEncode, which keeps doubles as
// `7.0`. Parsing and re-encoding would turn those into `7`; replacing only
// the two string values keeps the rest of the row byte for byte.
function setJsonStringOrNull(raw, key, value) {
  const pattern = new RegExp(
    `("${escapeRegExp(key)}"\\s*:\\s*)(?:"(?:[^"\\\\]|\\\\.)*"|null)`,
  )
  if (!pattern.test(raw)) {
    try {
      const object = JSON.parse(raw)
      object[key] = value
      return JSON.stringify(object)
    } catch {
      return null
    }
  }
  const replacement = value === null ? "null" : JSON.stringify(value)
  return raw.replace(pattern, (_, prefix) => `${prefix}${replacement}`)
}

function setAssistantModel(raw, provider, model) {
  const withProvider = setJsonStringOrNull(raw, "chatModelProvider", provider)
  if (withProvider === null) return null
  return setJsonStringOrNull(withProvider, "chatModelId", model)
}

function newState() {
  return {
    version: 1,
    providerKey: PROVIDER_KEY,
    originalProvider: null,
    originalSelected: { exists: false, value: null },
    assistants: {},
    applied: null,
    catalog: [],
    catalogAt: 0,
  }
}

function writeAssistantModel(db, row, model, state) {
  let payload
  try {
    payload = JSON.parse(row.payload)
  } catch {
    return false
  }
  if (!state.assistants[row.id]) {
    state.assistants[row.id] = {
      provider: typeof payload.chatModelProvider === "string" ? payload.chatModelProvider : null,
      model: typeof payload.chatModelId === "string" ? payload.chatModelId : null,
    }
  }
  if (sameAssistantModel(payload, model)) return false
  const next = setAssistantModel(row.payload, PROVIDER_KEY, model)
  if (next === null) return false
  updateAssistantRow(db, row.id, next)
  return true
}

function ownerAlive(directory) {
  let files
  try {
    files = fs.readdirSync(directory)
  } catch {
    return false
  }
  for (const name of files) {
    const match = /^owner_([0-9]+)\.json$/.exec(name)
    if (!match) continue
    const pid = Number(match[1])
    if (!Number.isSafeInteger(pid) || pid <= 0) continue
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      if (error?.code === "EPERM") return true
    }
  }
  return false
}

function restoreFromState(db, state, timestamp = nowMicros()) {
  let changed = false
  const row = getProviderRow(db)
  if (row && ours(row, state)) {
    if (state.originalProvider) {
      upsertProvider(db, state.originalProvider.payload, state.originalProvider.sortOrder, timestamp)
    } else {
      deleteProvider(db)
    }
    changed = true
  }
  const selected = getPreference(db, SELECTED_MODEL_KEY)
  if (typeof selected.value === "string" && selected.value.startsWith(`${PROVIDER_KEY}::`)) {
    if (state.originalSelected?.exists && state.originalSelected.value !== null) {
      setPreference(db, SELECTED_MODEL_KEY, state.originalSelected.value, timestamp)
    } else {
      deletePreference(db, SELECTED_MODEL_KEY)
    }
    changed = true
  }
  for (const rowAssistant of getAssistantRows(db)) {
    const original = state.assistants?.[rowAssistant.id]
    if (!original) continue
    let payload
    try {
      payload = JSON.parse(rowAssistant.payload)
    } catch {
      continue
    }
    if (!pointsAtMagpie(payload)) continue
    let provider = original.provider
    let model = original.model
    // An assistant created while connected starts on the provider this bridge
    // made; when it goes away, fall back to the global default rather than
    // leave the assistant pointing at a deleted provider.
    if (provider === PROVIDER_KEY && !state.originalProvider) {
      provider = null
      model = null
    }
    const next = setAssistantModel(rowAssistant.payload, provider, model)
    if (next === null) continue
    updateAssistantRow(db, rowAssistant.id, next, timestamp)
    changed = true
  }
  return changed
}

// The plugin host's exit hook: a plugin removed while Kelivo is still
// connected leaves no watcher to put Kelivo back. If Magpie has already
// cleared the bridge file, do it here, synchronously, while Kelivo is closed.
export function restoreSync({ paths } = {}) {
  const resolved = paths || discoverPaths()
  let desired = null
  try {
    desired = validateControl(readJson(resolved.control))
  } catch (error) {
    if (error instanceof SyntaxError) return { status: "waiting-file" }
    desired = null
  }
  if (desired) return { status: "connected" }

  let state
  try {
    state = readJson(resolved.state)
  } catch {
    state = null
  }
  if (!state) return { status: "idle" }
  if (!state.applied?.baseURL) {
    fs.rmSync(resolved.state, { force: true })
    return { status: "restored", changed: false }
  }
  if (!fs.existsSync(resolved.db)) return { status: "waiting-db" }
  // A synchronous probe is not available; a live owner pid at exit is treated
  // as the app still running and left for the next start.
  if (ownerAlive(resolved.lease)) return { status: "busy" }

  let db
  try {
    db = openDatabase(resolved.db)
    if (!hasKelivoTables(db)) return { status: "unsupported" }
    let changed = false
    db.transaction(() => {
      changed = restoreFromState(db, state)
    })()
    fs.rmSync(resolved.state, { force: true })
    return { status: "restored", changed }
  } catch (error) {
    return { status: "error", error }
  } finally {
    db?.close()
  }
}

// Applies the bridge file to Kelivo. Kelivo itself is only touched while it is
// closed, so the app always loads our rows from disk on its next start.
export async function syncOnce({
  paths,
  statePath,
  catalog,
  timeout,
} = {}) {
  const resolved = paths || discoverPaths()
  const bridgePath = resolved.control
  const streamPath = statePath || resolved.state
  let control = null
  try {
    control = readJson(bridgePath)
  } catch {
    // Magpie is between two writes; try again on the next tick.
    return { status: "waiting-file" }
  }
  const desired = validateControl(control)
  let state = null
  try {
    state = readJson(streamPath)
  } catch {
    // A corrupt journal is no use for a restore; a new one is written below.
    fs.rmSync(streamPath, { force: true })
  }

  if (!desired) {
    if (!state) return { status: "idle" }
    if (!fs.existsSync(resolved.db)) return { status: "waiting-db" }
    if (await isKelivoRunning(resolved.lease)) return { status: "waiting-exit", disconnecting: true }
    if (!state.applied?.baseURL) {
      fs.rmSync(streamPath, { force: true })
      return { status: "restored", changed: false }
    }
    let db
    try {
      db = openDatabase(resolved.db)
      if (!hasKelivoTables(db)) return { status: "unsupported" }
      let changed = false
      const timestamp = nowMicros()
      db.transaction(() => {
        changed = restoreFromState(db, state, timestamp)
      })()
      fs.rmSync(streamPath, { force: true })
      return { status: "restored", changed }
    } catch (error) {
      return { status: "error", error }
    } finally {
      db?.close()
    }
  }

  if (!fs.existsSync(resolved.db)) return { status: "waiting-db" }
  if (await isKelivoRunning(resolved.lease)) return { status: "waiting-exit" }

  let db
  try {
    db = openDatabase(resolved.db)
    if (!hasKelivoTables(db)) return { status: "unsupported" }

    let models =
      state?.catalogBaseURL === desired.baseURL && state?.catalog?.length
        ? state.catalog
        : []
    let fetched = false
    if (catalog) {
      models = catalog
      fetched = true
    } else if (!models.length || Date.now() - (state?.catalogAt || 0) > 5 * 60_000) {
      try {
        models = await fetchCatalog(desired, timeout ? { timeout } : undefined)
        fetched = true
      } catch {
        // Use the last catalog this bridge saw, or the chosen model alone.
      }
    }

    const wanted = buildProviderPayload({
      baseURL: desired.baseURL,
      key: desired.key,
      model: desired.model,
      catalog: models,
    })
    const wantedPayload = JSON.stringify(wanted)
    const desiredSelected = `${PROVIDER_KEY}::${desired.model}`
    const current = getProviderRow(db)
    const selected = getPreference(db, SELECTED_MODEL_KEY)
    const assistants = getAssistantRows(db)
    const staleAssistant = assistants.some((row) => {
      let payload
      try {
        payload = JSON.parse(row.payload)
      } catch {
        return false
      }
      return !sameAssistantModel(payload, desired.model)
    })

    let changed = false
    const nextState = state
      ? { ...state }
      : newState()
    if (!nextState.applied) {
      nextState.originalProvider = current
        ? { sortOrder: current.sort_order, payload: current.payload }
        : null
      const existingSelected = getPreference(db, SELECTED_MODEL_KEY)
      nextState.originalSelected = existingSelected.exists
        ? { exists: true, value: existingSelected.value }
        : { exists: false, value: null }
    }
    if (fetched) {
      nextState.catalog = models
      nextState.catalogBaseURL = desired.baseURL
      nextState.catalogAt = Date.now()
    }
    nextState.applied = {
      baseURL: desired.baseURL,
      keySha256: sha256(desired.key),
      model: desired.model,
      selected: desiredSelected,
    }
    nextState.assistants ??= {}
    // Save every assistant's own model in the journal before any row changes,
    // so a crash between the journal and the transaction can be retried.
    for (const row of assistants) {
      if (nextState.assistants[row.id]) continue
      try {
        const payload = JSON.parse(row.payload)
        nextState.assistants[row.id] = {
          provider:
            typeof payload.chatModelProvider === "string" ? payload.chatModelProvider : null,
          model: typeof payload.chatModelId === "string" ? payload.chatModelId : null,
        }
      } catch {
        // an unreadable assistant is left alone
      }
    }

    // Kelivo may have been started while the catalog was fetched.
    if (await isKelivoRunning(resolved.lease)) return { status: "waiting-exit" }

    // Write the recovery journal before touching the database.
    writeJson(streamPath, nextState)

    db.transaction(() => {
      if (!sameProvider(current?.payload, wanted)) {
        upsertProvider(db, wantedPayload, current?.sort_order ?? nextSortOrder(db))
        changed = true
      }
      if (selected.value !== desiredSelected || !selected.exists) {
        setPreference(db, SELECTED_MODEL_KEY, desiredSelected)
        changed = true
      }
      for (const row of assistants) {
        if (writeAssistantModel(db, row, desired.model, nextState)) changed = true
      }
    })()
    writeJson(streamPath, nextState)

    return { status: changed || staleAssistant ? "connected" : "unchanged", changed }
  } catch (error) {
    return { status: "error", error }
  } finally {
    db?.close()
  }
}
