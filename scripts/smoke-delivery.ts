import assert from "node:assert/strict"
import { execFileSync, spawn } from "node:child_process"
import fs from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { setup } from "./setup.mjs"

if (process.platform !== "darwin") throw new Error("Delivery verification requires macOS")
const revision = process.argv[2]
if (!/^[a-f0-9]{40}$/.test(revision ?? ""))
  throw new Error("Pass the published full Git revision to test")
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-delivery-"))
const env = {
  PATH: process.env.PATH,
  LANG: process.env.LANG,
  TMPDIR: process.env.TMPDIR,
  HOME: path.join(directory, "home"),
  XDG_CONFIG_HOME: path.join(directory, "config"),
  XDG_STATE_HOME: path.join(directory, "state"),
  XDG_DATA_HOME: path.join(directory, "data"),
  XDG_CACHE_HOME: path.join(directory, "cache"),
  OPENCODE_DB: path.join(directory, "test.sqlite"),
  OPENCODE_SERVER_PASSWORD: undefined,
  OPENCODE_SANDBOX_CONFIG: undefined,
  OPENCODE_DISABLE_SANDBOX: undefined,
}
fs.mkdirSync(env.HOME, { recursive: true })
const configFile = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")
const originalConfig =
  '// Preserve this comment\n{"model":"openai/gpt-4.1","plugins":[],"permissions":[{"action":"shell","resource":"git push *","effect":"deny"}],}\n'
fs.mkdirSync(path.dirname(configFile), { recursive: true })
fs.writeFileSync(configFile, originalConfig)
const reservation = net.createServer()
await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve))
const port = (reservation.address() as net.AddressInfo).port
await new Promise<void>((resolve) => reservation.close(() => resolve()))
const url = `http://127.0.0.1:${port}`
const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
  env,
  cwd: directory,
  stdio: ["ignore", "pipe", "pipe"],
})
let logs = ""
server.stdout.on("data", (chunk) => {
  logs += chunk.toString()
})
server.stderr.on("data", (chunk) => {
  logs += chunk.toString()
})
try {
  const deadline = Date.now() + 30000
  let healthy = false
  while (!healthy && Date.now() < deadline && server.exitCode === null) {
    try {
      healthy = (await fetch(`${url}/api/info`)).ok
    } catch {
      /* Server is starting. */
    }
    if (!healthy) await new Promise((resolve) => setTimeout(resolve, 100))
  }
  assert.ok(healthy, `Private server failed to start: ${logs}`)
  const run = (args: string[]) => {
    const routed = ["api", "reload"].includes(args[0]) ? [...args, "--server", url] : args
    return execFileSync("opencode", routed, {
      env,
      cwd: directory,
      encoding: "utf8",
      timeout: 180000,
      stdio: ["ignore", "pipe", "pipe"],
    })
  }
  const options = { revision, yolo: true, env, home: env.HOME, run }
  console.log(setup(options))
  const configDir = path.join(env.XDG_CONFIG_HOME, "opencode")
  const configs = ["opencode.json", "opencode.jsonc"].filter((name) =>
    fs.existsSync(path.join(configDir, name)),
  )
  assert.ok(configs.length > 0)
  assert.ok(fs.readFileSync(configFile, "utf8").includes("// Preserve this comment"))
  const entries = JSON.parse(run(["api", "get", "/api/plugin"]))
  assert.ok(
    entries.data.some(
      (entry: { id: string; state: { status: string } }) =>
        entry.id === "opencode-sandbox" && entry.state.status === "active",
    ),
  )
  console.log("PASS native Git install from published revision; real dotenv read/write denial")
  console.log(setup(options))
  console.log(setup({ ...options, uninstall: true }))
  assert.equal(fs.readFileSync(configFile, "utf8"), originalConfig)
  assert.ok(!fs.existsSync(path.join(configDir, "opencode.json")))
  assert.ok(!fs.existsSync(path.join(env.XDG_CONFIG_HOME, "opencode-sandbox", "config.json")))
  console.log("PASS idempotent reinstall and exact rollback in isolated config directories")
} finally {
  server.kill("SIGTERM")
  await new Promise<void>((resolve) => {
    if (server.exitCode !== null) resolve()
    else server.once("exit", () => resolve())
  })
  fs.rmSync(directory, { recursive: true, force: true })
}
