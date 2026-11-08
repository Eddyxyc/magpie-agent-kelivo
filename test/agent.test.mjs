import { expect, test } from "bun:test"
import { agent, connect } from "../kelivo.agent.js"

test("declares a Magpie agent that keeps its state in a bridge file", () => {
  expect(agent.id).toBe("kelivo")
  expect(agent.name).toBe("Kelivo")
  expect(agent.config).toEndWith("kelivo-agent.json")
  expect(agent.model).toBe("model")
})

test("connect writes Magpie's gateway into the bridge file", () => {
  expect(
    connect({
      gateway: { v1: "http://127.0.0.1:3425/v1", key: "magpie-key" },
      model: { id: "deepseek/deepseek-chat" },
    }),
  ).toEqual({
    baseURL: "http://127.0.0.1:3425/v1",
    gatewayKey: "magpie-key",
  })
})

test("connect refuses an incomplete selection", () => {
  expect(() => connect({ gateway: { v1: "http://127.0.0.1:3425/v1", key: "k" } })).toThrow()
  expect(() => connect({ gateway: {}, model: { id: "x" } })).toThrow()
})
