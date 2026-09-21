/**
 * The app's one polite live region (#167, docs/design/50-accessibility-and-keyboard.md).
 *
 * **One, at the top, and no second subscription.** The spec asks for *a* polite live region
 * that announces step transitions and terminal states — singular, because two regions
 * racing to speak is two people talking at once, and a region per surface would announce
 * the same failure twice the moment a run was open beside the Attention list. So it is
 * mounted once by `App` and it listens through the same `NotificationStream` every surface
 * listens through: the stream holds a single bridge subscription for as long as anything is
 * listening (`notifications.ts`), so this adds a listener and not a channel.
 *
 * **It is not where the sentences are decided.** `announcements.ts` is the plain module
 * that folds a frame into a sentence or into nothing, with its own test; this is the twenty
 * lines that put the latest one into the document and keep the element out of the way.
 *
 * **The region holds one sentence, not a log.** A live region that accumulates is a region
 * that re-reads everything it already said, so each announcement replaces the last — which
 * is also what coalesces a burst: when four frames land in one tick, a person hears the
 * state the app ended up in rather than the four it passed through.
 *
 * What it is *not* for: agent output. That is `OutputPane`, which is a `log` region with
 * `aria-live="off"` on purpose — forty lines a second would make the app unusable with a
 * screen reader (rule 11), and this region is the half of that rule that says what a person
 * hears instead.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { useNotifications } from "../notifications-context.js";
import { EMPTY_ANNOUNCER, foldRun, foldStep, type AnnouncerState } from "./announcements.js";

/**
 * The attribute the sweep test finds this by. The app has other polite regions the spec
 * asks for by name — the connection indicator, the banners — so "exactly one announcer" is
 * a claim about this element rather than about `aria-live="polite"` in general.
 */
export const ANNOUNCER_ATTRIBUTE = "data-orca-announcer";

export function Announcer(): JSX.Element {
  const stream = useNotifications();
  const [message, setMessage] = useState("");
  /* The memory of which step is which, off React state: folding a frame must not re-render
     the chrome when the fold decides there is nothing to say, which is most frames. */
  const state = useRef<AnnouncerState>(EMPTY_ANNOUNCER);

  useEffect(() => {
    const off = [
      stream.on("step.changed", (params) => {
        const folded = foldStep(state.current, params);
        state.current = folded.state;
        if (folded.say !== undefined) setMessage(folded.say);
      }),
      stream.on("run.changed", (params) => {
        const say = foldRun(params);
        if (say !== undefined) setMessage(say);
      }),
    ];
    return () => off.forEach((remove) => remove());
  }, [stream]);

  return (
    <div
      className="orca-announcer"
      {...{ [ANNOUNCER_ATTRIBUTE]: "" }}
      role="status"
      aria-live="polite"
      /* The whole sentence every time: the region's text is replaced rather than appended
         to, and a reader told only about the changed words would read half a sentence. */
      aria-atomic="true"
    >
      {message}
    </div>
  );
}
