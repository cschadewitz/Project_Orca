/**
 * Which row takes focus when the row holding it leaves a list. Without an answer, focus goes
 * out of the document with the row's control and falls to the page body, which drops a
 * keyboard user out of the list they were in with no way back to where they were.
 *
 * Two lists ask it: the Agents surface's claims, where a release the daemon took is followed
 * by a re-read that no longer has the claim (`Claims` in agents-surface.tsx), and the
 * permission policy panel's written grants, where **Remove** takes a grant out of the draft
 * (`PolicyEditor` in policy-editor.tsx). In both the row reports, from its layout-effect
 * cleanup, that it was holding focus, and the list asks this which row to move it to.
 *
 * **The row that was after it, or the one before it when it was the last.** The list closes
 * up under a person moving down it, and the row that slides into the gap is the one their
 * next `Tab` would have reached anyway. Only a row that was there *before* counts: the same
 * read can bring rows nobody has looked at yet, and focus landing on one of those is focus
 * landing somewhere the person never was. `undefined` when none is left — the list is empty,
 * or every row on it is new — and the list decides where focus goes instead.
 *
 * Rows are named by their keys, the strings React keys them by, and the answer is a position
 * in `now`. So a key has to be the row's identity rather than its position: a key that moved
 * with the rows after the one that left would name none of them in `now`.
 */
export function focusAfterLeaving(before: readonly string[], now: readonly string[], gone: string): number | undefined {
  const at = before.indexOf(gone);
  const after = before.slice(at + 1);
  const prior = before.slice(0, Math.max(at, 0)).reverse();
  for (const key of [...after, ...prior]) {
    const index = now.indexOf(key);
    if (index !== -1) return index;
  }
  return undefined;
}
