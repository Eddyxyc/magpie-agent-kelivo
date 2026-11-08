// Kelivo keeps its providers, its assistants and the model each one uses in
// SQLite (kelivo.db), not in a text config file. This module runs in Magpie's
// JS sandbox, where there is no SQLite, so its job is only to hold the
// connection in a small JSON file under Magpie's config folder. The companion
// Bun module in index.mjs watches that file and writes Kelivo's database while
// Kelivo is closed.
export const agent = {
  id: "kelivo",
  name: "Kelivo",
  icon: "https://raw.githubusercontent.com/Chevey339/kelivo/master/assets/icons/kelivo.png",
  // The file Magpie edits. It is a bridge, not one of Kelivo's own files.
  // The Agents page only draws a plugin agent it finds on this computer. The
  // bridge file does not exist until a model is picked, and Kelivo's data
  // folder is different on each OS, so use home (always present) to keep the
  // row visible once the plugin is installed.
  dir: "~",
  config: "~/.config/magpie/kelivo-agent.json",
  format: "json",
  model: "model",
  notice:
    "Kelivo 关闭时才会写入它的数据库；重新打开 Kelivo 即生效。 Kelivo reads this at start-up: reopen it to use the new model.",
}

export function connect({ gateway, model }) {
  if (!model || !model.id) {
    throw new Error(
      "Choose a model for Kelivo first. 请先在 Agents 页为 Kelivo 选择一个模型。",
    )
  }
  if (!gateway || !gateway.v1 || !gateway.key) {
    throw new Error(
      "Magpie's gateway is not ready yet; try again in a moment. Magpie 网关尚未就绪，请稍后重试。",
    )
  }
  return {
    baseURL: gateway.v1,
    gatewayKey: gateway.key,
  }
}
