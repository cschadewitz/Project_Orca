#!/usr/bin/env bash
# Load or build the two-machine test's packages layer (base.Dockerfile) as orca-machine-base:ci,
# and save it to $1 for actions/cache. Used by the PR job (.github/workflows/two-daemons.yml) and
# by the trusted main-branch warm job (.github/workflows/machine-base-cache.yml), so both produce
# the same image under the same cache key. A cold build gets a bounded time per attempt.
set -euo pipefail
tar_path="$1"
here="$(cd "$(dirname "$0")" && pwd)"
if [ -s "$tar_path" ] && docker load -i "$tar_path"; then exit 0; fi
for attempt in 1 2 3; do
  if timeout 300 docker build -q -t orca-machine-base:ci -f "$here/base.Dockerfile" "$here"; then
    docker save -o "$tar_path" orca-machine-base:ci
    exit 0
  fi
  echo "::warning::machine base build attempt $attempt failed or timed out"
  sleep $((attempt * 15))
done
exit 1
