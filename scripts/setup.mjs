import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { applyEdits, modify, parse, parseTree } from "jsonc-parser"

const REVISION = "__OPENCODE_SANDBOX_REVISION__"
const REPOSITORY = "github:guillermoap/opencode-sandbox-plugin"
const ENV_PATTERNS = ["/**/.env", "/**/.env.*"]
const format = { insertSpaces: true, tabSize: 2, eol: "\n" }
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex")

function read(file) {
  try {
    const stat = fs.lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${file}`)
    return { file, bytes: fs.readFileSync(file), mode: stat.mode & 0o777 }
  } catch (error) {
    if (error.code === "ENOENT") return { file, bytes: null, mode: 0o600 }
    throw error
  }
}

function atomicWrite(file, bytes, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, bytes, { mode, flag: "wx" })
    fs.renameSync(temporary, file)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

function document(bytes, file) {
  const text = bytes?.toString("utf8") ?? "{}\n"
  const errors = []
  const value = parse(text, errors, { allowTrailingComma: true })
  const tree = parseTree(text)
  if (errors.length || !value || Array.isArray(value) || typeof value !== "object") {
    throw new Error(`Invalid JSON/JSONC object: ${file}`)
  }
  const checkKeys = (node) => {
    if (node?.type === "object") {
      const keys = node.children?.map((property) => property.children[0].value) ?? []
      if (new Set(keys).size !== keys.length)
        throw new Error(`Duplicate configuration keys: ${file}`)
    }
    for (const child of node?.children ?? []) checkKeys(child)
  }
  checkKeys(tree)
  return { text, value }
}

function set(text, key, value) {
  return applyEdits(text, modify(text, [key], value, { formattingOptions: format }))
}

export function permissionConfig(bytes, yolo, file = "OpenCode config") {
  const { text, value } = document(bytes, file)
  if (value.permission !== undefined)
    throw new Error("Migrate legacy permission settings to V2 first")
  if (value.permissions !== undefined && !Array.isArray(value.permissions)) {
    throw new Error(`permissions must be an array: ${file}`)
  }
  const rules = [...(value.permissions ?? [])].filter(
    (rule) =>
      !(
        rule &&
        Object.keys(rule).length === 3 &&
        ["read", "edit"].includes(rule.action) &&
        ["*.env", "*.env.*"].includes(rule.resource) &&
        rule.effect === "deny"
      ),
  )
  if (
    yolo &&
    !rules.some((rule) => rule.action === "*" && rule.resource === "*" && rule.effect === "allow")
  ) {
    // Explicit existing denies and prompts retain precedence over this fallback.
    rules.unshift({ action: "*", resource: "*", effect: "allow" })
  }
  for (const action of ["read", "edit"]) {
    for (const resource of ["*.env", "*.env.*"]) {
      const rule = { action, resource, effect: "deny" }
      rules.push(rule)
    }
  }
  return Buffer.from(set(text, "permissions", rules))
}

export function sandboxConfig(bytes, yolo, home = os.homedir(), file = "sandbox config") {
  let { text, value } = document(bytes, file)
  for (const key of ["filesystem", "network"]) {
    if (
      value[key] !== undefined &&
      (!value[key] || typeof value[key] !== "object" || Array.isArray(value[key]))
    ) {
      throw new Error(`${key} must be an object: ${file}`)
    }
  }
  const filesystem = { ...value.filesystem }
  for (const key of ["denyRead", "denyWrite", "allowRead", "allowWrite"]) {
    if (
      filesystem[key] !== undefined &&
      (!Array.isArray(filesystem[key]) || filesystem[key].some((item) => typeof item !== "string"))
    ) {
      throw new Error(`${key} must be a string array: ${file}`)
    }
  }
  for (const key of ["denyRead", "denyWrite"]) {
    // Missing arrays retain the runtime's credential defaults. The V2 guard
    // adds dotenv restrictions itself, even with no sandbox configuration.
    if (filesystem[key] !== undefined)
      filesystem[key] = [...new Set([...filesystem[key], ...ENV_PATTERNS])]
  }
  if (yolo) {
    filesystem.allowWrite = [
      ...new Set([...(filesystem.allowWrite ?? []), home, os.tmpdir(), "/tmp", "/private/tmp"]),
    ]
  }
  text = set(text, "mode", "enforce")
  text = set(text, "disabled", false)
  text = set(text, "filesystem", filesystem)
  if (yolo) text = set(text, "network", { ...value.network, allowLocalBinding: true })
  return Buffer.from(text)
}

function command(args) {
  return execFileSync("opencode", args, {
    encoding: "utf8",
    timeout: 180000,
    stdio: ["ignore", "pipe", "pipe"],
  })
}

export function verifyProtection(run = command) {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sandbox-verify-"))
  const query = `?location[directory]=${encodeURIComponent(fixture)}`
  const marker = `DUMMY_${randomUUID()}`
  const api = (method, route, body) => {
    const args = ["api", method, `${route}${query}`]
    if (body !== undefined) args.push("--data", JSON.stringify(body))
    const output = run(args)
    return output.trim() ? JSON.parse(output) : null
  }
  const wait = (predicate) => {
    const deadline = Date.now() + 30000
    while (Date.now() < deadline) {
      const result = predicate()
      if (result) return result
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
    }
    throw new Error("Timed out verifying the installed sandbox")
  }
  try {
    fs.writeFileSync(path.join(fixture, ".env"), `TEST_SECRET=${marker}\n`, { mode: 0o600 })
    fs.writeFileSync(path.join(fixture, "public.txt"), "sandbox-public-control\n")
    api("post", "/api/shell", { command: "true", cwd: fixture, timeout: 10000 })
    wait(() =>
      api("get", "/api/plugin").data.some(
        (entry) => entry.id === "opencode-sandbox" && entry.state.status === "active",
      ),
    )
    for (const [shell, allowed] of [
      ["cat public.txt", true],
      ["cat .env", false],
      ["printf overwritten > .env", false],
    ]) {
      const created = api("post", "/api/shell", {
        command: shell,
        cwd: fixture,
        timeout: 10000,
      }).data
      const info = wait(() => {
        const state = api("get", `/api/shell/${created.id}`).data
        return state.status !== "running" && state
      })
      const output = api("get", `/api/shell/${created.id}/output`).data.output
      if (info.status !== "exited" || (info.exit === 0) !== allowed || output.includes(marker)) {
        throw new Error("Installed sandbox verification failed (output withheld)")
      }
      if (allowed && !output.includes("sandbox-public-control"))
        throw new Error("Control command did not run")
      if (!allowed && !/permission denied|operation not permitted|EPERM/i.test(output)) {
        throw new Error("Denied command did not report a filesystem permission error")
      }
    }
    if (fs.readFileSync(path.join(fixture, ".env"), "utf8") !== `TEST_SECRET=${marker}\n`) {
      throw new Error("Dummy dotenv file was modified")
    }
  } finally {
    try {
      api("delete", "/api/debug/location")
    } finally {
      fs.rmSync(fixture, { recursive: true, force: true })
    }
  }
}

function matches(entry) {
  const current = read(entry.file).bytes
  return (current === null ? null : digest(current)) === entry.installedHash
}

function restore(manifest) {
  // Check every file before restoring any: never discard subsequent user edits.
  for (const entry of manifest.entries) {
    if (!matches(entry))
      throw new Error(`Configuration changed since setup; refusing to overwrite ${entry.file}`)
  }
  for (const entry of [...manifest.entries].reverse()) {
    if (entry.before === null) fs.rmSync(entry.file, { force: true })
    else atomicWrite(entry.file, Buffer.from(entry.before, "base64"), entry.mode)
  }
}

export function setup({
  revision = REVISION,
  yolo = false,
  uninstall = false,
  env = process.env,
  run = command,
  verify = verifyProtection,
  home = os.homedir(),
} = {}) {
  if (!/^[a-f0-9]{40}$/.test(revision))
    throw new Error("This installer must be built for a pinned Git revision")
  const configRoot = env.XDG_CONFIG_HOME || path.join(home, ".config")
  const configDir = path.join(configRoot, "opencode")
  const stateDir = path.join(
    env.XDG_STATE_HOME || path.join(home, ".local", "state"),
    "opencode-sandbox-setup",
  )
  const files = [
    path.join(configDir, "opencode.json"),
    path.join(configDir, "opencode.jsonc"),
    path.join(configRoot, "opencode-sandbox", "config.json"),
  ]
  const stateFile = path.join(stateDir, "last.json")
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 })
  const lock = path.join(configDir, ".sandbox-setup.lock")
  const fd = fs.openSync(lock, "wx", 0o600)
  try {
    const previousBytes = read(stateFile).bytes
    const previous = previousBytes && JSON.parse(previousBytes.toString("utf8"))
    if (uninstall) {
      if (!previous || previous.status !== "complete")
        throw new Error("No completed setup to roll back")
      if (
        !Array.isArray(previous.entries) ||
        previous.entries.length !== files.length ||
        new Set(previous.entries.map((entry) => entry.file)).size !== files.length ||
        previous.entries.some(
          (entry) =>
            !files.includes(entry.file) ||
            !Number.isInteger(entry.mode) ||
            entry.mode < 0 ||
            entry.mode > 0o777 ||
            !(
              entry.before === null ||
              (typeof entry.before === "string" &&
                Buffer.from(entry.before, "base64").toString("base64") === entry.before)
            ) ||
            !(entry.installedHash === null || /^[a-f0-9]{64}$/.test(entry.installedHash)),
        )
      )
        throw new Error("Invalid backup or another configuration directory")
      restore(previous)
      previous.status = "restored"
      atomicWrite(stateFile, JSON.stringify(previous, null, 2))
      run(["reload"])
      return "Previous configuration restored. Downloaded package caches were left intact."
    }
    if (
      previous?.status === "complete" &&
      previous.revision === revision &&
      previous.yolo === yolo &&
      previous.entries.every(matches)
    ) {
      verify(run)
      return "Already installed; protection verified. Original rollback backup retained."
    }
    const snapshots = files.map(read)
    for (const snapshot of snapshots) document(snapshot.bytes, snapshot.file)
    const selected =
      snapshots[1].bytes !== null ? files[1] : snapshots[0].bytes !== null ? files[0] : files[1]
    permissionConfig(read(selected).bytes, yolo, selected)
    const sandbox = sandboxConfig(snapshots[2].bytes, yolo, home, files[2])
    const manifest = {
      revision,
      yolo,
      status: "pending",
      entries: snapshots.map((entry) => ({
        file: entry.file,
        mode: entry.mode,
        before: entry.bytes?.toString("base64") ?? null,
        installedHash: entry.bytes === null ? null : digest(entry.bytes),
      })),
    }
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const backup = path.join(stateDir, `backup-${Date.now()}-${randomUUID()}.json`)
    const save = () => {
      atomicWrite(backup, JSON.stringify(manifest, null, 2))
      atomicWrite(stateFile, JSON.stringify(manifest, null, 2))
    }
    const record = () => {
      for (const entry of manifest.entries) {
        const bytes = read(entry.file).bytes
        entry.installedHash = bytes === null ? null : digest(bytes)
      }
      save()
    }
    save()
    let stage = "native plugin installation"
    try {
      try {
        run(["plugin", "add", `${REPOSITORY}#${revision}`])
      } finally {
        record()
      }
      stage = "configuration update"
      // The native command may choose either existing config filename.
      const active = read(files[1]).bytes !== null ? files[1] : files[0]
      atomicWrite(active, permissionConfig(read(active).bytes, yolo, active), read(active).mode)
      record()
      atomicWrite(files[2], sandbox, snapshots[2].mode)
      record()
      stage = "configuration reload"
      run(["reload"])
      stage = "protection verification"
      verify(run)
      manifest.status = "complete"
      save()
      return `Installed pinned revision ${revision}; protection verified. Backup: ${backup}`
    } catch (error) {
      restore(manifest)
      manifest.status = "restored"
      save()
      try {
        run(["reload"])
      } catch {
        /* Original failure remains the reason setup failed. */
      }
      throw new Error(
        `Setup failed during ${stage}; previous configuration restored. Backup: ${backup}`,
        { cause: error },
      )
    }
  } finally {
    fs.closeSync(fd)
    fs.unlinkSync(lock)
  }
}

