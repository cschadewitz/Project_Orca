- **app:** the bundled faces are checked by machine on Linux, macOS and Windows. A second
  job in the app smoke workflow launches the dev-only `#type` surface on all three runners
  and diffs committed per-platform screenshots of its two theme columns, with the bundled
  faces on and off, so a glyph that quietly falls through to the operating system fails a
  pull request instead of going unnoticed on the machine that happens to have the typeface
  installed (#213). It also asserts, without needing a baseline, that no bundled
  `@font-face` ended at `error` and that flipping the fallback toggle actually changes what
  is drawn. `#type` stays out of production builds exactly as before: the spec starts a Vite
  dev server and points the main process at it through `ORCA_RENDERER_URL`, the seam
  `pnpm --filter @orca/app dev` already uses. `docs/DEVELOPMENT.md` ("Screenshot baselines")
  has how the baselines are created and the one honest way to update them.
