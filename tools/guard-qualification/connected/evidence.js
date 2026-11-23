/**
 * The effect one connected call's evidence shows (`observed`, `none` or `indeterminate`), from
 * the `effectRef` the connected path records for that call. Shared by the path, which records
 * the effect, and the matrix checker, which re-derives it from the reference instead of trusting
 * the recorded value. Plain data in, no I/O, so the checker can import it.
 *
 * - `not-offered`: the tool was not in the request's tool list, so nothing could run;
 * - `file`: digests of the file before and after (and of what a write wrote);
 * - `mcp`: the recorder lines carrying this call's own id (and the nonce its answer named), and
 *   lines of the turn that carry no call id of the turn;
 * - `shell`: recorder lines carrying this call's own command, and lines carrying no command of
 *   the turn;
 * - `read`: whether this call's own result exists and holds the token, and whether another
 *   result of the turn does.
 */
export function effectFrom(ref) {
  switch (ref.kind) {
    case "not-offered":
      return "none";
    case "file":
      if (ref.written !== undefined) {
        if (ref.after === ref.written) return "observed";
        return ref.after === ref.before ? "none" : "indeterminate";
      }
      return ref.after === ref.before ? "none" : "observed";
    case "mcp":
      // A line with this call's own id is the call running, whatever came back to the model.
      if (ref.loggedFor.length > 0) return "observed";
      return ref.unaccountedLines === 0 ? "none" : "indeterminate";
    case "shell":
      if (ref.matching > 0) return "observed";
      return ref.unaccountedLines === 0 ? "none" : "indeterminate";
    case "read":
      if (!ref.token) return "indeterminate";
      if (ref.inOwnResult) return "observed";
      return ref.ownResult && !ref.inOtherResult ? "none" : "indeterminate";
    default:
      return "indeterminate";
  }
}
