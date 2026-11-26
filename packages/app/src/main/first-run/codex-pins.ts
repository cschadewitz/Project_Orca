/**
 * The Codex native builds ORCA verified for the app-server driver (#1167), by version, then by
 * `<platform>-<arch>`: a copy of `CODEX_VERIFIED_IMAGES` in `@orca/agents`, which the app does
 * not depend on. `tools/test/codex-pins-1167.test.js` fails when the two differ.
 */
export const CODEX_PINNED_IMAGES: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
  "0.171.0": Object.freeze({
    "linux-x64": "b76a027d6b210f9a8da7aaf321dd235c700f0ef7a794d4a5314b9af6c134f0f0",
  }),
});

/** The pinned Codex version whose image on `target` has digest `sha256`, or undefined. */
export function pinnedCodexVersion(
  sha256: string,
  target: string,
  pins: Readonly<Record<string, Readonly<Record<string, string>>>> = CODEX_PINNED_IMAGES,
): string | undefined {
  for (const [version, images] of Object.entries(pins)) if (images[target] === sha256) return version;
  return undefined;
}
