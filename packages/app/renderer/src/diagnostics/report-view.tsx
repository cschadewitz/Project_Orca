/** Reuse bounded text nodes and clear their data before acknowledging disposal. */
import { useLayoutEffect, useRef, type JSX } from "react";
import { Text } from "../ui/index.js";

export function DiagnosticReportView({ blocks, shown }: { blocks: readonly string[]; shown: boolean }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const pool = useRef<{ span: HTMLSpanElement; text: globalThis.Text }[]>([]);
  useLayoutEffect(() => {
    const pre = host.current?.firstElementChild;
    if (!pre) return;
    for (let index = 0; index < blocks.length; index++) {
      let slot = pool.current[index];
      if (!slot) {
        const span = document.createElement("span");
        span.className = "orca-diagnostics__block";
        const text = document.createTextNode("");
        span.appendChild(text);
        slot = { span, text };
        pool.current.push(slot);
      }
      slot.text.data = blocks[index]!;
      if (slot.span.parentNode !== pre) pre.appendChild(slot.span);
    }
    for (let index = blocks.length; index < pool.current.length; index++) {
      const slot = pool.current[index]!;
      slot.text.data = "";
      slot.span.remove();
    }
  }, [blocks]);
  useLayoutEffect(
    () => () => {
      for (const slot of pool.current) {
        slot.text.data = "";
        slot.span.remove();
      }
      pool.current.length = 0;
    },
    [],
  );
  return (
    <div ref={host} hidden={!shown} className="orca-diagnostics__report">
      <Text
        style="mono-body"
        as="pre"
        tabIndex={0}
        role="region"
        aria-label="Complete exact diagnostic report"
        className="orca-diagnostics__exact"
      />
    </div>
  );
}
