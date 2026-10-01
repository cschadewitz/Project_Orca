# Package dependency inventory

Declared manifest dependencies. These are configuration evidence; source import direction is discussed in the architecture specifications. All workspace packages are private and use version 0.1.0; the root release version is 0.5.2.

| Package | Runtime workspace dependencies | Runtime external dependencies | Development-only dependencies |
| --- | --- | --- | --- |
| [@orca/agents](../../packages/agents/package.json) | @orca/core | @agentclientprotocol/sdk ^1.4.0 | none |
| [@orca/app](../../packages/app/package.json) | @orca/design, @orca/protocol | electron-updater ^6.8.9, react ^19.2.0, react-dom ^19.2.0, zod ^4.6.5 | @orca/daemon workspace:*, @testing-library/react ^16.3.3, @types/react ^19.2.0, @types/react-dom ^19.2.0, @vitejs/plugin-react ^6.1.1, electron ^44.4.3, electron-builder ^26.15.3, esbuild ^0.28.2, vite ^8.0.0 |
| [@orca/cli](../../packages/cli/package.json) | @orca/core, @orca/store, @orca/agents, @orca/engine, @orca/testing, @orca/integrations, @orca/daemon, @orca/protocol | yaml ^2.9.1 | none |
| [@orca/core](../../packages/core/package.json) | none | zod ^4.6.5, yaml ^2.9.1 | none |
| [@orca/daemon](../../packages/daemon/package.json) | @orca/agents, @orca/core, @orca/engine, @orca/protocol, @orca/store | ws ^8.21.3, yaml ^2.9.1, zod ^4.6.5 | @types/ws ^8.18.1 |
| [@orca/design](../../packages/design/package.json) | none | none | none |
| [@orca/engine](../../packages/engine/package.json) | @orca/core, @orca/store, @orca/agents | none | @agentclientprotocol/sdk ^1.4.0 |
| [@orca/integrations](../../packages/integrations/package.json) | @orca/core, @orca/store, @orca/agents, @orca/engine | @agentclientprotocol/sdk ^1.4.0, zod ^4.6.5 | none |
| [@orca/protocol](../../packages/protocol/package.json) | @orca/core | zod ^4.6.5 | none |
| [@orca/store](../../packages/store/package.json) | @orca/core | zod ^4.6.5 | none |
| [@orca/testing](../../packages/testing/package.json) | @orca/core, @orca/agents | @agentclientprotocol/sdk ^1.4.0, yaml ^2.9.1, zod ^4.6.5 | tsx ^4.23.15 |
| [@orca/eslint-config](../../tools/eslint-config/package.json) | none | @eslint/js ^10.0.1, eslint-config-prettier ^10.1.8, globals ^17.12.0, typescript 6.0.3, typescript-eslint ^8.70.0 | none |
| [@orca/font-build](../../tools/font-build/package.json) | none | @fontsource/noto-sans-math ^5.3.0, @fontsource/noto-sans-symbols-2 ^5.3.0, @ibm/plex-mono ^2.5.0, @ibm/plex-sans ^1.1.0, fontkit ^2.0.4, subset-font ^2.7.0 | none |

`@orca/app` declares daemon as a development dependency for bundling; its implementation imports protocol/design. `@orca/cli` declares testing as a runtime dependency because its demo command uses the scripted agent. Font-build dependencies supply committed assets rather than runtime UI dependencies. See [engineering](engineering.md).
