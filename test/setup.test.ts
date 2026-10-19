import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parse } from "jsonc-parser"
import { permissionConfig, sandboxConfig, setup, verifyProtection } from "../scripts/setup.mjs"

const roots: string[] = []
const revision = "1234567890abcdef1234567890abcdef12345678"

test("native Git package ships built files without triggering npm preparation", () => {
  const manifest = JSON.parse(fs.readFileSync("package.json", "utf8"))
  for (const script of ["postinstall", "build", "preinstall", "install", "prepack", "prepare"]) {
    expect(manifest.scripts[script]).toBeUndefined()
  }
  expect(manifest.files).toContain("dist")
})
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-setup-test-"))
  roots.push(home)
  const env = {
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_STATE_HOME: path.join(home, "state"),
  }
  const file = path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc")
  const policy = path.join(env.XDG_CONFIG_HOME, "opencode-sandbox", "config.json")
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const original =
    '// Keep this comment\n{ "model": "original/model", "plugins": ["other-plugin"], "permissions": [{ "action":"shell", "resource":"git push *", "effect":"deny" }], }\n'
  fs.writeFileSync(file, original, { mode: 0o640 })
  const calls: string[][] = []
  const run = (args: string[]) => {
    calls.push(args)
    if (args[0] === "plugin") {
      // Stand in only for the native install, which owns package fetching.
      const current = parse(fs.readFileSync(file, "utf8"))
      current.plugins.push(args[2])
      fs.writeFileSync(file, `// Keep this comment\n${JSON.stringify(current, null, 2)}\n`)
    }
    return ""
  }
  return { home, env, file, policy, original, calls, run, revision, verify: () => {} }
}

describe("setup policy", () => {
  test("default setup never adds allow-all and keeps comments and unrelated settings", () => {
    const input = Buffer.from('// comment\n{"model":"mine", "permissions":[],}\n')
    const output = permissionConfig(input, false).toString()
    expect(output).toContain("// comment")
    expect(parse(output).model).toBe("mine")
    expect(parse(output).permissions).toHaveLength(4)
    expect(parse(output).permissions.every((rule: any) => rule.effect === "deny")).toBe(true)
  })

  test("opt-in prepends allow-all, preserving existing explicit restrictions", () => {
    const input = Buffer.from(
      '{"permissions":[{"action":"shell","resource":"git push *","effect":"deny"}]}',
    )
    const rules = parse(permissionConfig(input, true).toString()).permissions
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
    expect(rules[1].effect).toBe("deny")
    expect(rules.at(-1)).toEqual({ action: "edit", resource: "*.env.*", effect: "deny" })
  })

  test("dotenv denials follow existing broad allows and remain idempotent", () => {
    const input = Buffer.from(
      '{"permissions":[{"action":"read","resource":"*.env","effect":"deny"},{"action":"*","resource":"*","effect":"allow"}]}',
    )
    const once = permissionConfig(input, true)
    expect(permissionConfig(once, true)).toEqual(once)
    expect(parse(once.toString()).permissions.at(-4).effect).toBe("deny")
  })

  test("rejects malformed, legacy, duplicate and non-array permissions", () => {
    for (const input of [
      "broken{",
      "[]",
      '{"permissions":[],"permissions":[]}',
      '{"permission":"allow"}',
      '{"permissions":"allow"}',
    ]) {
      expect(() => permissionConfig(Buffer.from(input), true)).toThrow()
    }
  })

  test("sandbox merge preserves restrictions and only broadens writes with consent", () => {
    const original = Buffer.from(
      '{"filesystem":{"denyRead":["~/.ssh"],"denyWrite":["private"],"allowWrite":["project"]},"network":{"allowedDomains":["example.com"]},"custom":42}',
    )
    const safe = parse(sandboxConfig(original, false, "/home/test").toString())
    expect(safe.filesystem.denyRead).toEqual(["~/.ssh", "/**/.env", "/**/.env.*"])
    expect(safe.filesystem.allowWrite).toEqual(["project"])
    expect(safe.network).toEqual({ allowedDomains: ["example.com"] })
    expect(safe.custom).toBe(42)
    const yolo = parse(sandboxConfig(original, true, "/home/test").toString())
    expect(yolo.filesystem.allowWrite).toContain("/home/test")
    expect(yolo.network.allowLocalBinding).toBe(true)
    expect(yolo.network.allowedDomains).toEqual(["example.com"])
  })

  test("missing deny arrays retain the runtime credential defaults", () => {
    const value = parse(sandboxConfig(null, true, "/home/test").toString())
    expect(value.filesystem.denyRead).toBeUndefined()
    expect(value.filesystem.denyWrite).toBeUndefined()
  })
})

