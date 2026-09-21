/**
 * The way a surface says something in the app's one live region without growing a second
 * one (#167, #175).
 *
 * The announcer folds *notifications* into sentences, which covers everything the daemon
 * pushes — but not everything worth hearing is a push. A write this app made and the
 * daemon took is the person's own action completing, and there is no `config.changed` for
 * "your save was refused" at all. So there is one channel in, and it is deliberately as
 * small as a channel can be: `say` a sentence, `subscribe` to the sentences.
 *
 * It is not React state and does not live in a component. `Announcer` renders the region
 * near the bottom of the chrome and every surface is above it, so a context holding a
 * `useState` setter would re-render the whole chrome on each announcement and would still
 * have to be created somewhere above both. This is created once in `main.tsx`, beside the
 * keyboard map and the layer stack, for the same reason they are.
 *
 * What it must not become is a log. The region holds one sentence (see `announcer.tsx`), so
 * a burst is coalesced by replacement, which is what a person hearing it wants: the state
 * the app ended up in, not the four it passed through.
 */

export interface Announcements {
  /** Say this, replacing whatever the region was saying. Sentence case, no exclamation marks. */
  say: (sentence: string) => void;
  /** Listen. Returns the unsubscribe; the announcer calls it when it unmounts. */
  subscribe: (listener: (sentence: string) => void) => () => void;
}

export function createAnnouncements(): Announcements {
  const listeners = new Set<(sentence: string) => void>();
  return {
    say: (sentence) => {
      // A copy, because a listener may unsubscribe itself while being called.
      for (const listener of [...listeners]) listener(sentence);
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
