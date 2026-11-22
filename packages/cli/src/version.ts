/**
 * The release version, as `orca --version` and `hello.orcaVersion` report it.
 *
 * The **root** manifest, deliberately, and it is the only place either of them reads.
 * The repository releases in lockstep from that one version; the packages under
 * `packages/` all sit at `0.1.0` and never move (docs/RELEASING.md), so reading this
 * package's own manifest had a `v0.3.0` release announce `orca daemon 0.1.0` — a number
 * plausible enough to go unnoticed and wrong everywhere it is shown (#229).
 *
 * Two ways in, because this module is built twice. `tsc` leaves it at
 * `packages/cli/dist/version.js`, three directories below the root manifest —
 * exactly where `packages/cli/src/version.ts` is, so the one relative path means
 * the same thing under `tsx`. That is the fallback and it is what every ordinary `orca`
 * invocation takes.
 *
 * The desktop app instead bundles the whole CLI into one file
 * (`packages/app/scripts/build-daemon.js`) and ships it somewhere else entirely, so
 * `import.meta.url` becomes the bundle's own location and no relative path from it can
 * reach a manifest this repository controls: it found `packages/app/package.json` while
 * the bundle sat in `packages/app/dist/daemon/` and nothing at all once electron-builder
 * moved it to `resources/daemon/`, which crashed the daemon on startup. So the bundler
 * reads that same root manifest at build time and substitutes the version here; the
 * require never runs there, and there is still one source.
 *
 * `typeof` rather than a bare reference: in the `tsc` build the identifier is not declared
 * at all, and `typeof` is the one operator that does not throw on that.
 */
import { createRequire } from "node:module";

declare const __ORCA_VERSION__: string | undefined;
export function readOrcaVersion(): string {
  return typeof __ORCA_VERSION__ === "string"
    ? __ORCA_VERSION__
    : (createRequire(import.meta.url)("../../../package.json") as { version: string }).version;
}