describe("setup transaction", () => {
  test("native install is pinned; backups restore exact bytes, file mode and absence", () => {
    const f = fixture()
    expect(setup({ ...f, yolo: true })).toContain("protection verified")
    expect(f.calls[0]).toEqual([
      "plugin",
      "add",
      `github:guillermoap/opencode-sandbox-plugin#${revision}`,
    ])
    expect(parse(fs.readFileSync(f.file, "utf8")).model).toBe("original/model")
    expect(fs.statSync(f.file).mode & 0o777).toBe(0o640)
    expect(fs.existsSync(f.policy)).toBe(true)
    expect(setup({ ...f, uninstall: true })).toContain("restored")
    expect(fs.readFileSync(f.file, "utf8")).toBe(f.original)
    expect(fs.existsSync(f.policy)).toBe(false)
    const backup = path.join(f.env.XDG_STATE_HOME, "opencode-sandbox-setup", "last.json")
    expect(fs.statSync(backup).mode & 0o777).toBe(0o600)
  })

  test("failed verification rolls back every managed file", () => {
    const f = fixture()
    expect(() =>
      setup({
        ...f,
        yolo: true,
        verify: () => {
          throw new Error("dummy failure")
        },
      }),
    ).toThrow("previous configuration restored")
    expect(fs.readFileSync(f.file, "utf8")).toBe(f.original)
    expect(fs.existsSync(f.policy)).toBe(false)
  })

  test("automatic rollback also refuses a concurrent user edit", () => {
    const f = fixture()
    expect(() =>
      setup({
        ...f,
        verify: () => {
          fs.appendFileSync(f.file, "\n// concurrent edit\n")
          throw new Error("verification failed")
        },
      }),
    ).toThrow("refusing to overwrite")
    expect(fs.readFileSync(f.file, "utf8")).toContain("concurrent edit")
  })

  test("native install failures after config changes also roll back", () => {
    const f = fixture()
    const run = (args: string[]) => {
      f.run(args)
      if (args[0] === "plugin") throw new Error("download failed")
      return ""
    }
    expect(() => setup({ ...f, run })).toThrow("previous configuration restored")
    expect(fs.readFileSync(f.file, "utf8")).toBe(f.original)
  })

  test("a fresh install restores previously absent configuration files", () => {
    const f = fixture()
    fs.unlinkSync(f.file)
    const run = (args: string[]) => {
      if (args[0] === "plugin") fs.writeFileSync(f.file, JSON.stringify({ plugins: [args[2]] }))
      return ""
    }
    setup({ ...f, run })
    setup({ ...f, run, uninstall: true })
    expect(fs.existsSync(f.file)).toBe(false)
    expect(fs.existsSync(f.policy)).toBe(false)
  })

  test("idempotent reinstall retains original rollback point", () => {
    const f = fixture()
    setup(f)
    const first = fs.readFileSync(f.file)
    expect(setup(f)).toContain("Already installed")
    expect(f.calls.filter((args) => args[0] === "plugin")).toHaveLength(1)
    expect(fs.readFileSync(f.file)).toEqual(first)
    setup({ ...f, uninstall: true })
    expect(fs.readFileSync(f.file, "utf8")).toBe(f.original)
  })

  test("rollback refuses subsequent edits and restores nothing partially", () => {
    const f = fixture()
    setup(f)
    const installedPolicy = fs.readFileSync(f.policy)
    fs.appendFileSync(f.file, "\n// user's later edit\n")
    expect(() => setup({ ...f, uninstall: true })).toThrow("refusing to overwrite")
    expect(fs.readFileSync(f.file, "utf8")).toContain("user's later edit")
    expect(fs.readFileSync(f.policy)).toEqual(installedPolicy)
  })

  test("invalid config is rejected before native installation", () => {
    const f = fixture()
    fs.writeFileSync(f.file, "broken{")
    expect(() => setup(f)).toThrow("Invalid JSON")
    expect(f.calls).toHaveLength(0)
    expect(fs.readFileSync(f.file, "utf8")).toBe("broken{")
  })

  test("symlinked config and concurrent setup are refused", () => {
    const f = fixture()
    fs.renameSync(f.file, `${f.file}.target`)
    fs.symlinkSync(`${f.file}.target`, f.file)
    expect(() => setup(f)).toThrow("Not a regular file")
    fs.unlinkSync(f.file)
    fs.renameSync(`${f.file}.target`, f.file)
    const lock = path.join(path.dirname(f.file), ".sandbox-setup.lock")
    fs.writeFileSync(lock, "locked")
    expect(() => setup(f)).toThrow()
    expect(fs.readFileSync(lock, "utf8")).toBe("locked")
    expect(f.calls).toHaveLength(0)
  })
})

