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
   `STATUS_PRESENTATION` — never re-declare the list. A status is drawn by `StatusChip`, the one
   status chip: a surface never gives it a class or a width, and a column of them is its
   `aligned` variant.
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
   the grounds it sits on. `pnpm exec vitest run packages/design/test/contrast.test.ts` enforces the floors.
8. **Mono means ORCA produced it.** Ids, step and node names, variable and config key names,
   paths, expressions, tool names, agent output, artifact bodies. Sans is for prose a person
   wrote. The distinction is load-bearing. An id in a row or a header goes through `ObjectId` —
   the name, then the kind glyph and the last six characters — and is never printed or sliced
   raw. A machine string that does not fit is cut at its end, never in the middle.
9. **Rows are fixed height and never wrap.** Row height comes from `--row-h`, which
   `data-density` rebinds. Anything needing two lines is a declared two-line variant, not a row
   that grew. A run of chips in a card or a panel is `.orca-chips`, which wraps between whole
   chips; a row gives a chip a column instead.
10. **Focus is never suppressed, and never dropped.** 2px `--border-focus`, 1px offset, drawn
    with `outline`. Selection (`--surface-selected` + accent rail) and focus (the ring) are
    different things and must both stay legible. When the control holding focus leaves — a row
    removed, a save bar that goes, a deleted node — focus moves to its neighbour
    (`focusAfterLeaving`) or to the region it belonged to, never to the page body; focus a
    person moved elsewhere stays where they put it.
11. **Streaming output is not an `aria-live` region.** Announce step transitions and terminal
    states only. Gates and permission asks announce assertively.
12. **Never invent data ORCA does not have.** No completion percentage, no ETA, no token cost.
    If a screen needs a number the runtime cannot supply, say so in the PR instead of
    approximating it.
13. **Sentence case everywhere. No emoji. No exclamation marks.** Subject first, so a truncated
    row still means something.
14. **Prefer the CSS layer.** `components.css` already implements the primitives; build React on
    top of those classes rather than re-deriving the values. `component-api.d.ts` says what props
    each one should take. A control's own rule never resets its font: that reset is the
    `:where()` rule's, so the element's type class wins.
15. **Text that does not fit has one answer.**
    1. *A bounded label never wraps.* Chips, badges, pills, buttons, segments, key caps and the
       parts of a crumb are one line and as wide as their text, so the outline always encloses
       it. A label allowed to be longer than its box is cut at its end inside its outline, with
       the whole text in `title`.
    2. *A number and its noun are one unit.* Write a count with `counted` or `unit`
       (`ui/count.ts`): the noun agrees ("1 edge") and a no-break space holds the two together,
       so a run of counts wraps only between them, at the ` · `.
    3. *A bar stays one line.* Title bar, object header, status bar, draft bar: the controls and
       counts keep their width, and the lowest-priority sentence (`.orca-truncate`) is cut at its
       end with its whole in `title`.
16. **Every popover is a `Menu`, and it stands on `surface-raised`** with `shadow-popover` —
    never on `surface-overlay`, which is a modal's scrim and carries no text. A `danger` item
    leads with `✕` in the danger tone, is never first and never where focus lands on open. A
    `hint` is a one-word meta, `hintMachine` is machine text in mono and never re-cased, and a
    sentence is the menu's `note`.
17. **Confirm only what has no way back, and confirm it where it was asked.** A destructive act
    with no way back arms its own row (or palette row): **Keep** first and focused, **✕ Confirm**
    in the danger tone, the consequence on the row's declared two-line variant, `Esc` through the
    layer stack. An edit to a draft — Remove a grant, Delete a node — is a plain button that does
    not ask, because Save, Discard and Undo are the way back. A resting screen carries no danger
    tone.
