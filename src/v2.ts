import { execFileSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime"
import { Plugin } from "@opencode/plugin"
import { getConfigDir, loadConfig, resolveConfig } from "./config"

function quote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export default Plugin.define({
  id: "opencode-sandbox",
  async setup(ctx) {
    if (["1", "true"].includes(process.env.OPENCODE_DISABLE_SANDBOX ?? "")) return

    // Keep failures inside the shell hook: a failed plugin setup would leave
    // OpenCode running without a registered guard.
    const configuration = loadConfig(ctx.location.directory, true).catch(() => null)
    let launcher: { node: string; cli: string } | undefined

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
          launcher = { node, cli }
        }
        config.filesystem.denyWrite.push(
          path.dirname(launcher.node),
          path.dirname(path.dirname(launcher.cli)),
        )

        // Use the runtime's own CLI lifecycle in a fresh process per command.
        // Its singleton manager must not mix concurrent locations' policies.
        // A quoted heredoc supplies immutable per-invocation settings without
        // creating a writable settings file in the project or temporary dir.
        const command = `${quote(event.shell)} -c ${quote(event.command)}`
        event.command = [
          `exec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH ${quote(launcher.node)} ${quote(launcher.cli)} --settings /dev/fd/3 -c ${quote(command)} 3<<'OPENCODE_SANDBOX_SETTINGS'`,
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
