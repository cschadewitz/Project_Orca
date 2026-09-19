# ORCA UI rules

Short enough to keep in context on every task. The reasoning is in `README.md`; the
non-negotiables are here.

1. **No literal colours, sizes, radii, durations or z-values in component code.** Reference a
   token: `var(--status-failed)` in CSS, `v('status-failed')` from `@orca/design` in TypeScript.
   If no token names what you need, add one to `packages/design/tokens.json` and rebuild — do
   not inline it.
2. **`css/tokens.css` and `src/tokens.ts` in `packages/design` are generated.** Edit
   `tokens.json` (values) or `semantics.json` (words and glyphs), then run
   `pnpm run design:build`. Never hand-edit the generated files; CI checks they are current.
3. **Eight run statuses, and only eight**: running, waiting, succeeded, failed, cancelled,
   blocked, held, stale. Adding a ninth is a design change, not a patch. Use `RunStatus` and
   `STATUS_PRESENTATION` — never re-declare the list.
4. **Status is never colour alone.** Every status renders its glyph and its word; colour is the
   third channel. The same goes for dependency edges (kind is the stroke style, state is the
   colour) and the risk matrix (the top band is hatched).
5. **`accent` means interactive, never a state.** Links, primary buttons, the active nav item,
   selection and focus. A running step is not teal.
6. **Success is quiet, waiting is loud.** `status-succeeded` appears at chip scale only.
   `status-waiting` is the only status permitted in the title bar, the sidebar count and the
   dock badge.
7. **Both themes, every time.** Check a new colour against `surface-canvas`, `surface-base`,
   `surface-raised` and `surface-sunken` in light *and* dark, and give it a `usage` note naming
   the grounds it sits on. `node --test "design/test/*.test.mjs"` enforces the floors.
8. **Mono means ORCA produced it.** Ids, step and node names, paths, expressions, tool names,
   agent output, artifact bodies. Sans is for prose a person wrote. The distinction is
   load-bearing.
9. **Rows are fixed height and never wrap.** Row height comes from `--row-h`, which
   `data-density` rebinds. Anything needing two lines is a declared two-line variant, not a row
   that grew.
10. **Focus is never suppressed.** 2px `--border-focus`, 1px offset, drawn with `outline`.
    Selection (`--surface-selected` + accent rail) and focus (the ring) are different things and
    must both stay legible.
11. **Streaming output is not an `aria-live` region.** Announce step transitions and terminal
    states only. Gates and permission asks announce assertively.
12. **Never invent data ORCA does not have.** No completion percentage, no ETA, no token cost.
    If a screen needs a number the runtime cannot supply, say so in the PR instead of
    approximating it.
13. **Sentence case everywhere. No emoji. No exclamation marks.** Subject first, so a truncated
    row still means something.
14. **Prefer the CSS layer.** `components.css` already implements the primitives; build React on
    top of those classes rather than re-deriving the values. `component-api.d.ts` says what props
    each one should take.
