# Documentation index

This page lists every living document and who it is for. Reading them needs no install and no
credentials. For what works today, read the [capability ledger](ROADMAP.md). For history, see
the [archive](archive/README.md).

## Start here

| Document | Read it to… |
| --- | --- |
| [Project README](../README.md) | learn what ORCA does and run the demo |
| [Architecture](ARCHITECTURE.md) | understand the engine, storage, ACP and MCP directions, daemon and app |
| [Capabilities and roadmap](ROADMAP.md) | see what is implemented, what is limited and which issue owns each gap |
| [Development](DEVELOPMENT.md) | set up tools, build, test and pick the right checks |
| [Contributing](../CONTRIBUTING.md) | plan issues and open pull requests |
| [Agent guidance](../AGENTS.md) | follow the rules every agent working here must follow |

## Using ORCA

| Document | Read it to… |
| --- | --- |
| [Workflow authoring](WORKFLOWS.md) | define nodes, completion, templates and permissions |
| [Typed workflow inputs](workflow-inputs.md) | declare and validate launch inputs |
| [Planning](PLANNING.md) | use cross-request dependencies, risks, decisions and scheduling |
| [Data model](DATA-MODEL.md) | understand entities, events and the expression and template context |
| [Extensibility](EXTENSIBILITY.md) | write a plugin |
| [Built-in node validation](builtin-node-validation.md) | understand how built-in nodes are checked at bootstrap and restore |
| [Integrations](INTEGRATIONS.md) | connect ACP clients, Kepler, MCP servers, SSH hosts and JEV |
| [Agent support](agent-support.md) | see which agents, versions and platforms are supported and how far each is tested |
| [Agent hook coverage](agent-hook-coverage.md) | see which agents expose native tool hooks |
| [Hook telemetry](hook-telemetry.md) | turn on, export and delete per-agent tool-call records |
| [Cline](agents/cline.md), [Copilot CLI](agents/copilot-cli.md) | set up these agents |
| [Running across machines](MULTI-MACHINE.md) | run agents over SSH, watch several daemons, delegate steps to remote daemons |
| [Real-agent test](REAL-AGENT-TEST.md) | run a workflow against real agents |

## Daemon, clients and safety

| Document | Read it to… |
| --- | --- |
| [Protocol reference](../packages/protocol/README.md) | read the wire contract and its version history |
| [Daemon security](daemon-security.md) | understand tokens, grants and the permission matrix |
| [Daemon connections](daemon-connection.md) | understand how the app picks a daemon and keeps targets apart |
| [Configuration generations](configuration-generations.md) | save, activate and restore configuration |
| [Request submission](request-submission.md) | understand Request and direct launch, and what each step promises |
| [Admission retry](admission-retry.md) | retry a launch safely after a lost response |
| [Live input continuity](live-input-continuity.md) | understand when a live permission ask survives |
| [Revision input](revision-input.md) | send a person's correction into a running step |
| [Secret use authority](secret-use-authority.md) | understand how agents are allowed to use secrets |
| [Protected execution storage](protected-execution-storage.md) | understand how protected run data is stored and backed up |
| [Protected replay errors](protected-replay-error-contract.md) | understand how protected replay fails closed |
| [Recovering interrupted work](recovery.md) | preview and choose resume, new run or checkpoint |
| [Owned root worktrees](root-worktree-isolation.md) | use opt-in local Linux isolation |
| [Host resources](host-resources.md), [access policy proposal](host-resource-access-policy.md) | understand host measurement and its limits |
| [MCP operator](mcp-operator.md) | let an assistant operate ORCA over MCP |
| [MCP operator production contract](mcp-operator-production-contract.md), [acceptance](mcp-operator-production-acceptance.md) | check what the production MCP setup must prove |
| [Maintenance MCP](maintenance-mcp.md) | understand the read-only maintenance contract |
| [Maintenance observer runbook](maintenance-observer-runbook.md) | operate the maintenance observer |

## Storage

| Document | Read it to… |
| --- | --- |
| [File locks and shared volumes](storage/file-locks.md) | see why a store must live on one host's local disk |
| [SQLite metadata](storage/sqlite-metadata.md) | understand the SQLite metadata store |
| [Store contracts](contracts/store-contracts-v1.md) | read the store's versioned contracts |
| [Plugin restoration](contracts/plugin-restoration-v1.md), [installed plugin release](contracts/installed-plugin-release-v1.md) | read the plugin contracts |

## Install, update and release

| Document | Read it to… |
| --- | --- |
| [Installing on Linux](INSTALL-LINUX.md) | install the desktop app on Ubuntu 24.04 or later |
| [Updating](UPDATING.md) | understand how installs update, and operate the update feed |
| [Releasing](RELEASING.md) | cut, sign and publish a release |
| [Workstreams](WORKSTREAMS.md) | land a large feature with no target release without holding or disrupting a release: feature branches, their CI and nightly sync with `main` |
| [Windows signing runbook](windows-signing-runbook.md) | sign the Windows installer |
| [CI runners](ci-runners.md) | see how CI picks self-hosted or hosted runners |
| [CI shadow selection](ci-shadow-selection.md) | understand advisory test selection |
| [Performance evidence](performance/persistence-baseline/README.md) | read the synthetic performance baselines |

## Design and decisions

| Document | Read it to… |
| --- | --- |
| [UI rules](design/RULES.md) | follow the binding UI rules |
| [Design system](design/README.md) | understand the brand, tokens and surface specs |
| [Plain-language rules](plain-language-rules.md) | write in the house voice |
| [ADRs](adr/) | read settled architecture decisions |

## Preparation packets still in use

These packets in [preparation/](preparation/) are read by tests, CI or the build, so they stay
here. They record design work, not product acceptance. All other preparation is in the
[archive](archive/README.md).
