import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import plugin from "../dist/index.js"

// Read-only live proof with the developer's existing SSH agent and gh login.
// Publication itself is exercised separately after human approval.
if (process.platform !== "darwin") throw new Error("Live GitHub proof requires macOS")
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "oc-github-"))
const original = process.env.OPENCODE_SANDBOX_CONFIG
const disabled = process.env.OPENCODE_DISABLE_SANDBOX
type Event = {
  command: string
  cwd: string
  shell: string
  timeout: number
  env: Record<string, string | undefined>
}
try {
  delete process.env.OPENCODE_DISABLE_SANDBOX
  process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
    githubCLI: true,
    filesystem: { allowWrite: [fixture, os.tmpdir()] },
  })
  fs.writeFileSync(path.join(fixture, ".env"), "DUMMY_SECRET_DO_NOT_READ\n", { mode: 0o600 })
  let hook!: (event: Event) => Promise<void>
  await plugin.setup({
    location: { directory: fixture, project: { directory: fixture } },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    shell: {
      hook: async (_name: string, callback: typeof hook) => {
        hook = callback
        return { dispose: async () => {} }
      },
    },
  } as Plugin.Context)
  const run = async (command: string) => {
    const event: Event = {
      command,
      cwd: fixture,
      shell: "/bin/zsh",
      timeout: 60000,
      env: { DUMMY_APP_SECRET: "not-forwarded" },
    }
    await hook(event)
    assert.ok(event.env.GH_TOKEN, "An existing gh login is required")
    assert.ok(
      !event.command.includes(event.env.GH_TOKEN),
      "Generated command must not include the token",
    )
    try {
      const output = execFileSync(event.shell, ["-c", event.command], {
        cwd: fixture,
        env: { ...process.env, ...event.env },
        encoding: "utf8",
        timeout: 60000,
        stdio: ["ignore", "pipe", "pipe"],
      })
      assert.ok(!output.includes(event.env.GH_TOKEN), "Real credential must not reach shell output")
      assert.ok(event.env.GH_CONFIG_DIR)
      assert.ok(!fs.existsSync(event.env.GH_CONFIG_DIR), "Per-command config must be cleaned up")
      return output
    } catch (error) {
      const stderr = String((error as { stderr?: Buffer }).stderr ?? "").replaceAll(
        event.env.GH_TOKEN,
        "[redacted]",
      )
      throw new Error(`Sandbox command failed: ${stderr}`)
    }
  }
  assert.match(await run('test -z "$DUMMY_APP_SECRET" && printf "%s" "$GH_TOKEN"'), /.+/)
  console.log("PASS token masked in shell output; unrelated credentials removed; cleanup")
  await run('ps eww -p "$PPID" || true')
  assert.ok((await run("gh api user --jq .login")).trim())
  assert.match(
    await run("gh repo view guillermoap/opencode-sandbox-plugin --json nameWithOwner"),
    /guillermoap\/opencode-sandbox-plugin/,
  )
  await run("gh release list --repo guillermoap/opencode-sandbox-plugin --limit 1")
  console.log("PASS authenticated GitHub REST/GraphQL and release listing")
  await run("git ls-remote git@github.com:guillermoap/opencode-sandbox-plugin.git HEAD")
  console.log("PASS SSH agent authentication through authenticated proxy")
  await run(
    `! cat .env && ! cat ${JSON.stringify(path.join(os.homedir(), ".config/gh/hosts.yml"))} && ! cat ${JSON.stringify(path.join(os.homedir(), ".ssh/config"))}`,
  )
  console.log("PASS dotenv, GitHub credentials and private SSH config remain denied")
  process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
    githubCLI: true,
    filesystem: { allowWrite: [fixture] },
    network: { allowedDomains: [] },
  })
  let deniedHook!: typeof hook
  await plugin.setup({
    location: { directory: fixture, project: { directory: fixture } },
    permission: { hook: async () => ({ dispose: async () => {} }) },
    shell: {
      hook: async (_name: string, callback: typeof hook) => {
        deniedHook = callback
        return { dispose: async () => {} }
      },
    },
  } as Plugin.Context)
  const denied: Event = {
    command: "gh api user",
    cwd: fixture,
    shell: "/bin/zsh",
    timeout: 10000,
    env: {},
  }
  await deniedHook(denied)
  let blocked = false
  try {
    execFileSync(denied.shell, ["-c", denied.command], {
      cwd: fixture,
      env: { ...process.env, ...denied.env },
      stdio: "pipe",
      timeout: 15000,
    })
  } catch {
    blocked = true
  }
  assert.ok(blocked, "Bridge must retain the network allowlist")
  console.log("PASS GitHub bridge cannot bypass an empty network allowlist")
} finally {
  if (original === undefined) delete process.env.OPENCODE_SANDBOX_CONFIG
  else process.env.OPENCODE_SANDBOX_CONFIG = original
  if (disabled === undefined) delete process.env.OPENCODE_DISABLE_SANDBOX
  else process.env.OPENCODE_DISABLE_SANDBOX = disabled
  fs.rmSync(fixture, { recursive: true, force: true })
}