test("download bootstrap refuses a changed payload before executing Node", () => {
  const f = fixture()
  const bin = path.join(f.home, "bin")
  fs.mkdirSync(bin)
  const payload = path.join(f.home, "tampered.mjs")
  const executed = path.join(f.home, "node-executed")
  fs.writeFileSync(payload, "not the reviewed payload")
  const commands = {
    uname: "printf Darwin",
    node: `touch '${executed}'`,
    opencode: "exit 0",
    curl: `for arg do last=$arg; done; /bin/cp '${payload}' "$last"`,
    shasum: `printf '%s  payload\\n' '${"0".repeat(64)}'`,
  }
  for (const [name, source] of Object.entries(commands)) {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${source}\n`, { mode: 0o755 })
  }
  const installer = path.join(f.home, "install.sh")
  const source = fs
    .readFileSync("scripts/install.sh", "utf8")
    .replaceAll("__OPENCODE_SANDBOX_TAG__", "v0.6.1-v2.1")
    .replaceAll("__OPENCODE_SANDBOX_REVISION__", revision)
    .replaceAll("__OPENCODE_SANDBOX_SHA256__", "1".repeat(64))
  fs.writeFileSync(installer, source)
  try {
    execFileSync("/bin/sh", [installer], {
      env: { ...process.env, PATH: `${bin}:/usr/bin:/bin`, TMPDIR: f.home },
      stdio: "pipe",
    })
    throw new Error("Changed payload should not execute")
  } catch (error: any) {
    expect(error.status).toBe(1)
    expect(error.stderr.toString()).toContain("checksum mismatch")
  }
  expect(fs.existsSync(executed)).toBe(false)
})

test("verification requires real permission errors and evicts its temporary location", () => {
  const routes: string[] = []
  const commands = new Map<string, string>()
  let id = 0
  const run = (args: string[]) => {
    const route = args[2].split("?")[0]
    routes.push(`${args[1]} ${route}`)
    if (route === "/api/plugin")
      return JSON.stringify({ data: [{ id: "opencode-sandbox", state: { status: "active" } }] })
    if (args[1] === "delete") return ""
    if (route === "/api/shell") {
      const command = JSON.parse(args[4]).command
      const next = String(++id)
      commands.set(next, command)
      return JSON.stringify({ data: { id: next } })
    }
    const command = commands.get(route.split("/")[3]) ?? ""
    const allowed = command === "cat public.txt"
    if (route.endsWith("/output"))
      return JSON.stringify({
        data: { output: allowed ? "sandbox-public-control" : "Operation not permitted" },
      })
    return JSON.stringify({ data: { status: "exited", exit: allowed ? 0 : 1 } })
  }
  verifyProtection(run)
  expect(routes.at(-1)).toBe("delete /api/debug/location")
  const wrong = (args: string[]) => {
    const output = run(args)
    return args[2].includes("/output")
      ? output.replace("Operation not permitted", "syntax error")
      : output
  }
  expect(() => verifyProtection(wrong)).toThrow("filesystem permission error")
})
