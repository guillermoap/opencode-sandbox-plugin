[![CI](https://github.com/guillermoap/opencode-sandbox-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/guillermoap/opencode-sandbox-plugin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

# opencode-sandbox

An [OpenCode](https://opencode.ai) plugin that sandboxes agent-executed commands using [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime).

Every `bash` tool invocation is wrapped with OS-level filesystem and network restrictions — no containers, no VMs, just native OS sandboxing primitives.

| Platform | Mechanism |
|----------|-----------|
| **macOS** | `sandbox-exec` (Seatbelt profiles) |
| **Linux** | `bubblewrap` (namespace isolation) |
| **Windows** | Not currently supported by OpenCode's command-string hook (commands pass through in `permissive` mode and are blocked in `enforce` mode) |

## Install

### OpenCode V2 (this fork)

No manual clone, Bun installation, or build is needed. The fork ships its built
entrypoint. OpenCode V2 and **Node 20.11+** are required; tested on OpenCode **2.0.29**.

#### Native plugin installation

Run from a **trusted terminal outside OpenCode's sandbox**:

```sh
opencode plugin add github:guillermoap/opencode-sandbox-plugin#v0.6.1-v2.1
opencode reload
opencode plugin list
```

This installs the shell sandbox without changing tool permissions. On macOS, the
plugin protects `.env` and `.env.*` by default, including nested/external files
and `.env.example`. For an immutable Git pin, use the full source revision from
the release notes instead of the version tag.

#### Optional setup: YOLO except dotenv files (macOS)

The setup script installs an **exact Git revision**, adds direct-file dotenv
denials, and checks real OS protection with dummy secrets. Download and inspect
the versioned bootstrap before running it; do not pipe a remote script into `sh`.

```sh
curl --proto '=https' --tlsv1.2 -fL \
  https://github.com/guillermoap/opencode-sandbox-plugin/releases/download/v0.6.1-v2.1/install.sh \
  -o install.sh
less install.sh
sh install.sh --yolo-except-env
```

The bootstrap verifies the SHA-256 of its standalone setup payload before running
it. Both assets belong to the same versioned release; the checksum is an integrity
check, not an independent signature. No `sudo`, Bun, or manual JSON editing.

- **Without `--yolo-except-env`:** install the sandbox and dotenv file denials;
  do not add an allow-all rule or broaden filesystem/network permissions.
- **With `--yolo-except-env`:** add an allow-all fallback, permit writes throughout
  your home/temp directories, and permit local services. Existing explicit deny
  and ask rules remain effective. The upstream external-network allowlist remains.
- Existing providers, MCP servers, plugins, credential restrictions, comments,
  and unrelated config are preserved. Files are backed up before installation.
  Symlinked config files and simultaneous setup runs are refused.
- A failed installation rolls back config when it has not been modified by
  another process. Re-running the same setup is idempotent and retains the
  original rollback point.

Restore the configuration from before the latest setup:

```sh
sh install.sh --uninstall
```

Rollback refuses to overwrite subsequent edits; backups are under
`${XDG_STATE_HOME:-~/.local/state}/opencode-sandbox-setup/`. Backups contain your
original configuration and are stored privately (directory `0700`, files `0600`).
Downloaded package caches are not deleted. Native-only installations can be
removed with `opencode plugin remove <the-exact-package-specifier>`.

**Limits:** this is not a whole-machine secret sandbox. MCP servers, non-shell
tools, and inherited environment variables are outside the shell sandbox. The
setup adds direct `read`/`edit` denials, not a universal content filter. Apps that
load denied `.env` files will fail. Linux has different glob semantics; this
installer intentionally supports macOS only.

#### Developer checkout

Build a local checkout when changing the plugin:

```bash
git clone https://github.com/guillermoap/opencode-sandbox-plugin.git
cd opencode-sandbox-plugin
bun install --frozen-lockfile
bun run build:plugin
```

```jsonc
// ~/.config/opencode/opencode.jsonc (merge with existing settings)
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["/absolute/path/to/opencode-sandbox-plugin"]
}
```

Reload OpenCode configuration after installation and check that `opencode-sandbox`
appears as loaded in `opencode plugin list`.

The V2 implementation uses the **shell `create.before` hook**, not the legacy
`bash` tool hook. Each invocation runs the installed sandbox runtime CLI in its
own Node process, with a quoted, per-invocation settings stream. This isolates
concurrent projects' policies, delegates signals and resource cleanup to the
runtime, and leaves tool history untouched. Node 20.11+ must be on the server's
PATH. This adds process startup overhead to each command.

**V2 always fails closed**: malformed configuration, missing Node, unsupported
platforms, and runtime initialization/wrapping failures block the command. The
legacy `mode: "permissive"` fallback applies only to V1. Explicit disabling still
works. The plugin package and OpenCode/sandbox configuration directories are automatically
denied shell writes to prevent modification of the guard from an allowed project.

For `.env` protection on **macOS**, merge these filesystem rules into
`~/.config/opencode-sandbox/config.json`:

```json
{
  "mode": "enforce",
  "filesystem": {
    "denyRead": ["/**/.env", "/**/.env.*"],
    "denyWrite": ["/**/.env", "/**/.env.*"]
  }
}
```

These explicit rules are optional in V2: its macOS guard always adds the dotenv
denials, including when no sandbox config file exists. They remain useful for
V1 or as a visible record of your policy.

These native macOS glob rules include nested/external files and `.env.example`.
Specifying `denyRead` replaces the default credential deny list; retain any
credential paths you also want protected. Keep OpenCode's direct-file permission
denials as well: the shell sandbox does **not** sandbox other tools, MCP servers,
the OpenCode host process, or already inherited secret environment variables.
The default network allowlist still applies. Applications that need to load a
denied `.env` will fail; use a separate trusted process for those applications.

Linux uses bubblewrap and has different glob semantics: read globs match existing
paths at command startup, while write rules require literal paths. The macOS
example is **not** an equivalent Linux write policy.

Run `bun run test:smoke` on macOS for real OS-level denial checks using only dummy
secrets, including shell/Python/Node reads, writes, symlinks, renames, hardlinks,
concurrent commands, and exit-code propagation.
`bun run test:opencode` exercises the same checks through a real OpenCode V2
location and shell API, without a model call. It creates and cleans up a temporary
project and its isolated per-project sandbox policy.

Release maintainers: commit source and rebuilt `dist/`, then run
`bun run release:build` from a clean checkout. Upload the generated `install.sh`,
`setup.mjs`, and `SHA256SUMS` under the versioned GitHub release. The bootstrap
pins the current commit and payload checksum. CI rejects drift in committed builds.

### OpenCode V1 (upstream)

```json
// opencode.json
{
  "plugin": ["opencode-sandbox"]
}
```

The plugin is automatically installed from npm when OpenCode starts.

### Linux prerequisites

**1. Install bubblewrap:**

```bash
# Debian/Ubuntu
sudo apt install bubblewrap

# Fedora
sudo dnf install bubblewrap

# Arch
sudo pacman -S bubblewrap
```

**2. Ubuntu 24.04+ (AppArmor fix):**

Ubuntu 24.04 and later restrict unprivileged user namespaces via AppArmor, which prevents bubblewrap from working. You need to enable the `bwrap-userns-restrict` AppArmor profile:

```bash
# Install the AppArmor profiles package
sudo apt install apparmor-profiles

# Create the symlink to enable the profile
sudo ln -s /etc/apparmor.d/bwrap-userns-restrict /etc/apparmor.d/force-complain/bwrap-userns-restrict

# Load the profile
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

You can verify bwrap works:

```bash
bwrap --ro-bind / / --dev /dev --proc /proc -- echo "sandbox works"
```

Without this fix, bwrap will fail with `loopback: Failed RTM_NEWADDR: Operation not permitted` or `setting up uid map: Permission denied`.

## What it does

When the agent runs a bash command, the sandbox enforces three layers of protection:

### Filesystem write protection

Commands can only write to the project directory and `/tmp`. Writing anywhere else returns "Read-only file system":

```
$ touch ~/some-file
touch: cannot touch '/home/user/some-file': Read-only file system

$ echo "data" > /etc/config
/usr/bin/bash: line 1: /etc/config: Read-only file system
```

### Sensitive file read protection

Access to credential directories is blocked:

```
$ cat ~/.ssh/id_rsa
cat: /home/user/.ssh/id_rsa: Permission denied
```

### Network allowlist

Only approved domains are reachable. All other traffic is blocked via a local proxy:

```
$ curl https://evil.com
Connection blocked by network allowlist

$ curl https://registry.npmjs.org
(works — npmjs.org is in the default allowlist)
```

### Default restrictions

**Filesystem (deny-read)**:
- `~/.ssh`, `~/.gnupg`
- `~/.aws/credentials`, `~/.azure`, `~/.config/gcloud`, `~/.config/gh`
- `~/.kube`, `~/.docker/config.json`
- `~/.npmrc`, `~/.netrc`, `~/.env`

**Filesystem (allow-read)**:
- Empty by default

**Filesystem (allow-write)**:
- Project directory
- Git worktree (validated — unsafe paths like `/` are rejected)
- `/tmp`

**Network (allow-only)**:
- `registry.npmjs.org`, `*.npmjs.org`
- `registry.yarnpkg.com`
- `pypi.org`, `*.pypi.org`, `crates.io`, `*.crates.io`
- `github.com`, `*.github.com`
- `gitlab.com`, `*.gitlab.com`, `bitbucket.org`, `*.bitbucket.org`
- `api.openai.com`, `api.anthropic.com`
- `*.googleapis.com`

Everything else is **blocked by default**.

## Configuration

Config files are stored outside the project directory (in `~/.config/opencode-sandbox/`) so that sandboxed commands cannot modify them. This prevents indirect prompt injection from weakening the sandbox by overwriting the config.

### Config file locations

The plugin searches for configuration in this order (first match wins):

1. **Environment variable** `OPENCODE_SANDBOX_CONFIG` (JSON string)
2. **Per-project config** `~/.config/opencode-sandbox/projects/<project-name>.json`
3. **Global config** `~/.config/opencode-sandbox/config.json`
4. **Built-in defaults**

The `<project-name>` is the basename of the project directory (e.g., `my-app` for `/home/user/projects/my-app`).

If `XDG_CONFIG_HOME` is set, it is used instead of `~/.config`.

### Example: Global config

```json
// ~/.config/opencode-sandbox/config.json
{
  "mode": "enforce",
  "filesystem": {
    "denyRead": ["~/.ssh", "~/.aws/credentials"],
    "allowRead": ["~/.ssh/id_ed25519.pub"],
    "allowWrite": [".", "/tmp", "/var/data"],
    "denyWrite": [".env.production"]
  },
  "network": {
    "allowedDomains": [
      "registry.npmjs.org",
      "github.com",
      "*.github.com",
      "api.openai.com",
      "api.anthropic.com",
      "my-internal-api.company.com"
    ],
    "deniedDomains": ["malicious.example.com"]
  }
}
```

### Path precedence

Path precedence is inherited from `@anthropic-ai/sandbox-runtime`:

- Read: `allowRead` takes precedence over `denyRead`
- Write: `denyWrite` takes precedence over `allowWrite`

### Example: allow git commit signing with SSH public key

If your Git workflow needs to read a public key (for example `~/.ssh/id_ed25519.pub`) while keeping `~/.ssh` blocked by default, re-allow only that file:

```json
// ~/.config/opencode-sandbox/config.json
{
  "filesystem": {
    "denyRead": [
      "~/.ssh",
      "~/.gnupg",
      "~/.aws/credentials",
      "~/.azure",
      "~/.config/gcloud",
      "~/.config/gh",
      "~/.kube",
      "~/.docker/config.json",
      "~/.npmrc",
      "~/.netrc",
      "~/.env"
    ],
    "allowRead": ["~/.ssh/id_ed25519.pub"]
  }
}
```

### Example: Per-project config

```json
// ~/.config/opencode-sandbox/projects/my-app.json
{
  "network": {
    "allowedDomains": ["my-internal-api.company.com"]
  }
}
```

### Environment variable

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh"]},"network":{"allowedDomains":["github.com"]}}' opencode
```

Example allowing only the SSH public key to be read:

```bash
OPENCODE_SANDBOX_CONFIG='{"filesystem":{"denyRead":["~/.ssh","~/.gnupg","~/.aws/credentials","~/.azure","~/.config/gcloud","~/.config/gh","~/.kube","~/.docker/config.json","~/.npmrc","~/.netrc","~/.env"],"allowRead":["~/.ssh/id_ed25519.pub"]}}' opencode
```

### Enforcement mode

The default mode is `permissive`: if the sandbox cannot initialize or wrap a command, the command runs without sandboxing.

Set `mode` to `enforce` to block `bash` commands whenever sandboxing cannot be applied, including on unsupported platforms:

```json
{
  "mode": "enforce"
}
```

### Disable

```bash
OPENCODE_DISABLE_SANDBOX=1 opencode
```

Or in any config file:

```json
{
  "disabled": true
}
```

## How it works

The plugin uses two OpenCode hooks:

1. **`tool.execute.before`** — Intercepts bash commands and wraps them with `SandboxManager.wrapWithSandbox()` before execution
2. **`tool.execute.after`** — Restores the original command on the tool arguments after execution

It also listens to OpenCode events to restore the original command in persisted tool history and clean up sandbox resources when commands finish or are interrupted.

```
Agent → bash tool → [plugin wraps command] → sandboxed execution → [plugin restores UI] → Agent
```

The AI model interprets sandbox errors (like "Read-only file system" or "Connection blocked") directly from command output — no additional annotation layer needed.

Sandbox initialization is deferred until the first `bash` command, so the plugin does not interfere with OpenCode startup. Plugin diagnostics are sent through OpenCode's structured logger instead of being printed into the TUI. Sandbox violations are correlated with each individual tool call, including concurrent or repeated commands.

### Windows status

`@anthropic-ai/sandbox-runtime` supports Windows through an argv-and-environment API, while OpenCode currently exposes this plugin's `bash` hook as a command string. Until those interfaces can be connected safely, the plugin leaves Windows commands unsandboxed in `permissive` mode and blocks `bash` commands in `enforce` mode.

### Failure behavior

In the default `permissive` mode, commands run normally if sandbox initialization or wrapping fails. In `enforce` mode, the affected `bash` command is blocked instead.

## Related

- [@anthropic-ai/sandbox-runtime](https://github.com/anthropic-experimental/sandbox-runtime) — The underlying sandbox engine
- [OpenCode Plugins Docs](https://opencode.ai/docs/plugins) — How to create and use plugins
- [Claude Code Sandboxing](https://docs.claude.com/en/docs/claude-code/sandboxing) — Anthropic's sandboxing documentation
