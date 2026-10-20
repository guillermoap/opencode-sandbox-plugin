// src/index.ts
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";

// src/config.ts
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  FilesystemConfigSchema,
  NetworkConfigSchema
} from "@anthropic-ai/sandbox-runtime";
var DEFAULT_DENY_READ_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws/credentials",
  ".azure",
  ".config/gcloud",
  ".config/gh",
  ".kube",
  ".docker/config.json",
  ".npmrc",
  ".netrc",
  ".env"
];
var DEFAULT_ALLOWED_DOMAINS = [
  "registry.npmjs.org",
  "*.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "crates.io",
  "*.crates.io",
  "github.com",
  "*.github.com",
  "gitlab.com",
  "*.gitlab.com",
  "bitbucket.org",
  "*.bitbucket.org",
  "api.openai.com",
  "api.anthropic.com",
  "generativelanguage.googleapis.com",
  "*.googleapis.com"
];
var UNSAFE_WRITE_PATHS = new Set([
  "/",
  "/home",
  "/usr",
  "/etc",
  "/var",
  "/opt",
  "/Library",
  "/System",
  "/private",
  "/Volumes",
  "/Users"
]);
function isSafeWritePath(p) {
  const normalized = path.resolve(p);
  if (UNSAFE_WRITE_PATHS.has(normalized)) {
    console.warn(`[opencode-sandbox] Rejecting unsafe write path: ${normalized}`);
    return false;
  }
  return true;
}
function resolveConfig(projectDir, worktree, user) {
  const homeDir = os.homedir();
  const candidatePaths = [projectDir, worktree, os.tmpdir()].filter(Boolean);
  const safePaths = candidatePaths.filter((p) => isSafeWritePath(p));
  const seen = new Set;
  const writePaths = user?.filesystem?.allowWrite ?? safePaths.filter((p) => {
    const resolved = path.resolve(p);
    if (seen.has(resolved))
      return false;
    seen.add(resolved);
    return true;
  });
  return {
    filesystem: {
      denyRead: user?.filesystem?.denyRead ?? DEFAULT_DENY_READ_DIRS.map((p) => path.join(homeDir, p)),
      allowRead: user?.filesystem?.allowRead ?? [],
      allowWrite: writePaths,
      denyWrite: user?.filesystem?.denyWrite ?? []
    },
    network: {
      allowedDomains: user?.network?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: user?.network?.deniedDomains ?? [],
      allowUnixSockets: user?.network?.allowUnixSockets,
      allowAllUnixSockets: user?.network?.allowAllUnixSockets,
      allowLocalBinding: user?.network?.allowLocalBinding ?? false
    }
  };
}
function getConfigDir() {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(xdgConfig, "opencode-sandbox");
}
function parseConfig(content, strict) {
  const value = JSON.parse(content);
  if (strict) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Sandbox configuration must be an object");
    }
    if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
      throw new Error("Sandbox disabled must be a boolean");
    }
    if (value.mode !== undefined && !["enforce", "permissive"].includes(value.mode)) {
      throw new Error("Invalid sandbox mode");
    }
    if (value.githubCLI !== undefined && typeof value.githubCLI !== "boolean") {
      throw new Error("githubCLI must be a boolean");
    }
    if (value.filesystem !== undefined)
      FilesystemConfigSchema.partial().parse(value.filesystem);
    if (value.network !== undefined)
      NetworkConfigSchema.partial().parse(value.network);
  }
  return value;
}
async function tryLoadJsonFile(filePath, strict) {
  try {
    const content = await fs.readFile(filePath, "utf-8");
    return parseConfig(content, strict);
  } catch (error) {
    if (strict && error.code !== "ENOENT")
      throw error;
    return null;
  }
}
async function loadConfig(projectDir, strict = false) {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG;
  if (envConfig) {
    try {
      return parseConfig(envConfig, strict);
    } catch (error) {
      if (strict)
        throw error;
      console.warn("[opencode-sandbox] Invalid JSON in OPENCODE_SANDBOX_CONFIG, using defaults");
    }
  }
  const configDir = getConfigDir();
  const projectName = path.basename(projectDir);
  const projectConfig = await tryLoadJsonFile(path.join(configDir, "projects", `${projectName}.json`), strict);
  if (projectConfig)
    return projectConfig;
  const globalConfig = await tryLoadJsonFile(path.join(configDir, "config.json"), strict);
  if (globalConfig)
    return globalConfig;
  return {};
}

