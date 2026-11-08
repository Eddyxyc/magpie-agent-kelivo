// The Bun half of the plugin: Magpie's agent module runs in moejs and cannot
// open Kelivo's SQLite database, so this module runs in the shared plugin
// host and watches the bridge file the agent module writes.
import { agent } from "./kelivo.agent.js"
import { discoverPaths, expandHome, restoreSync } from "./kelivo.mjs"
import { startBridge } from "./bridge.mjs"

const instance = Symbol.for("magpie.kelivo.bridge.v1")

export default async function Kelivo(_input, options = {}) {
  if (!globalThis[instance]) {
    const paths = discoverPaths({
      dataDir: options.dataDir || options.data_dir,
      db: options.db || options.database,
      control: expandHome(agent.config),
    })
    const stop = startBridge({ paths })
    globalThis[instance] = { stop }
    // Removing the plugin stops this host. If Magpie has already cleared the
    // bridge file, put Kelivo back now rather than leave a dead provider.
    process.once("exit", () => {
      try {
        restoreSync({ paths })
      } catch {
        // the next magpie start will retry from the journal
      }
    })
  }
  return {}
}
