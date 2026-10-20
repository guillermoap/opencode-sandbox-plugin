import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime"
import { Plugin } from "@opencode/plugin"
import { getConfigDir, loadConfig, resolveConfig } from "./config"

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

const SAFE_ENV_NAMES = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "USER",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
])

function needsPublicationApproval(command: string): boolean {
  const words = (command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? []).map((word) =>
    word.replace(/^(['"])(.*)\1$/, "$2"),
  )
  if (path.basename(words[0] ?? "") !== "gh") return false
  return words.some(
    (word, index) =>
      (word === "pr" && words[index + 1] === "create") ||
      (word === "release" &&
        ["create", "upload", "edit", "delete", "delete-asset"].includes(words[index + 1])),
  )
}

export default Plugin.define({
  id: "opencode-sandbox",
  async setup(ctx) {
    if (["1", "true"].includes(process.env.OPENCODE_DISABLE_SANDBOX ?? "")) return

    // Keep failures inside the shell hook: a failed plugin setup would leave
    // OpenCode running without a registered guard.
    const configuration = loadConfig(ctx.location.directory, true).catch(() => null)
    let launcher:
      | { node: string; cli: string; sshProxy: string; githubBridge: string; gh?: string }
      | undefined

    await ctx.permission.hook("evaluate", async (event) => {
      if ((await configuration)?.disabled) return
      if (
        event.action === "shell" &&
        event.effect !== "deny" &&
        event.resources.some(needsPublicationApproval)
      ) {
        event.effect = "ask"
        event.message = "Confirm before creating pull requests or modifying GitHub releases."
      }
    })

    await ctx.shell.hook("create.before", async (event) => {
      const user = await configuration
      if (!user) throw new Error("[opencode-sandbox] Invalid configuration; command blocked")
      if (user.disabled) return
      if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error("[opencode-sandbox] Unsupported platform; command blocked")
      }

      try {
        const config = SandboxRuntimeConfigSchema.parse(
          resolveConfig(ctx.location.directory, ctx.location.project.directory, user),
        )
        // A native installation must protect dotenv files without requiring a
        // second configuration file. Keep existing credential restrictions.
        if (process.platform === "darwin") {
          for (const pattern of ["/**/.env", "/**/.env.*"]) {
            if (!config.filesystem.denyRead.includes(pattern))
              config.filesystem.denyRead.push(pattern)
            if (!config.filesystem.denyWrite.includes(pattern))
              config.filesystem.denyWrite.push(pattern)
          }
        }
        const sshDirectory = path.join(os.homedir(), ".ssh")
        const githubDirectory =
          process.env.GH_CONFIG_DIR ||
          path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "gh")
        config.filesystem.denyRead.push(sshDirectory, githubDirectory)
        config.filesystem.denyWrite.push(sshDirectory, githubDirectory)
        let knownHosts = "/dev/null"
        const publicHosts = path.join(sshDirectory, "known_hosts")
        try {
          if (lstatSync(publicHosts).isFile()) {
            knownHosts = realpathSync(publicHosts)
            config.filesystem.allowRead ??= []
            config.filesystem.allowRead.push(knownHosts)
          }
        } catch {
          /* Unknown hosts must be trusted from a normal terminal first. */
        }
        let agent: string | undefined
        if (process.env.SSH_AUTH_SOCK) {
          try {
            const original = process.env.SSH_AUTH_SOCK
            const target = lstatSync(original).isSymbolicLink()
              ? path.resolve(path.dirname(original), readlinkSync(original))
              : original
            const socket = path.join(realpathSync(path.dirname(target)), path.basename(target))
            if (statSync(socket).isSocket()) {
              agent = socket
              config.network.allowUnixSockets ??= []
              config.network.allowUnixSockets.push(socket)
            }
          } catch {
            /* An expired agent must not break unrelated shell commands. */
          }
        }
        // Protect the policy and implementation even when the location is HOME
        // or the plugin checkout itself is inside an allowed write directory.
        const require = createRequire(import.meta.url)
        const packageRoot = path.dirname(require.resolve("../package.json"))
        config.filesystem.denyWrite.push(
          packageRoot,
          getConfigDir(),
          path.join(path.dirname(getConfigDir()), "opencode"),
        )
        if (!launcher) {
          // OpenCode is a compiled executable, not a Node interpreter. Resolve
          // Node once, before agent-controlled cwd/env can affect the launcher.
          const node = execFileSync("node", ["-p", "process.execPath"], {
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined },
          }).trim()
          const cli = path.join(
            path.dirname(require.resolve("@anthropic-ai/sandbox-runtime")),
            "cli.js",
          )
          accessSync(node, constants.X_OK)
          accessSync(cli, constants.R_OK)
          const sshProxy = path.join(packageRoot, "scripts", "ssh-http-proxy.mjs")
          accessSync(sshProxy, constants.R_OK)
          const githubBridge = path.join(packageRoot, "scripts", "github-http-bridge.mjs")
          accessSync(githubBridge, constants.R_OK)
          let gh: string | undefined
          if (user.githubCLI) {
            try {
              gh = realpathSync(execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim())
            } catch {
              /* gh is optional. */
            }
          }
          launcher = { node, cli, sshProxy, githubBridge, gh }
        }
        config.filesystem.denyWrite.push(
          path.dirname(launcher.node),
          path.dirname(path.dirname(launcher.cli)),
        )

        // Use the runtime's own CLI lifecycle in a fresh process per command.
        // Its singleton manager must not mix concurrent locations' policies.
        // A quoted heredoc supplies immutable per-invocation settings without
        // creating a writable settings file in the project or temporary dir.
        let githubEnvironment = ""
        let githubSocket: string | undefined
        if (user.githubCLI) {
          let token: string | undefined
          if (launcher.gh) {
            config.filesystem.denyWrite.push(path.dirname(launcher.gh))
            try {
              token =
                execFileSync(launcher.gh, ["auth", "token", "--hostname", "github.com"], {
                  encoding: "utf8",
                  timeout: 10000,
                  stdio: ["ignore", "pipe", "ignore"],
                  env: {
                    ...process.env,
                    GH_TOKEN: undefined,
                    GITHUB_TOKEN: undefined,
                    GH_HOST: "github.com",
                  },
                }).trim() || undefined
            } catch {
              /* No login: gh reports its normal authentication error. */
            }
          }
          // The real token reaches only the trusted launcher. SRT replaces it
          // in the sandbox with a sentinel and injects it only at GitHub hosts.
          event.env.GH_TOKEN = token
          event.env.GITHUB_TOKEN = undefined
          event.env.GH_ENTERPRISE_TOKEN = undefined
          event.env.GITHUB_ENTERPRISE_TOKEN = undefined
          event.env.GH_HOST = "github.com"
          event.env.GH_CONFIG_DIR = path.join(os.tmpdir(), `oc-gh-${randomUUID()}`)
          githubEnvironment = "-u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN "
          if (token) {
            config.credentials = {
              envVars: [
                {
                  name: "GH_TOKEN",
                  mode: "mask",
                  injectHosts: ["api.github.com", "uploads.github.com"],
                },
                { name: "GITHUB_TOKEN", mode: "deny" },
              ],
            }
            config.network.tlsTerminate = { excludeDomains: ["github.com", "ssh.github.com"] }
            githubSocket = path.join(
              realpathSync(os.tmpdir()),
              `oc-gh-${randomUUID().slice(0, 8)}.sock`,
            )
            config.network.allowUnixSockets ??= []
            config.network.allowUnixSockets.push(githubSocket)
            config.filesystem.allowWrite.push(event.env.GH_CONFIG_DIR, githubSocket)
            const caKey =
              process.platform === "darwin"
                ? "/**/srt-ca-*/ca.key"
                : path.join(os.tmpdir(), "srt-ca-*", "ca.key")
            config.filesystem.denyRead.push(caKey)
            config.filesystem.denyWrite.push(caKey)
          }
        }
        // Preserve terminal/runtime context, not unrelated credentials inherited
        // by the OpenCode service. The GitHub launcher token is masked by SRT.
        const githubNames = user.githubCLI
          ? new Set(["GH_TOKEN", "GH_CONFIG_DIR", "GH_HOST"])
          : new Set<string>()
        for (const name of Object.keys({ ...process.env, ...event.env })) {
          if (!SAFE_ENV_NAMES.has(name) && !githubNames.has(name)) event.env[name] = undefined
        }
        const proxy = `${quote(launcher.node)} ${quote(launcher.sshProxy)} %h %p`
        const ssh = `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ControlMaster=no -o ControlPath=none -o UserKnownHostsFile=${quote(knownHosts)} -o IdentityAgent=${quote(agent ?? "none")} -o ProxyCommand=${quote(proxy)}`
        const script = `export GIT_SSH_COMMAND=${quote(ssh)}\n${event.command}`
        const command = githubSocket
          ? `${quote(launcher.node)} ${quote(launcher.githubBridge)} ${quote(githubSocket)} ${quote(event.shell)} ${quote(script)}`
          : `${quote(event.shell)} -c ${quote(script)}`
        event.command = [
          `exec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH ${githubEnvironment}${agent ? `${quote(`SSH_AUTH_SOCK=${agent}`)} ` : "-u SSH_AUTH_SOCK "}${quote(launcher.node)} ${quote(launcher.cli)} --settings /dev/fd/3 -c ${quote(command)} 3<<'OPENCODE_SANDBOX_SETTINGS'`,
          JSON.stringify(config),
          "OPENCODE_SANDBOX_SETTINGS",
        ].join("\n")
      } catch {
        throw new Error(
          "[opencode-sandbox] Sandbox unavailable or invalid configuration; command blocked",
        )
      }
    })
  },
})
