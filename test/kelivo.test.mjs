import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import {
  SELECTED_MODEL_KEY,
  buildProviderPayload,
  discoverPaths,
  isKelivoRunning,
  restoreSync,
  sanitizeCatalog,
  sha256,
  syncOnce,
  validateControl,
} from "../kelivo.mjs"

const created = []

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kelivo-bridge-"))
  created.push(dir)
  return dir
}

afterEach(() => {
  while (created.length) fs.rmSync(created.pop(), { recursive: true, force: true })
})

function makeDb(dir, { provider = null, selected = null, assistants = [] } = {}) {
  const dbPath = path.join(dir, "kelivo.db")
  const db = new Database(dbPath, { create: true })
  db.run(
    "CREATE TABLE provider_rows (provider_key TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  )
  db.run(
    "CREATE TABLE preference_rows (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  )
  db.run(
    "CREATE TABLE assistant_rows (id TEXT PRIMARY KEY, sort_order INTEGER NOT NULL, payload TEXT NOT NULL, updated_at INTEGER NOT NULL)",
  )
  if (provider) {
    db.run("INSERT INTO provider_rows VALUES (?, ?, ?, ?)", [
      provider.key || "Magpie",
      provider.sortOrder ?? 0,
      provider.payload,
      1,
    ])
  }
  if (selected !== null) {
    db.run("INSERT INTO preference_rows VALUES (?, ?, ?)", [
      SELECTED_MODEL_KEY,
      JSON.stringify(selected),
      1,
    ])
  }
  assistants.forEach((assistant, index) => {
    db.run("INSERT INTO assistant_rows VALUES (?, ?, ?, ?)", [
      assistant.id,
      index,
      JSON.stringify(assistant.payload),
      1,
    ])
  })
  db.close()
  return dbPath
}

function pathsFor(dir, db) {
  return {
    control: path.join(dir, "kelivo-agent.json"),
    state: path.join(dir, "kelivo-bridge-state.json"),
    db,
    lease: path.join(dir, ".kelivo_business_lease"),
  }
}

function writeControl(paths, control) {
  fs.writeFileSync(paths.control, JSON.stringify(control, null, 2))
}

function readDb(dbPath) {
  const db = new Database(dbPath, { readonly: true })
  try {
    return {
      provider: db.query("SELECT * FROM provider_rows WHERE provider_key = 'Magpie'").get(),
      providers: db.query("SELECT * FROM provider_rows ORDER BY sort_order").all(),
      selected: db.query("SELECT value FROM preference_rows WHERE key = ?").get(SELECTED_MODEL_KEY),
      assistants: db.query("SELECT * FROM assistant_rows ORDER BY sort_order").all(),
    }
  } finally {
    db.close()
  }
}

const CATALOG = [
  {
    id: "deepseek/deepseek-chat",
    name: "DeepSeek Chat",
    context: 128000,
    output: 8192,
    input: ["text"],
    outputModalities: ["text"],
    tool: true,
    reasoning: true,
    levels: ["low", "high"],
    pricing: { input: 0.0000002, output: 0.000001 },
  },
  {
    id: "openai/gpt-5",
    name: "GPT-5",
    context: 400000,
    output: 128000,
    input: ["text", "image"],
    outputModalities: ["text"],
    tool: true,
    reasoning: true,
    levels: ["off", "low", "medium", "high"],
    pricing: null,
  },
]

const CONTROL = {
  baseURL: "http://127.0.0.1:3425/v1",
  gatewayKey: "magpie-test-key",
  model: "deepseek/deepseek-chat",
}

describe("Kelivo bridge", () => {
  test("connects a new provider, selects the model and adapts assistants", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir, {
      assistants: [
        {
          id: "a1",
          payload: {
            id: "a1",
            name: "Assistant",
            chatModelProvider: "DeepSeek",
            chatModelId: "deepseek-v4-pro",
          },
        },
      ],
    })
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)

    const result = await syncOnce({ paths, catalog: CATALOG })
    expect(result.status).toBe("connected")

    const db = readDb(dbPath)
    const payload = JSON.parse(db.provider.payload)
    expect(payload.id).toBe("Magpie")
    expect(payload.baseUrl).toBe(CONTROL.baseURL)
    expect(payload.apiKey).toBe(CONTROL.gatewayKey)
    expect(payload.models).toEqual(["deepseek/deepseek-chat", "openai/gpt-5"])
    expect(payload.modelOverrides["deepseek/deepseek-chat"].name).toBe("DeepSeek Chat")
    expect(payload.modelOverrides["deepseek/deepseek-chat"].abilities).toEqual([
      "tool",
      "reasoning",
    ])
    expect(payload.modelOverrides["deepseek/deepseek-chat"].pricing.input).toBeCloseTo(0.2)
    expect(payload.modelOverrides["openai/gpt-5"].input).toEqual(["text", "image"])
    expect(payload.modelOverrides["openai/gpt-5"].reasoning.canDisable).toBe(true)
    expect(JSON.parse(db.selected.value)).toBe("Magpie::deepseek/deepseek-chat")
    expect(JSON.parse(db.assistants[0].payload).chatModelProvider).toBe("Magpie")
    expect(JSON.parse(db.assistants[0].payload).chatModelId).toBe("deepseek/deepseek-chat")

    const state = JSON.parse(fs.readFileSync(paths.state, "utf8"))
    expect(state.originalProvider).toBeNull()
    expect(state.assistants.a1).toEqual({
      provider: "DeepSeek",
      model: "deepseek-v4-pro",
    })
  })

  test("is idempotent", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir)
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)

    expect((await syncOnce({ paths, catalog: CATALOG })).status).toBe("connected")
    expect((await syncOnce({ paths, catalog: CATALOG })).status).toBe("unchanged")
  })

  test("changes the model without losing the first backup", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir, {
      provider: {
        payload: JSON.stringify({
          id: "Magpie",
          enabled: true,
          name: "Magpie",
          apiKey: "old-key",
          baseUrl: "https://old.example/v1",
          models: ["old/model"],
        }),
        sortOrder: 7,
      },
      selected: "Magpie::old/model",
    })
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)

    await syncOnce({ paths, catalog: CATALOG })
    writeControl(paths, { ...CONTROL, model: "openai/gpt-5" })
    const result = await syncOnce({ paths, catalog: CATALOG })
    expect(result.status).toBe("connected")

    const db = readDb(dbPath)
    expect(JSON.parse(db.selected.value)).toBe("Magpie::openai/gpt-5")
    expect(db.provider.sort_order).toBe(7)
    expect(JSON.parse(db.provider.payload).apiKey).toBe(CONTROL.gatewayKey)

    const state = JSON.parse(fs.readFileSync(paths.state, "utf8"))
    expect(state.originalProvider.payload).toContain("old-key")
    expect(state.originalSelected).toEqual({ exists: true, value: "Magpie::old/model" })
  })

  test("puts a pre-existing provider, selected model and assistants back", async () => {
    const dir = tempDir()
    const original = JSON.stringify({
      id: "Magpie",
      enabled: true,
      name: "Magpie",
      apiKey: "old-key",
      baseUrl: "https://old.example/v1",
      models: ["old/model"],
      modelOverrides: {},
    })
    const dbPath = makeDb(dir, {
      provider: { payload: original, sortOrder: 3 },
      selected: "Magpie::old/model",
      assistants: [
        {
          id: "a1",
          payload: {
            id: "a1",
            name: "Assistant",
            chatModelProvider: "OpenAI",
            chatModelId: "gpt-5",
          },
        },
      ],
    })
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)

    await syncOnce({ paths, catalog: CATALOG })
    fs.writeFileSync(paths.control, "{}")
    const result = await syncOnce({ paths, catalog: CATALOG })
    expect(result.status).toBe("restored")

    const db = readDb(dbPath)
    expect(db.provider.payload).toBe(original)
    expect(db.provider.sort_order).toBe(3)
    expect(JSON.parse(db.selected.value)).toBe("Magpie::old/model")
    expect(JSON.parse(db.assistants[0].payload).chatModelProvider).toBe("OpenAI")
    expect(JSON.parse(db.assistants[0].payload).chatModelId).toBe("gpt-5")
    expect(fs.existsSync(paths.state)).toBe(false)
  })

  test("removes what it added when there was no provider before", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir, {
      assistants: [{ id: "a1", payload: { id: "a1", name: "Assistant" } }],
    })
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)

    await syncOnce({ paths, catalog: CATALOG })
    fs.writeFileSync(paths.control, "{}")
    const result = await syncOnce({ paths, catalog: CATALOG })
    expect(result.status).toBe("restored")

    const db = readDb(dbPath)
    expect(db.provider).toBeNull()
    expect(db.selected).toBeNull()
    expect(JSON.parse(db.assistants[0].payload).chatModelProvider).toBeNull()
    expect(JSON.parse(db.assistants[0].payload).chatModelId).toBeNull()
  })

  test("leaves the database alone while Kelivo is running", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir)
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)

    const token = "test-instance"
    const server = net.createServer((socket) => {
      socket.on("data", (chunk) => {
        if (String(chunk).trim() === token) socket.write("alive\n")
      })
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    const port = server.address().port
    fs.mkdirSync(paths.lease, { recursive: true })
    fs.writeFileSync(
      path.join(paths.lease, "owner_123.json"),
      JSON.stringify({ instanceId: token, probePort: port }),
    )

    expect(await isKelivoRunning(paths.lease)).toBe(true)
    const waiting = await syncOnce({ paths, catalog: CATALOG })
    expect(waiting.status).toBe("waiting-exit")
    expect(readDb(dbPath).provider).toBeNull()

    await new Promise((resolve) => server.close(resolve))
    const connected = await syncOnce({ paths, catalog: CATALOG })
    expect(connected.status).toBe("connected")
    expect(readDb(dbPath).provider).not.toBeNull()
  })

  test("ignores stale owner files", async () => {
    const dir = tempDir()
    const lease = path.join(dir, ".kelivo_business_lease")
    fs.mkdirSync(lease, { recursive: true })
    fs.writeFileSync(
      path.join(lease, "owner_1.json"),
      JSON.stringify({ instanceId: "gone", probePort: 1 }),
    )
    expect(await isKelivoRunning(lease)).toBe(false)
  })

  test("keeps retrying while Kelivo's database does not exist", async () => {
    const dir = tempDir()
    const paths = pathsFor(dir, path.join(dir, "missing.db"))
    writeControl(paths, CONTROL)
    expect((await syncOnce({ paths, catalog: CATALOG })).status).toBe("waiting-db")
  })

  test("restores synchronously when the host exits after the bridge is cleared", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir)
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)
    await syncOnce({ paths, catalog: CATALOG })
    expect(readDb(dbPath).provider).not.toBeNull()

    fs.writeFileSync(paths.control, "{}")
    expect(restoreSync({ paths }).status).toBe("restored")
    expect(readDb(dbPath).provider).toBeNull()
    expect(fs.existsSync(paths.state)).toBe(false)
  })

  test("falls back to the default for an assistant created while connected", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir)
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)
    await syncOnce({ paths, catalog: CATALOG })

    const db = new Database(dbPath, { create: false })
    db.run("INSERT INTO assistant_rows VALUES (?, ?, ?, ?)", [
      "new",
      0,
      JSON.stringify({
        id: "new",
        name: "New",
        chatModelProvider: "Magpie",
        chatModelId: "deepseek/deepseek-chat",
      }),
      1,
    ])
    db.close()
    await syncOnce({ paths, catalog: CATALOG })

    fs.writeFileSync(paths.control, "{}")
    expect((await syncOnce({ paths, catalog: CATALOG })).status).toBe("restored")
    const after = readDb(dbPath)
    expect(JSON.parse(after.assistants[0].payload).chatModelProvider).toBeNull()
    expect(JSON.parse(after.assistants[0].payload).chatModelId).toBeNull()
  })

  test("does not restore on exit while the bridge still holds the connection", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir)
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)
    await syncOnce({ paths, catalog: CATALOG })
    expect(restoreSync({ paths }).status).toBe("connected")
    expect(readDb(dbPath).provider).not.toBeNull()
  })

  test("leaves a running Kelivo alone on exit", async () => {
    const dir = tempDir()
    const dbPath = makeDb(dir)
    const paths = pathsFor(dir, dbPath)
    writeControl(paths, CONTROL)
    await syncOnce({ paths, catalog: CATALOG })
    fs.writeFileSync(paths.control, "{}")
    fs.mkdirSync(paths.lease, { recursive: true })
    fs.writeFileSync(path.join(paths.lease, `owner_${process.pid}.json`), "{}")
    expect(restoreSync({ paths }).status).toBe("busy")
    expect(readDb(dbPath).provider).not.toBeNull()
  })
})

