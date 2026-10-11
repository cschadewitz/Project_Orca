/** Shared artifact references for open gates and their retained correction context. */
import type { JSX } from "react";
import type { OpenInputView } from "@orca/protocol";
import { useArtifactPanel } from "../artifacts/panel-context.js";
import { textClass } from "../ui/index.js";

/**
 * The artifacts the decision is about. Chips, not names: each one opens the docked panel at
 * that exact version, because "what am I approving" is a question a person answers by
 * reading the thing rather than by recognising its name.
 */
export function ArtifactRefs({ input, ready }: { input: OpenInputView; ready: boolean }): JSX.Element | null {
  const panel = useArtifactPanel();
  if (!ready) {
    return (
      <p className={`orca-card__hint ${textClass("caption")}`}>The artifacts this decision is about have not loaded.</p>
    );
  }
  if (input.artifacts.length === 0) return null;
  return (
    <div className="orca-card__refs">
      {input.artifacts.map((artifact) => {
        // Truncates at its end inside the chip, whole in its title (`.orca-ref__label`).
        const label = `${artifact.name}@v${artifact.version}`;
        return (
          <button
            key={artifact.id}
            type="button"
            className={`orca-ref ${textClass("mono-id")}`}
            title={label}
            onClick={() => panel.open({ runId: input.runId, name: artifact.name, version: artifact.version })}
          >
            <span className="orca-ref__label">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
