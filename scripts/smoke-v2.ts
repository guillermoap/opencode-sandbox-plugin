import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import type { Plugin } from "@opencode/plugin"
import plugin from "../dist/index.js"
import { getConfigDir } from "../src/config"

if (process.platform !== "darwin") throw new Error("This smoke test requires macOS Seatbelt")

const exec = promisify(execFile)
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-sandbox-smoke-"))
const originalConfig = process.env.OPENCODE_SANDBOX_CONFIG
const originalDisabled = process.env.OPENCODE_DISABLE_SANDBOX
const marker = "DUMMY_SANDBOX_TEST_SECRET_12345"
const live = process.argv.includes("--opencode")
const policyFile = path.join(getConfigDir(), "projects", `${path.basename(fixture)}.json`)
const query = `?location[directory]=${encodeURIComponent(fixture)}`
const api = async (method: string, route: string, body?: unknown) => {
  const args = ["api", method, `${route}${query}`]
  if (body !== undefined) args.push("--data", JSON.stringify(body))
  const result = await exec("opencode", args, { cwd: fixture, timeout: 20000 })
  return result.stdout.trim() ? JSON.parse(result.stdout) : null
}

try {
  delete process.env.OPENCODE_DISABLE_SANDBOX
  await fs.mkdir(path.join(fixture, "nested"))
  for (const file of [".env", ".env.local", ".env.example", "nested/.env"]) {
    await fs.writeFile(path.join(fixture, file), `API_KEY=${marker}\n`)
  }
  await fs.writeFile(path.join(fixture, "public.txt"), "public\n")
  await fs.symlink(path.join(fixture, ".env"), path.join(fixture, "alias.txt"))
  process.env.OPENCODE_SANDBOX_CONFIG = JSON.stringify({
    mode: "enforce",
    filesystem: {
      denyRead: ["/**/.env", "/**/.env.*"],
      denyWrite: ["/**/.env", "/**/.env.*"],
      allowWrite: [fixture],
    },
    network: { allowedDomains: [] },
  })
  if (live) {
    await fs.mkdir(path.dirname(policyFile), { recursive: true })
    await fs.writeFile(policyFile, process.env.OPENCODE_SANDBOX_CONFIG)
    await fs.writeFile(
      path.join(fixture, "opencode.jsonc"),
      JSON.stringify({ plugins: [path.resolve(import.meta.dir, "..")] }),
    )
    await api("post", "/api/shell", { command: "true", cwd: fixture, timeout: 20000 })
    const deadline = Date.now() + 10000
    let active = false
    while (!active && Date.now() < deadline) {
      const plugins = await api("get", "/api/plugin")
      active = plugins.data.some(
        (entry: { id: string; state: { status: string } }) =>
          entry.id === "opencode-sandbox" && entry.state.status === "active",
      )
      if (!active) await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(active, "The fork must be active in the real OpenCode V2 plugin catalog")
    console.log("PASS fork loaded by real OpenCode V2")
  }

  type ShellEvent = {
    command: string
    cwd: string
    shell: string
    timeout: number
    env: Record<string, string | undefined>
  }
  let hook!: (event: ShellEvent) => Promise<void>
  await plugin.setup({
    location: { directory: fixture, project: { directory: fixture } },
    shell: {
      hook: async (_name: string, callback: typeof hook) => {
        hook = callback
        return { dispose: async () => {} }
      },
    },
  } as Plugin.Context)

  const run = async (command: string) => {
    if (live) {
      const { data: created } = await api("post", "/api/shell", {
        command,
        cwd: fixture,
        timeout: 20000,
      })
      let info = created
      const deadline = Date.now() + 25000
      while (info.status === "running" && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100))
        info = (await api("get", `/api/shell/${created.id}`)).data
      }
      assert.equal(info.status, "exited", JSON.stringify(info))
      const { data } = await api("get", `/api/shell/${created.id}/output`)
      return { stdout: data.output, stderr: data.output, code: info.exit }
    }
    const event: ShellEvent = {
      command,
      cwd: fixture,
      shell: "/bin/zsh",
      timeout: 20000,
      env: {},
    }
    await hook(event)
    try {
      const result = await exec(event.shell, ["-c", event.command], {
        cwd: fixture,
        timeout: 20000,
      })
      return { ...result, code: 0 }
    } catch (error) {
      return error as { stdout: string; stderr: string; code: number }
    }
  }

  const normal = await run("cat public.txt && printf '%s\\n' \"a ' quote; literal \\$dollar\"")
  assert.equal(normal.code, 0, normal.stderr)
  assert.match(normal.stdout, /public/)
  assert.match(normal.stdout, /a ' quote; literal \$dollar/)
  console.log("PASS ordinary command and shell quoting")
  for (const command of ["python3 -c 'print(42)'", "node -e 'console.log(42)'"]) {
    const result = await run(command)
    assert.equal(result.code, 0, result.stderr)
    assert.match(result.stdout, /42/)
  }
  console.log("PASS Python and Node ordinary execution")

  const commands = [
    "cat .env",
    "cat .env.local",
    "cat .env.example",
    "cat nested/.env",
    "cat alias.txt",
    "python3 -c 'from pathlib import Path; print(Path(\".env\").read_text())'",
    'node -e \'console.log(require("fs").readFileSync(".env", "utf8"))\'',
    "grep API_KEY .env",
    "printf overwritten > .env",
    "mv .env leaked.txt && cat leaked.txt",
    "ln .env linked.txt && cat linked.txt",
  ]
  for (const command of commands) {
    const result = await run(command)
    assert.notEqual(result.code, 0, `Should be blocked: ${command}`)
    assert.ok(!result.stdout.includes(marker), `Secret leaked: ${command}`)
    assert.match(result.stderr, /operation not permitted|permission denied|EPERM/i)
    console.log(`PASS blocked: ${command}`)
  }
  assert.equal(await fs.readFile(path.join(fixture, ".env"), "utf8"), `API_KEY=${marker}\n`)

  const concurrent = await Promise.all([run("cat .env"), run("cat public.txt")])
  assert.notEqual(concurrent[0].code, 0)
  assert.equal(concurrent[1].code, 0)
  console.log("PASS concurrent denied/allowed commands")

  const nonzero = await run("exit 37")
  assert.equal(nonzero.code, 37)
  console.log("PASS child exit code preserved")
} finally {
  if (live) {
    await api("delete", "/api/debug/location")
    await fs.rm(policyFile, { force: true })
  }
  if (originalConfig === undefined) delete process.env.OPENCODE_SANDBOX_CONFIG
  else process.env.OPENCODE_SANDBOX_CONFIG = originalConfig
  if (originalDisabled === undefined) delete process.env.OPENCODE_DISABLE_SANDBOX
  else process.env.OPENCODE_DISABLE_SANDBOX = originalDisabled
  await fs.rm(fixture, { recursive: true, force: true })
}
