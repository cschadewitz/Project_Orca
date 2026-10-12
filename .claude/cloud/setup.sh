#!/usr/bin/env bash
# The setup script for ORCA's Claude Code cloud environment.
#
# Paste this file into the environment's "Setup script" field at claude.ai/code. It runs as
# root before Claude starts, and a run that finishes inside about five minutes is cached, so
# later sessions start with the toolchain already on disk. It provisions only what the base
# image lacks: the image ships Node 22, and ORCA needs Node 24 (package.json `engines`) and
# the pnpm that `packageManager` pins, plus a host identity (below). Installing the workspace's dependencies is the
# SessionStart hook's job (.claude/hooks/session-start.sh), because that needs the checkout
# and has to follow the lockfile on every branch; the hook also runs this script when a
# session starts without it, so a missing paste costs time rather than a broken session.
#
# Keep the two versions below in step with .github/workflows/ci.yml and package.json.
set -euo pipefail

NODE_VERSION="${ORCA_NODE_VERSION:-24.21.0}"
PNPM_VERSION="${ORCA_PNPM_VERSION:-12.4.2}"
NODE_DIR="${ORCA_NODE_DIR:-/opt/node24}"

if [ "$("$NODE_DIR/bin/node" --version 2>/dev/null || true)" != "v$NODE_VERSION" ]; then
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "setup: no Node build for $(uname -m)" >&2; exit 1 ;;
  esac
  file="node-v$NODE_VERSION-linux-$arch.tar.xz"
  base="https://nodejs.org/dist/v$NODE_VERSION"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL --retry 3 "$base/$file" -o "$tmp/$file"
  curl -fsSL --retry 3 "$base/SHASUMS256.txt" | grep "  $file\$" | (cd "$tmp" && sha256sum -c --quiet -)
  rm -rf "$NODE_DIR"
  mkdir -p "$NODE_DIR"
  tar -xJf "$tmp/$file" -C "$NODE_DIR" --strip-components=1
fi

export PATH="$NODE_DIR/bin:$PATH"
if [ "$("$NODE_DIR/bin/pnpm" --version 2>/dev/null || true)" != "$PNPM_VERSION" ]; then
  npm install --global --prefix "$NODE_DIR" --no-fund --no-audit --loglevel=error "pnpm@$PNPM_VERSION"
fi

# The suite compiles small C probes with /usr/bin/cc and runs python3 helpers on Linux.
# Both are in the base image today; this only matters if that changes.
if ! command -v cc >/dev/null || ! command -v python3 >/dev/null; then
  if [ "$(id -u)" = 0 ]; then
    apt-get update -qq && apt-get install -y -qq build-essential python3 >/dev/null
  else
    echo "setup: cc or python3 is missing and this is not root; native and tools tests will fail" >&2
  fi
fi

# The first-run fence derives the host's identity from /etc/machine-id and refuses an empty
# or all-zero one (packages/protocol/src/first-run-fence.ts), as a container image often
# ships it. Give the VM one, the way systemd would on a first boot.
if ! grep -qE '^[a-f0-9]{32}$' /etc/machine-id 2>/dev/null || grep -qE '^0+$' /etc/machine-id; then
  if [ "$(id -u)" = 0 ]; then
    tr -d '-' </proc/sys/kernel/random/uuid >/etc/machine-id
  else
    echo "setup: /etc/machine-id is not a host identity and this is not root; first-run tests will fail" >&2
  fi
fi

# Login shells find Node 24 ahead of the image's Node 22. Claude's own shells get the same
# PATH from the SessionStart hook, which writes it to CLAUDE_ENV_FILE.
if [ "$(id -u)" = 0 ] && [ -d /etc/profile.d ]; then
  echo "export PATH=\"$NODE_DIR/bin:\$PATH\"" >/etc/profile.d/orca-node.sh
fi

echo "setup: node $("$NODE_DIR/bin/node" --version), pnpm $("$NODE_DIR/bin/pnpm" --version) in $NODE_DIR"