describe("inputs", () => {
  test("validates the bridge file", () => {
    expect(validateControl(CONTROL)).toEqual({
      baseURL: CONTROL.baseURL,
      key: CONTROL.gatewayKey,
      model: CONTROL.model,
      modelName: "",
    })
    expect(validateControl({})).toBeNull()
    expect(() => validateControl({ ...CONTROL, baseURL: "file:///tmp/x" })).toThrow()
    expect(() => validateControl({ ...CONTROL, gatewayKey: "a\nb" })).toThrow()
  })

  test("maps /v1/models entries", () => {
    const [model] = sanitizeCatalog({
      data: [
        {
          id: "provider/model",
          display_name: "Model",
          context_window: 1000,
          max_output_tokens: 100,
          modalities: { input: ["text", "image"] },
          reasoning: true,
          reasoning_levels: ["none", "low", "bogus"],
          tool_call: true,
          pricing: { prompt: "0.000001", completion: "0.000002" },
        },
      ],
    })
    expect(model).toEqual({
      id: "provider/model",
      name: "Model",
      context: 1000,
      output: 100,
      images: true,
      input: ["text", "image"],
      outputModalities: [],
      tool: true,
      reasoning: true,
      levels: ["off", "low"],
      pricing: { input: 0.000001, output: 0.000002, cacheRead: undefined, cacheWrite: undefined },
    })
  })

  test("builds a provider payload even without a catalog", () => {
    const payload = buildProviderPayload({
      baseURL: "http://127.0.0.1:3425/v1",
      key: "secret",
      model: "group/fast",
    })
    expect(payload.models).toEqual(["group/fast"])
    expect(payload.modelOverrides["group/fast"]).toEqual({
      name: "group/fast",
      type: "chat",
      input: ["text"],
      output: ["text"],
    })
  })

  test("finds each platform's Kelivo folder", () => {
    expect(
      discoverPaths({
        platform: "win32",
        home: "C:\\Users\\me",
        env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" },
      }).db,
    ).toBe("C:\\Users\\me\\AppData\\Roaming\\com.psyche\\kelivo\\kelivo.db")
    expect(
      discoverPaths({
        platform: "darwin",
        home: "/Users/me",
        env: {},
      }).db,
    ).toBe("/Users/me/Library/Application Support/com.psyche.kelivo/kelivo.db")
    expect(
      discoverPaths({
        platform: "linux",
        home: "/home/me",
        env: { XDG_DATA_HOME: "/home/me/.local/share" },
      }).db,
    ).toBe("/home/me/.local/share/kelivo/kelivo.db")
  })

  test("follows a moved Windows data folder", () => {
    const appData = tempDir()
    const moved = tempDir()
    const support = path.join(appData, "com.psyche", "kelivo")
    fs.mkdirSync(path.join(support, ".kelivo_storage"), { recursive: true })
    fs.writeFileSync(
      path.join(support, ".kelivo_storage", "state-000000000001.json"),
      JSON.stringify({ version: 1, active: { path: moved, id: "x" }, confirmed: true }),
    )
    expect(
      discoverPaths({ platform: "win32", home: "", env: { APPDATA: appData }, dataDir: null }).db,
    ).toBe(path.join(moved, "kelivo.db"))
  })

  test("hashes keys for the recovery journal", () => {
    expect(sha256("abc")).toHaveLength(64)
  })
})
