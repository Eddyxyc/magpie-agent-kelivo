// Watches the small JSON file Magpie's agent module writes and applies it to
// Kelivo while Kelivo is closed. This is the Bun half of the plugin: the
// agent module (kelivo.agent.js) runs in Magpie's moejs sandbox and only keeps
// the connection in the bridge file.
import fs from "node:fs"
import { discoverPaths, readJson, syncOnce } from "./kelivo.mjs"

const active = new Map()

const labels = {
  idle: "not connected",
  "waiting-file": "waiting for Magpie to finish writing",
  "waiting-db": "waiting for Kelivo's database (start Kelivo once, or set KELIVO_DATA_DIR)",
  "waiting-exit": "waiting for Kelivo to close",
  unsupported: "Kelivo's database is too old for this bridge (Kelivo 1.3+ with SQLite is needed)",
  connected: "Kelivo was updated",
  unchanged: "Kelivo is up to date",
  restored: "Kelivo was put back",
}

function label(result) {
  if (result.status === "waiting-exit" && result.disconnecting) {
    return "waiting for Kelivo to close before putting it back"
  }
  return labels[result.status] || result.status
}

export function startBridge({
  paths,
  options = {},
  interval = 2000,
  onStatus = null,
} = {}) {
  const resolved =
    paths ||
    discoverPaths({
      dataDir: options.dataDir || options.data_dir,
      db: options.db || options.database,
    })
  const key = resolved.control || resolved.db
  if (active.has(key)) return active.get(key)

  let stopped = false
  let busy = false
  let last = ""
  let lastStatus = ""
  let lastSignature = null
  let lastRun = 0

  const report = (result) => {
    lastStatus = result.status
    const next = label(result)
    if (next === last) return
    last = next
    if (onStatus) {
      onStatus(next, result)
      return
    }
    if (result.status === "error") {
      console.error(`kelivo: ${result.error?.message || result.error}`)
      return
    }
    console.error(`kelivo: ${next}`)
  }

  const signature = () => {
    try {
      const stat = fs.statSync(resolved.control)
      return `${stat.mtimeMs}:${stat.size}`
    } catch {
      return "none"
    }
  }

  const tick = async () => {
    if (busy || stopped) return
    const now = Date.now()
    const current = signature()
    const waiting =
      lastStatus === "waiting-exit" ||
      lastStatus === "waiting-db" ||
      lastStatus === "waiting-file"
    // A changed bridge file is applied at once. Otherwise look again every
    // 30 seconds, so a row Kelivo rewrote in the meantime is repaired.
    if (!waiting && current === lastSignature && now - lastRun < 30_000) return
    lastSignature = current
    lastRun = now
    busy = true
    try {
      report(await syncOnce({ paths: resolved }))
    } catch (error) {
      report({ status: "error", error })
    } finally {
      busy = false
    }
  }

  const timer = setInterval(tick, interval)
  timer.unref?.()
  void tick()

  const stop = () => {
    stopped = true
    clearInterval(timer)
    active.delete(key)
  }
  active.set(key, stop)
  return stop
}

if (import.meta.main) {
  const paths = discoverPaths({ control: process.argv[2] })
  const result = await syncOnce({ paths })
  console.log(label(result))
  if (result.status === "error") {
    console.error(result.error?.stack || result.error)
    process.exitCode = 1
  } else {
    console.log(`bridge: ${paths.control}`)
    console.log(`state:  ${paths.state}`)
    console.log(`kelivo: ${paths.db}`)
    if (fs.existsSync(paths.control)) {
      const control = readJson(paths.control)
      if (control?.model) console.log(`model:  ${control.model}`)
    }
  }
}
