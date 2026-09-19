/**
 * The placeholder screen, now in React: the same `hello` round trip the static renderer
 * did, rendered through the design system's class layer instead of ad-hoc markup.
 *
 * It exists to prove the whole path end to end — React → preload bridge → main process →
 * daemon — and to be the first thing a real screen replaces (docs/design/60-implementation.md).
 * There is deliberately no state library and no router yet; both are their own decisions.
 */
import { useEffect, useState, type JSX } from "react";
import { CONNECTION_PRESENTATION } from "@orca/design";
import { connectionState, handshakeDetail, type Handshake } from "./connection.js";

export function App(): JSX.Element {
  const [handshake, setHandshake] = useState<Handshake>({ phase: "connecting" });

  useEffect(() => {
    let live = true;
    void window.orca.hello().then((result) => {
      if (live) setHandshake({ phase: "done", result });
    });
    return () => {
      live = false;
    };
  }, []);

  const state = connectionState(handshake);
  const presentation = CONNECTION_PRESENTATION[state];

  return (
    <main className="orca-surface placeholder">
      <h1 className="orca-text-title">ORCA</h1>
      {/* Glyph and word together, never colour alone — docs/design/RULES.md. */}
      <p className={`orca-conn orca-conn--${state}`}>
        <span aria-hidden="true">{presentation.glyph}</span>
        <span>{presentation.word}</span>
      </p>
      <pre className="orca-text-mono-log placeholder__well">{handshakeDetail(handshake)}</pre>
    </main>
  );
}
