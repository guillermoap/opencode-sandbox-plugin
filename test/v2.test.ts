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
    permission: { hook: async () => ({ dispose: async () => {} }) },
  } as Plugin.Context)
  return hook
}

async function permissionHook() {
  let evaluate!: (event: {
    action: string
    effect: string
    resources: string[]
    message?: string
  }) => Promise<void>
  await plugin.setup({
    location: { directory: "/tmp/project", project: { directory: "/tmp/project" } },
    permission: {
      hook: async (_name: string, callback: typeof evaluate) => {
        evaluate = callback
        return { dispose: async () => {} }
      },
    },
    shell: { hook: async () => ({ dispose: async () => {} }) },
  } as Plugin.Context)
  return evaluate
}

function event(command = "printf '%s' hello"): ShellEvent {
  return { command, cwd: "/tmp/project", shell: "/bin/zsh", timeout: 1000, env: {} }
}

describe("V2 sandbox", () => {
  test("has a V2 entrypoint and retains V1 server", () => {
    expect(plugin.id).toBe("opencode-sandbox")
    expect(typeof plugin.server).toBe("function")
  })

  test("wraps the shell layer, preserves execution context and sanitizes env", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const hook = await setup()
    const input = event()
    input.env.DUMMY_SECRET_TOKEN = "dummy-credential"
    const original = structuredClone(input)
    await hook?.(input)
    expect(input.command).toContain("--settings /dev/fd/3")
    expect(input.command).toContain("3<<'OPENCODE_SANDBOX_SETTINGS'")
    expect(input.command).toContain("/bin/zsh")
    const config = JSON.parse(input.command.split("\n").at(-2) ?? "{}")
    if (process.platform === "darwin") {
      expect(config.filesystem.denyRead).toContain("/**/.env")
      expect(config.filesystem.denyWrite).toContain("/**/.env.*")
    }
    expect(config.filesystem.denyWrite).toContain(
      new URL("..", import.meta.url).pathname.replace(/\/$/, ""),
    )
    expect(input.env.DUMMY_SECRET_TOKEN).toBeUndefined()
    expect(input.command).not.toContain("dummy-credential")
    expect({ ...input, command: original.command, env: original.env }).toEqual(original)
  })

  test("isolates different locations' write policies", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const first = await setup("/tmp/one")
    const second = await setup("/tmp/two")
    const inputs = [event(), event()]
    await Promise.all([first?.(inputs[0]), second?.(inputs[1])])
    const configs = inputs.map((input) => JSON.parse(input.command.split("\n").at(-2) ?? "{}"))
    expect(configs[0].filesystem.allowWrite).toContain("/tmp/one")
    expect(configs[0].filesystem.allowWrite).not.toContain("/tmp/two")
    expect(configs[1].filesystem.allowWrite).toContain("/tmp/two")
  })

  test("PR and release publication ask even when otherwise allowed", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const evaluate = await permissionHook()
    for (const command of [
      "gh pr create",
      "'/opt/homebrew/bin/gh' --repo owner/repo pr create --title 'A PR'",
      ...["create", "upload", "edit", "delete", "delete-asset"].map(
        (verb) => `gh release ${verb} v1`,
      ),
    ]) {
      const check = { action: "shell", effect: "allow", resources: ["git status", command] }
      await evaluate(check)
      expect(check.effect).toBe("ask")
      const denied = { ...check, effect: "deny" }
      await evaluate(denied)
      expect(denied.effect).toBe("deny")
    }
    for (const command of [
      "git commit -m test",
      "gh pr view 1",
      "gh release list",
      "gh release view v1",
    ]) {
      const check = { action: "shell", effect: "allow", resources: [command] }
      await evaluate(check)
      expect(check.effect).toBe("allow")
    }
  })

  test("SSH exceptions are limited to public known hosts and an agent socket", async () => {
    process.env.OPENCODE_SANDBOX_CONFIG = "{}"
    const hook = await setup()
    const input = event()
    await hook?.(input)
    const config = JSON.parse(input.command.split("\n").at(-2) ?? "{}")
    expect(config.filesystem.denyRead.some((file: string) => file.endsWith("/.ssh"))).toBe(true)
    expect(config.filesystem.denyWrite.some((file: string) => file.endsWith("/.ssh"))).toBe(true)
    expect(input.command).toContain("StrictHostKeyChecking=yes")
    expect(input.command).toContain("BatchMode=yes")
    expect(input.command).toContain("ssh-http-proxy.mjs")
    expect(input.env.SSH_AUTH_SOCK).toBeUndefined()
  })

  test("invalid JSON or configuration blocks instead of falling back", async () => {
    for (const config of [
      "broken{",
      "null",
      "[]",
      '{"disabled":"false"}',
      '{"githubCLI":"true"}',
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
    const evaluate = await permissionHook()
    const check = { action: "shell", effect: "allow", resources: ["gh release create v1"] }
    await evaluate(check)
    expect(check.effect).toBe("allow")
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
