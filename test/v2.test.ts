import { afterEach, describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"

type ShellEvent = {
  command: string
  cwd: string
  shell: string
  timeout: number
  env: Record<string, string | undefined>
}

const originalConfig = process.env.OPENCODE_SANDBOX_CONFIG
const originalDisabled = process.env.OPENCODE_DISABLE_SANDBOX

afterEach(() => {
  if (originalConfig === undefined) delete process.env.OPENCODE_SANDBOX_CONFIG
  else process.env.OPENCODE_SANDBOX_CONFIG = originalConfig
  if (originalDisabled === undefined) delete process.env.OPENCODE_DISABLE_SANDBOX
  else process.env.OPENCODE_DISABLE_SANDBOX = originalDisabled
})

async function setup(directory = "/tmp/project") {
  let hook: ((event: ShellEvent) => Promise<void> | void) | undefined
  await plugin.setup({
    location: { directory, project: { directory } },
    shell: {
      hook: async (name: string, callback: typeof hook) => {
        expect(name).toBe("create.before")
        hook = callback
        return { dispose: async () => {} }
      },
    },
  } as Plugin.Context)
  return hook
}

function event(command = "printf '%s' hello"): ShellEvent {
  return { command, cwd: "/tmp/project", shell: "/bin/zsh", timeout: 1000, env: {} }
}

describe("V2 sandbox", () => {
  test("has a V2 entrypoint and retains V1 server", () => {
    expect(plugin.id).toBe("opencode-sandbox")
    expect(typeof plugin.server).toBe("function")
  })

  test("wraps the shell layer without mutating cwd, shell, timeout or env", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const hook = await setup()
    const input = event()
    const original = structuredClone(input)
    await hook?.(input)
    expect(input.command).toContain("--settings /dev/fd/3")
    expect(input.command).toContain("3<<'OPENCODE_SANDBOX_SETTINGS'")
    expect(input.command).toContain("/bin/zsh")
    const config = JSON.parse(input.command.split("\n")[1] ?? "{}")
    expect(config.filesystem.denyWrite).toContain(
      new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    )
    expect({ ...input, command: original.command }).toEqual(original)
  })

  test("isolates different locations' write policies", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const first = await setup("/tmp/one")
    const second = await setup("/tmp/two")
    const inputs = [event(), event()]
    await Promise.all([first?.(inputs[0]), second?.(inputs[1])])
    const configs = inputs.map((input) => JSON.parse(input.command.split("\n")[1] ?? "{}"))
    expect(configs[0].filesystem.allowWrite).toContain("/tmp/one")
    expect(configs[0].filesystem.allowWrite).not.toContain("/tmp/two")
    expect(configs[1].filesystem.allowWrite).toContain("/tmp/two")
  })

  test("invalid JSON or configuration blocks instead of falling back", async () => {
    for (const config of [
      "broken{",
      "null",
      "[]",
      '{"disabled":"false"}',
      '{"filesystem":{"denyRead":false}}',
    ]) {
      process.env.OPENCODE_SANDBOX_CONFIG = config
      const hook = await setup()
      const input = event()
      await expect(hook?.(input)).rejects.toThrow("command blocked")
      expect(input.command).toBe(event().command)
    }
  })

  test("explicit disable does not wrap commands", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = '{"disabled":true}'
    const hook = await setup()
    const input = event()
    await hook?.(input)
    expect(input.command).toBe(event().command)
    process.env.OPENCODE_DISABLE_SANDBOX = "1"
    expect(await setup()).toBeUndefined()
  })

  test("missing Node blocks the command without changing its input", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const hook = await setup()
    const input = event()
    const originalPath = process.env.PATH
    try {
      process.env.PATH = "/does-not-exist"
      await expect(hook?.(input)).rejects.toThrow("command blocked")
      expect(input.command).toBe(event().command)
    } finally {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
    }
  })
})
