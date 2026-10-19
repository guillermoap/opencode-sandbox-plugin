#!/bin/sh
set -eu

# Release builds substitute all three immutable values. No code runs from main.
RELEASE='__OPENCODE_SANDBOX_TAG__'
REVISION='__OPENCODE_SANDBOX_REVISION__'
SHA256='__OPENCODE_SANDBOX_SHA256__'

case "${1-}" in
  --help|-h)
    printf '%s\n' 'Usage: sh install.sh [--yolo-except-env | --uninstall]' \
      'Default: sandbox + dotenv denials; no allow-all rule.' \
      'Run in a trusted terminal. macOS, OpenCode V2 and Node 20.11+ required.'
    exit 0 ;;
esac
[ "$(uname -s)" = Darwin ] || { echo 'This installer supports macOS only.' >&2; exit 1; }
command -v node >/dev/null || { echo 'Install Node 20.11+ first.' >&2; exit 1; }
command -v opencode >/dev/null || { echo 'Install OpenCode V2 first.' >&2; exit 1; }
case "$REVISION" in *__*) echo 'Use the installer attached to a versioned release.' >&2; exit 1 ;; esac

work=$(mktemp -d "${TMPDIR:-/tmp}/opencode-sandbox-install.XXXXXXXX")
trap 'rm -f "$work/setup.mjs"; rmdir "$work"' EXIT HUP INT TERM
curl --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  "https://github.com/guillermoap/opencode-sandbox-plugin/releases/download/$RELEASE/setup.mjs" \
  --output "$work/setup.mjs"
actual=$(shasum -a 256 "$work/setup.mjs")
actual=${actual%% *}
[ "$actual" = "$SHA256" ] || { echo 'Installer checksum mismatch; nothing executed.' >&2; exit 1; }
node "$work/setup.mjs" "$@"
