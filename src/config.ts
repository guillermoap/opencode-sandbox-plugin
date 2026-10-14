import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  FilesystemConfigSchema,
  NetworkConfigSchema,
  type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime"

export interface SandboxPluginConfig {
  disabled?: boolean
  mode?: "permissive" | "enforce"
  filesystem?: {
    denyRead?: string[]
    allowRead?: string[]
    allowWrite?: string[]
    denyWrite?: string[]
  }
  network?: {
    allowedDomains?: string[]
    deniedDomains?: string[]
    allowUnixSockets?: string[]
    allowAllUnixSockets?: boolean
    allowLocalBinding?: boolean
  }
}

const DEFAULT_DENY_READ_DIRS = [
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
  ".env",
]

const DEFAULT_ALLOWED_DOMAINS = [
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
  "*.googleapis.com",
]

const UNSAFE_WRITE_PATHS = new Set([
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
  "/Users",
])

function isSafeWritePath(p: string): boolean {
  const normalized = path.resolve(p)
  if (UNSAFE_WRITE_PATHS.has(normalized)) {
    console.warn(`[opencode-sandbox] Rejecting unsafe write path: ${normalized}`)
    return false
  }
  return true
}

export function resolveConfig(
  projectDir: string,
  worktree: string,
  user?: SandboxPluginConfig,
): SandboxRuntimeConfig {
  const homeDir = os.homedir()

  const candidatePaths = [projectDir, worktree, os.tmpdir()].filter(Boolean)
  const safePaths = candidatePaths.filter((p) => isSafeWritePath(p))
  const seen = new Set<string>()
  const writePaths =
    user?.filesystem?.allowWrite ??
    safePaths.filter((p) => {
      const resolved = path.resolve(p)
      if (seen.has(resolved)) return false
      seen.add(resolved)
      return true
    })

  return {
    filesystem: {
      denyRead:
        user?.filesystem?.denyRead ?? DEFAULT_DENY_READ_DIRS.map((p) => path.join(homeDir, p)),
      allowRead: user?.filesystem?.allowRead ?? [],
      allowWrite: writePaths,
      denyWrite: user?.filesystem?.denyWrite ?? [],
    },
    network: {
      allowedDomains: user?.network?.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: user?.network?.deniedDomains ?? [],
      allowUnixSockets: user?.network?.allowUnixSockets,
      allowAllUnixSockets: user?.network?.allowAllUnixSockets,
      allowLocalBinding: user?.network?.allowLocalBinding ?? false,
    },
  }
}

export function getConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdgConfig, "opencode-sandbox")
}

function parseConfig(content: string, strict: boolean): SandboxPluginConfig {
  const value = JSON.parse(content)
  if (strict) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Sandbox configuration must be an object")
    }
    if (value.disabled !== undefined && typeof value.disabled !== "boolean") {
      throw new Error("Sandbox disabled must be a boolean")
    }
    if (value.mode !== undefined && !["enforce", "permissive"].includes(value.mode)) {
      throw new Error("Invalid sandbox mode")
    }
    if (value.filesystem !== undefined) FilesystemConfigSchema.partial().parse(value.filesystem)
    if (value.network !== undefined) NetworkConfigSchema.partial().parse(value.network)
  }
  return value as SandboxPluginConfig
}

async function tryLoadJsonFile(
  filePath: string,
  strict: boolean,
): Promise<SandboxPluginConfig | null> {
  try {
    const content = await fs.readFile(filePath, "utf-8")
    return parseConfig(content, strict)
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    return null
  }
}

export async function loadConfig(projectDir: string, strict = false): Promise<SandboxPluginConfig> {
  const envConfig = process.env.OPENCODE_SANDBOX_CONFIG
  if (envConfig) {
    try {
      return parseConfig(envConfig, strict)
    } catch (error) {
      if (strict) throw error
      console.warn("[opencode-sandbox] Invalid JSON in OPENCODE_SANDBOX_CONFIG, using defaults")
    }
  }

  const configDir = getConfigDir()

  const projectName = path.basename(projectDir)
  const projectConfig = await tryLoadJsonFile(
    path.join(configDir, "projects", `${projectName}.json`),
    strict,
  )
  if (projectConfig) return projectConfig

  const globalConfig = await tryLoadJsonFile(path.join(configDir, "config.json"), strict)
  if (globalConfig) return globalConfig

  return {}
}
