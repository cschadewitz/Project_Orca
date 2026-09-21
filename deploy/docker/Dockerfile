# syntax=docker/dockerfile:1
#
# The ORCA daemon in a container: `orca serve` over a workspace mounted at /workspace,
# with the ACP adapters for Claude Code and Codex on PATH beside it.
#
# Build from the repository root, not from this directory:
#
#   docker build -f deploy/docker/Dockerfile -t orca:0.5.0 .
#
# Two stages, because the daemon ships as one file. The build stage is the repository's
# own `pnpm run build` followed by `packages/app/scripts/build-daemon.js`, which is the
# same bundle the desktop app spawns and the same one the release page carries
# (docs/RELEASING.md) — every workspace package and every dependency inlined, no
# node_modules beside it. The runtime stage therefore holds a JavaScript file, a Node, the
# agents, and nothing of the toolchain that produced it.

# ---- build: the CLI, bundled to one ESM file --------------------------------------
FROM node:24-slim AS build

# The app package pulls Electron in, and nothing here launches it. Skipping the binary
# saves ~150 MB and a download from a build that only wants `tsc` to see its types —
# the same variable CI sets, for the same reason (.github/workflows/ci.yml).
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1

# Pinned to the `packageManager` field in the root package.json. Corepack would read that
# field itself, but it is deprecated in current Node and absent from the next one.
RUN npm install --global pnpm@12.4.2

WORKDIR /src
COPY . .

# `tsc -b`, not `pnpm run build`: that script also builds the Vite renderer, which is the
# desktop app's and has nothing to do with a daemon.
RUN pnpm install --frozen-lockfile \
    && pnpm exec tsc -b tsconfig.build.json \
    && node packages/app/scripts/build-daemon.js --outfile /orca-daemon.mjs

# ---- runtime: the daemon and the agents it spawns ---------------------------------
FROM node:24-slim

# git because every workspace provider is a git checkout and agents commit; ca-certificates
# for the model APIs; openssh-client so `hosts[].type: ssh` works from inside the container;
# ripgrep because both coding agents shell out to it and are slower and noisier without it.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates git openssh-client ripgrep \
    && rm -rf /var/lib/apt/lists/*

# The agents, each behind the adapter that gives it an ACP stdio interface. Neither CLI
# speaks ACP on its own: `claude` has no ACP mode and `codex` has no `acp` subcommand
# (checked against codex-cli 0.155.1 — `examples/orca.config.yaml` still says `codex acp`
# and that is stale). Both adapters are published by the protocol's own org:
#
#   @agentclientprotocol/claude-agent-acp  ->  claude-agent-acp   (was @zed-industries/claude-code-acp)
#   @agentclientprotocol/codex-acp         ->  codex-acp
#
# The two CLIs are installed beside their adapters rather than left to them. `claude`
# because the adapter bundles a Claude Code of its own and a bundled one has been refused by
# the API before now for being too old ("claude_code_version_too_old",
# docs/REAL-AGENT-TEST.md §2) — CLAUDE_CODE_EXECUTABLE, which this adapter still honours,
# points it at the current one. `codex` because npm links only a top-level package's
# binaries, so the copy that arrives as codex-acp's own dependency is not on PATH, and
# `codex login` is how the container gets credentials.
#
# Pass `--build-arg AGENTS=` to build an image with no agents in it — worth doing when the
# agents run on another host over SSH, or when this daemon is `--read-only`.
ARG AGENTS="@agentclientprotocol/claude-agent-acp @agentclientprotocol/codex-acp @anthropic-ai/claude-code @openai/codex"
# The cache goes in the same layer or it stays in the image: half a gigabyte of tarballs
# nothing will read again, behind a `rm` in a later layer that cannot reach it.
RUN if [ -n "$AGENTS" ]; then npm install --global $AGENTS && npm cache clean --force; fi
ENV CLAUDE_CODE_EXECUTABLE=/usr/local/bin/claude

COPY --from=build /orca-daemon.mjs /orca-daemon.mjs.map /opt/orca/
# The shipped workflow graphs and prompt templates. A mounted orca.config.yaml names them
# by these absolute paths, so a workspace holds a store and a config and need not carry a
# copy of the repository (deploy/docker/orca.config.yaml).
COPY workflows /opt/orca/workflows
COPY templates /opt/orca/templates

# `orca` as a command, so `docker exec <container> orca runs` reads the same store the
# daemon is serving.
RUN printf '#!/bin/sh\nexec node /opt/orca/orca-daemon.mjs "$@"\n' > /usr/local/bin/orca \
    && chmod +x /usr/local/bin/orca

# uid 1000, from the base image. The agents write to /workspace as this user, so a bind
# mount from the host wants a host directory this uid can write — `user:` in compose.yaml
# is where to change that.
USER node
# The workspace the daemon serves: `orca serve` reads the config here and the store
# `storeDir` names under it. A directory with no store in it answers an empty run list
# rather than failing, so a fresh mount is a valid, empty daemon.
WORKDIR /workspace

# Loopback would make the published port unreachable: the port to bind is the container's
# interface, and what keeps it private is the host side of `-p 127.0.0.1:6722:6722`. The
# port carries no authentication — see "Setup Remote ORCA Daemon" in docs/SETUP.md before
# this reaches a network.
EXPOSE 6722
ENTRYPOINT ["orca"]
CMD ["serve", "--host", "0.0.0.0", "--port", "6722"]
