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
if [ -s "$tar_path" ] && docker load -i "$tar_path"; then exit 0; fi
for attempt in 1 2 3; do
  base=""
  for repo in docker.io/library/ubuntu mirror.gcr.io/library/ubuntu; do
    echo "pulling $repo@$digest (attempt $attempt)"
    if timeout --kill-after=15 120 docker pull -q "$repo@$digest"; then
      base="$repo@$digest"
      break
    fi
    echo "::warning::pulling $repo@$digest failed or timed out"
  done
  if [ -n "$base" ] && timeout --kill-after=30 300 docker build --progress=plain --build-arg "BASE=$base" \
    -t orca-machine-base:ci -f "$here/base.Dockerfile" "$here"; then
    docker save -o "$tar_path" orca-machine-base:ci
    exit 0
  fi
  echo "::warning::machine base build attempt $attempt failed or timed out"
  sleep $((attempt * 15))
done
exit 1