// src/v2.ts
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import os2 from "node:os";
import path2 from "node:path";
import { SandboxRuntimeConfigSchema } from "@anthropic-ai/sandbox-runtime";
import { Plugin } from "@opencode/plugin";
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
var SAFE_ENV_NAMES = new Set([
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
  "XDG_STATE_HOME"
]);
function needsPublicationApproval(command) {
  const words = (command.match(/"(?:[^"\\]|\\.)*"|'[^']*'|[^\s]+/g) ?? []).map((word) => word.replace(/^(['"])(.*)\1$/, "$2"));
  if (path2.basename(words[0] ?? "") !== "gh")
    return false;
  return words.some((word, index) => word === "pr" && words[index + 1] === "create" || word === "release" && ["create", "upload", "edit", "delete", "delete-asset"].includes(words[index + 1]));
}
var v2_default = Plugin.define({
  id: "opencode-sandbox",
  async setup(ctx) {
    if (["1", "true"].includes(process.env.OPENCODE_DISABLE_SANDBOX ?? ""))
      return;
    const configuration = loadConfig(ctx.location.directory, true).catch(() => null);
    let launcher;
    await ctx.permission.hook("evaluate", async (event) => {
      if ((await configuration)?.disabled)
        return;
      if (event.action === "shell" && event.effect !== "deny" && event.resources.some(needsPublicationApproval)) {
        event.effect = "ask";
        event.message = "Confirm before creating pull requests or modifying GitHub releases.";
      }
    });
    await ctx.shell.hook("create.before", async (event) => {
      const user = await configuration;
      if (!user)
        throw new Error("[opencode-sandbox] Invalid configuration; command blocked");
      if (user.disabled)
        return;
      if (process.platform !== "darwin" && process.platform !== "linux") {
        throw new Error("[opencode-sandbox] Unsupported platform; command blocked");
      }
      try {
        const config = SandboxRuntimeConfigSchema.parse(resolveConfig(ctx.location.directory, ctx.location.project.directory, user));
        if (process.platform === "darwin") {
          for (const pattern of ["/**/.env", "/**/.env.*"]) {
            if (!config.filesystem.denyRead.includes(pattern))
              config.filesystem.denyRead.push(pattern);
            if (!config.filesystem.denyWrite.includes(pattern))
              config.filesystem.denyWrite.push(pattern);
          }
        }
        const sshDirectory = path2.join(os2.homedir(), ".ssh");
        const githubDirectory = process.env.GH_CONFIG_DIR || path2.join(process.env.XDG_CONFIG_HOME || path2.join(os2.homedir(), ".config"), "gh");
        config.filesystem.denyRead.push(sshDirectory, githubDirectory);
        config.filesystem.denyWrite.push(sshDirectory, githubDirectory);
        let knownHosts = "/dev/null";
        const publicHosts = path2.join(sshDirectory, "known_hosts");
        try {
          if (lstatSync(publicHosts).isFile()) {
            knownHosts = realpathSync(publicHosts);
            config.filesystem.allowRead ??= [];
            config.filesystem.allowRead.push(knownHosts);
          }
        } catch {}
        let agent;
        if (process.env.SSH_AUTH_SOCK) {
          try {
            const original = process.env.SSH_AUTH_SOCK;
            const target = lstatSync(original).isSymbolicLink() ? path2.resolve(path2.dirname(original), readlinkSync(original)) : original;
            const socket = path2.join(realpathSync(path2.dirname(target)), path2.basename(target));
            if (statSync(socket).isSocket()) {
              agent = socket;
              config.network.allowUnixSockets ??= [];
              config.network.allowUnixSockets.push(socket);
            }
          } catch {}
        }
        const require2 = createRequire(import.meta.url);
        const packageRoot = path2.dirname(require2.resolve("../package.json"));
        config.filesystem.denyWrite.push(packageRoot, getConfigDir(), path2.join(path2.dirname(getConfigDir()), "opencode"));
        if (!launcher) {
          const node = execFileSync("node", ["-p", "process.execPath"], {
            encoding: "utf8",
            env: { ...process.env, NODE_OPTIONS: undefined, NODE_PATH: undefined }
          }).trim();
          const cli = path2.join(path2.dirname(require2.resolve("@anthropic-ai/sandbox-runtime")), "cli.js");
          accessSync(node, constants.X_OK);
          accessSync(cli, constants.R_OK);
          const sshProxy = path2.join(packageRoot, "scripts", "ssh-http-proxy.mjs");
          accessSync(sshProxy, constants.R_OK);
          const githubBridge = path2.join(packageRoot, "scripts", "github-http-bridge.mjs");
          accessSync(githubBridge, constants.R_OK);
          let gh;
          if (user.githubCLI) {
            try {
              gh = realpathSync(execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim());
            } catch {}
          }
          launcher = { node, cli, sshProxy, githubBridge, gh };
        }
        config.filesystem.denyWrite.push(path2.dirname(launcher.node), path2.dirname(path2.dirname(launcher.cli)));
        let githubEnvironment = "";
        let githubSocket;
        if (user.githubCLI) {
          let token;
          if (launcher.gh) {
            config.filesystem.denyWrite.push(path2.dirname(launcher.gh));
            try {
              token = execFileSync(launcher.gh, ["auth", "token", "--hostname", "github.com"], {
                encoding: "utf8",
                timeout: 1e4,
                stdio: ["ignore", "pipe", "ignore"],
                env: {
                  ...process.env,
                  GH_TOKEN: undefined,
                  GITHUB_TOKEN: undefined,
                  GH_HOST: "github.com"
                }
              }).trim() || undefined;
            } catch {}
          }
          event.env.GH_TOKEN = token;
          event.env.GITHUB_TOKEN = undefined;
          event.env.GH_ENTERPRISE_TOKEN = undefined;
          event.env.GITHUB_ENTERPRISE_TOKEN = undefined;
          event.env.GH_HOST = "github.com";
          event.env.GH_CONFIG_DIR = path2.join(os2.tmpdir(), `oc-gh-${randomUUID()}`);
          githubEnvironment = "-u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN ";
          if (token) {
            config.credentials = {
              envVars: [
                {
                  name: "GH_TOKEN",
                  mode: "mask",
                  injectHosts: ["api.github.com", "uploads.github.com"]
                },
                { name: "GITHUB_TOKEN", mode: "deny" }
              ]
            };
            config.network.tlsTerminate = { excludeDomains: ["github.com", "ssh.github.com"] };
            githubSocket = path2.join(realpathSync(os2.tmpdir()), `oc-gh-${randomUUID().slice(0, 8)}.sock`);
            config.network.allowUnixSockets ??= [];
            config.network.allowUnixSockets.push(githubSocket);
            config.filesystem.allowWrite.push(event.env.GH_CONFIG_DIR, githubSocket);
            const caKey = process.platform === "darwin" ? "/**/srt-ca-*/ca.key" : path2.join(os2.tmpdir(), "srt-ca-*", "ca.key");
            config.filesystem.denyRead.push(caKey);
            config.filesystem.denyWrite.push(caKey);
          }
        }
        const githubNames = user.githubCLI ? new Set(["GH_TOKEN", "GH_CONFIG_DIR", "GH_HOST"]) : new Set;
        for (const name of Object.keys({ ...process.env, ...event.env })) {
          if (!SAFE_ENV_NAMES.has(name) && !githubNames.has(name))
            event.env[name] = undefined;
        }
        const proxy = `${quote(launcher.node)} ${quote(launcher.sshProxy)} %h %p`;
        const ssh = `ssh -F /dev/null -o BatchMode=yes -o StrictHostKeyChecking=yes -o ControlMaster=no -o ControlPath=none -o UserKnownHostsFile=${quote(knownHosts)} -o IdentityAgent=${quote(agent ?? "none")} -o ProxyCommand=${quote(proxy)}`;
        const script = `export GIT_SSH_COMMAND=${quote(ssh)}
${event.command}`;
        const command = githubSocket ? `${quote(launcher.node)} ${quote(launcher.githubBridge)} ${quote(githubSocket)} ${quote(event.shell)} ${quote(script)}` : `${quote(event.shell)} -c ${quote(script)}`;
        event.command = [
          `exec /usr/bin/env -u NODE_OPTIONS -u NODE_PATH ${githubEnvironment}${agent ? `${quote(`SSH_AUTH_SOCK=${agent}`)} ` : "-u SSH_AUTH_SOCK "}${quote(launcher.node)} ${quote(launcher.cli)} --settings /dev/fd/3 -c ${quote(command)} 3<<'OPENCODE_SANDBOX_SETTINGS'`,
          JSON.stringify(config),
          "OPENCODE_SANDBOX_SETTINGS"
        ].join(`
`);
      } catch {
        throw new Error("[opencode-sandbox] Sandbox unavailable or invalid configuration; command blocked");
      }
    });
  }
});

