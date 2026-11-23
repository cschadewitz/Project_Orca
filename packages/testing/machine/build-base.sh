#!/usr/bin/env bash
# Load or build the two-machine test's packages layer (base.Dockerfile) as orca-machine-base:ci,
# and save it to $1 for actions/cache. Used by the PR job (.github/workflows/two-daemons.yml) and
# by the trusted main-branch warm job (.github/workflows/machine-base-cache.yml), so both produce
# the same image under the same cache key.
#
# The pinned Ubuntu base is pulled on its own first, from Docker Hub or else its mirror on
# mirror.gcr.io (the digest pins the content either way), so a stalled registry is told apart
# from a stalled package archive. Every network step has a bounded time, and is killed outright
# if it ignores the stop, so one stuck attempt cannot use up the retries.
set -euo pipefail
tar_path="$1"
here="$(cd "$(dirname "$0")" && pwd)"
digest="$(sed -n 's/^ARG BASE=ubuntu@\(sha256:[0-9a-f]\{64\}\)$/\1/p' "$here/base.Dockerfile")"
[ -n "$digest" ] || { echo "::error::no pinned base digest in base.Dockerfile"; exit 1; }
# Per-attempt time for the package install; the main warm job, which nothing waits on, allows more.
build_timeout="${ORCA_BASE_BUILD_TIMEOUT:-300}"
# The archive mirror this host's own apt uses (a hosted runner's is usually close by and fast);
# the last attempt goes to the Ubuntu archive itself in case that mirror is the one stalling.
host_mirror="$(sed -n 's/^URIs:[[:space:]]*\(https\?:\/\/[^[:space:]]*\).*/\1/p' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null | head -n1 || true)"
case "$host_mirror" in *//archive.ubuntu.com/* | *//security.ubuntu.com/*) host_mirror="" ;; esac
if [ -s "$tar_path" ] && docker load -i "$tar_path"; then exit 0; fi
for attempt in 1 2 3; do
  mirror="$host_mirror"
  [ "$attempt" = 3 ] && mirror=""
  echo "package mirror for attempt $attempt: ${mirror:-the Ubuntu archive}"
  base=""
  for repo in docker.io/library/ubuntu mirror.gcr.io/library/ubuntu; do
    echo "pulling $repo@$digest (attempt $attempt)"
    if timeout --kill-after=15 120 docker pull -q "$repo@$digest"; then
      base="$repo@$digest"
      break
    fi
    echo "::warning::pulling $repo@$digest failed or timed out"
  done
  if [ -n "$base" ] && timeout --kill-after=30 "$build_timeout" docker build --progress=plain \
    --build-arg "BASE=$base" --build-arg "UBUNTU_MIRROR=$mirror" -t orca-machine-base:ci -f "$here/base.Dockerfile" "$here"; then
    docker save -o "$tar_path" orca-machine-base:ci
    exit 0
  fi
  echo "::warning::machine base build attempt $attempt failed or timed out"
  sleep $((attempt * 15))
done
exit 1
