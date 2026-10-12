#!/usr/bin/env bash
# SessionStart hook: make a Claude Code cloud session ready to typecheck, lint, test and build.
#
# It does nothing outside a cloud session (CLAUDE_CODE_REMOTE is unset locally), so it never
# installs anything on a contributor's machine. In the cloud it puts Node 24 and the pinned
# pnpm on PATH, provisioning them with .claude/cloud/setup.sh if the environment's setup
# script did not, and runs the frozen install CI runs, without the Electron binary: a cloud
# session cannot open the app's window, and CI skips the download for the same reason. Set
# ORCA_CLOUD_ELECTRON=1 in the environment's variables to keep the download.
#
# What it prints goes to Claude as context, so the last line says whether the session is
# ready and, if not, what to run to see why. It always exits 0: a failed install should be
# something Claude can read and fix, not a session that refuses to start.
set -uo pipefail

[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
node_dir="${ORCA_NODE_DIR:-/opt/node24}"
log="$(mktemp -t orca-session-start.XXXXXX.log)"

fail() {
  echo "ORCA cloud setup failed: $1. The log is $log; rerun with: CLAUDE_CODE_REMOTE=true bash .claude/hooks/session-start.sh"
  exit 0
}

cd "$root" || fail "no checkout at $root"

if ! "$node_dir/bin/node" --version 2>/dev/null | grep -q '^v24\.' ||
  ! grep -qE '^[a-f0-9]{32}$' /etc/machine-id 2>/dev/null; then
  bash .claude/cloud/setup.sh >>"$log" 2>&1 || fail "provisioning Node 24, pnpm and a machine id"
fi
export PATH="$node_dir/bin:$PATH"

# CI bounds Vitest to two workers: the suite's subprocess-heavy tests time out when more
# compete for a small machine, and the cloud VM is one (4 vCPU).
workers="${VITEST_MAX_WORKERS:-2}"
skip_electron=1
[ "${ORCA_CLOUD_ELECTRON:-}" = "1" ] && skip_electron=
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  {
    echo "export PATH=\"$node_dir/bin:\$PATH\""
    echo "export VITEST_MAX_WORKERS=$workers"
    [ -n "$skip_electron" ] && echo "export ELECTRON_SKIP_BINARY_DOWNLOAD=1"
  } >>"$CLAUDE_ENV_FILE"
fi
[ -n "$skip_electron" ] && export ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Follow packageManager, so a branch that moves pnpm does not need the setup script edited.
pnpm_version="$(node -p 'require("./package.json").packageManager.split("@")[1]' 2>>"$log")" ||
  fail "reading packageManager from package.json"
if [ "$(pnpm --version 2>/dev/null)" != "$pnpm_version" ]; then
  npm install --global --prefix "$node_dir" --no-fund --no-audit --loglevel=error "pnpm@$pnpm_version" >>"$log" 2>&1 ||
    fail "installing pnpm $pnpm_version"
fi

pnpm install --frozen-lockfile >>"$log" 2>&1 || fail "pnpm install --frozen-lockfile"

electron_note="Electron binary skipped, so app:smoke and app dev will not launch"
[ -z "$skip_electron" ] && electron_note="Electron binary downloaded"
echo "ORCA cloud session ready: node $(node --version), pnpm $(pnpm --version), dependencies installed; $electron_note." \
  "The whole suite takes tens of minutes on $workers workers: run the affected files with" \
  "'pnpm exec vitest run <paths>' in the foreground and 'pnpm test' only in the background."