// src/index.ts
var PERSISTENCE_WARNING = "Failed to restore original command in tool history";
var ENFORCEMENT_ERROR = "Sandbox unavailable in enforce mode; command blocked";
var SandboxPlugin = async ({ client, directory, worktree, serverUrl }) => {
  const log = (level, message) => client.app.log({ body: { service: "opencode-sandbox", level, message } }).catch(() => {
    return;
  });
  if (process.env.OPENCODE_DISABLE_SANDBOX === "1" || process.env.OPENCODE_DISABLE_SANDBOX === "true") {
    return {};
  }
  const userConfig = await loadConfig(directory);
  if (userConfig.disabled)
    return {};
  const enforce = userConfig.mode === "enforce";
  if (process.platform === "win32") {
    log(enforce ? "error" : "warn", enforce ? "Windows sandboxing is not available through OpenCode's command-string hook; bash commands will be blocked" : "Windows sandboxing is not available through OpenCode's command-string hook; commands will run without sandbox");
    if (!enforce)
      return {};
    return {
      "tool.execute.before": async (input) => {
        if (input.tool === "bash")
          throw new Error(ENFORCEMENT_ERROR);
      }
    };
  }
  const runtimeConfig = resolveConfig(directory, worktree, userConfig);
  let initialization;
  const ensureSandboxReady = () => initialization ??= SandboxManager.initialize(runtimeConfig).then(() => {
    log("debug", `Initialized — writes allowed in: ${runtimeConfig.filesystem?.allowWrite?.join(", ")}`);
    return true;
  }).catch((err) => {
    log("error", `Failed to initialize; ${enforce ? "commands will be blocked" : "commands will run without sandbox"}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  });
  const hasDefinedError = (result) => typeof result === "object" && result !== null && ("error" in result) && result.error !== undefined;
  const inFlight = new Map;
  const scrubToolPartInput = async (part) => {
    const pending = inFlight.get(part.callID);
    if (pending === undefined)
      return;
    if (part.tool !== undefined && part.tool !== "bash")
      return;
    const input = part.state?.input;
    if (input === undefined)
      return;
    const command = input.command;
    if (typeof command !== "string" || command === pending.command)
      return;
    input.command = pending.command;
    if (typeof part.id !== "string" || typeof part.sessionID !== "string" || typeof part.messageID !== "string") {
      return;
    }
    const persistenceClient = client;
    const partClient = persistenceClient.part;
    const internalClient = persistenceClient._client;
    try {
      if (typeof partClient?.update === "function") {
        const result = await partClient.update({
          sessionID: part.sessionID,
          messageID: part.messageID,
          partID: part.id,
          part
        });
        if (hasDefinedError(result)) {
          throw new Error("OpenCode public client failed to update tool history");
        }
      } else if (typeof internalClient?.patch === "function") {
        let result;
        try {
          result = await internalClient.patch({
            url: "/session/{sessionID}/message/{messageID}/part/{partID}",
            path: {
              sessionID: part.sessionID,
              messageID: part.messageID,
              partID: part.id
            },
            query: { directory },
            body: part,
            headers: { "Content-Type": "application/json" }
          });
        } catch {
          throw new Error("OpenCode client transport failed to update tool history");
        }
        if (hasDefinedError(result)) {
          throw new Error("OpenCode client transport failed to update tool history");
        }
      } else {
        const url = new URL(`/session/${encodeURIComponent(part.sessionID)}/message/${encodeURIComponent(part.messageID)}/part/${encodeURIComponent(part.id)}`, serverUrl);
        url.searchParams.set("directory", directory);
        const headers = { "content-type": "application/json" };
        const password = process.env.OPENCODE_SERVER_PASSWORD;
        if (password) {
          const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
          headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
        }
        const response = await fetch(url, {
          method: "PATCH",
          headers,
          body: JSON.stringify(part)
        });
        if (!response.ok) {
          throw new Error(`OpenCode server returned HTTP ${response.status}`);
        }
      }
    } catch {
      log("warn", PERSISTENCE_WARNING);
    }
  };
  const cleanupCommand = (pending) => {
    if (pending.cleaned)
      return;
    pending.cleaned = true;
    try {
      SandboxManager.cleanupAfterCommand();
    } catch (err) {
      log("warn", `Failed to clean up sandbox mount points: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const finishCommand = (callID) => {
    const pending = inFlight.get(callID);
    if (pending === undefined)
      return;
    inFlight.delete(callID);
    cleanupCommand(pending);
  };
  return {
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "bash")
        return;
      const command = output.args?.command;
      if (typeof command !== "string" || !command)
        return;
      if (inFlight.has(input.callID))
        return;
      if (!await ensureSandboxReady()) {
        if (enforce)
          throw new Error(ENFORCEMENT_ERROR);
        return;
      }
      try {
        output.args.command = await SandboxManager.wrapWithSandbox(command, undefined, undefined, undefined, { commandId: input.callID, commandText: command });
        inFlight.set(input.callID, {
          command,
          sessionID: input.sessionID,
          cleaned: false
        });
      } catch (err) {
        log(enforce ? "error" : "warn", `Failed to wrap command; ${enforce ? "command blocked" : "running unsandboxed"}: ${err instanceof Error ? err.message : String(err)}`);
        if (enforce)
          throw new Error(ENFORCEMENT_ERROR);
      }
    },
    "tool.execute.after": async (input, _output) => {
      if (input.tool !== "bash")
        return;
      const pending = inFlight.get(input.callID);
      if (pending === undefined)
        return;
      if (input.args && typeof input.args.command === "string") {
        input.args.command = pending.command;
      }
      cleanupCommand(pending);
    },
    event: async ({ event }) => {
      if (event.type === "message.part.updated") {
        const { part } = event.properties;
        if (part.type !== "tool")
          return;
        const persistence = scrubToolPartInput(part);
        if (part.state.status === "error" || part.state.status === "completed") {
          finishCommand(part.callID);
          await persistence;
          return;
        }
        await persistence;
        return;
      }
      if (event.type === "session.idle") {
        const { sessionID } = event.properties;
        for (const [callID, pending] of [...inFlight]) {
          if (pending.sessionID === sessionID)
            finishCommand(callID);
        }
      }
    }
  };
};
var server = SandboxPlugin;
var src_default = { ...v2_default, server: SandboxPlugin };
export {
  server,
  src_default as default,
  SandboxPlugin
};