if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const { values } = parseArgs({
      options: {
        "yolo-except-env": { type: "boolean" },
        uninstall: { type: "boolean" },
        help: { type: "boolean" },
      },
    })
    if (values.help) {
      console.log(
        "Usage: sh install.sh [--yolo-except-env | --uninstall]\nDefault: install sandbox and dotenv denials without adding an allow-all rule.\nYOLO: allow routine tools and home/temp writes; preserve explicit restrictions.\nUninstall: restore pre-install configuration, refusing subsequent edits.\nRun in a trusted terminal, not inside the sandbox. macOS only; Node 20.11+ required.",
      )
    } else {
      if (process.platform !== "darwin") throw new Error("This setup profile is macOS-only")
      const [major, minor] = process.versions.node.split(".").map(Number)
      if (major < 20 || (major === 20 && minor < 11)) throw new Error("Node 20.11+ is required")
      if (values.uninstall && values["yolo-except-env"])
        throw new Error("Choose install or uninstall, not both")
      if (!/^opencode v2\./.test(command(["--version"]).trim()))
        throw new Error("OpenCode V2 is required")
      console.log(setup({ yolo: values["yolo-except-env"], uninstall: values.uninstall }))
    }
  } catch (error) {
    // Native command errors may contain sensitive configuration or tool output.
    console.error(
      error instanceof Error && !error.stderr
        ? error.message
        : "Setup command failed (output withheld)",
    )
    process.exitCode = 1
  }
}
