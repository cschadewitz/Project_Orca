/**
 * The placeholder screen, now in React: the same `hello` round trip the static renderer
 * did, rendered through the design system's class layer instead of ad-hoc markup.
 *
 * It exists to prove the whole path end to end — React → preload bridge → main process →
 * daemon — and to be the first thing a real screen replaces (docs/design/60-implementation.md).
 * There is deliberately no state library and no router yet; both are their own decisions.
 */
import { useEffect, useRef, useState, type JSX } from "react";
import { useSurfaceDensity } from "./appearance-context.js";
import { connectionState, handshakeDetail, type Handshake } from "./connection.js";
import { ConnectionIndicator, Text, Well } from "./ui/index.js";

export function App(): JSX.Element {
  const [handshake, setHandshake] = useState<Handshake>({ phase: "connecting" });
  /* When the attempt started, for the indicator's elapsed reading. A ref, not state: it
     is set once and must not itself cause a render. */
  const startedAt = useRef(new Date());
  // The placeholder is a surface root too, so ⌘⇧D has something to act on.
  useSurfaceDensity();

  useEffect(() => {
    let live = true;
    void window.orca.hello().then((result) => {
      if (live) setHandshake({ phase: "done", result });
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <main className="orca-surface placeholder" data-surface="placeholder" tabIndex={-1}>
      <Text style="title" as="h1">
        ORCA
      </Text>
      {/* Glyph and word together, never colour alone — docs/design/RULES.md. */}
      <ConnectionIndicator state={connectionState(handshake)} since={startedAt.current} />
      <Well label="Handshake result">{handshakeDetail(handshake)}</Well>
    </main>
  );
}
