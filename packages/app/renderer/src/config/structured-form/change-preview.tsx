/** Value-free semantic review: private candidate YAML stays inside the authorized editor/session. */
import type { JSX } from "react";
import { Text } from "../../ui/index.js";
import type { ChangeSummary } from "./contracts.js";
import { pathLabel } from "./collection-model.js";

export function ChangePreview({ changes }: { changes: readonly ChangeSummary[] }): JSX.Element {
  return (
    <section aria-label="Configuration change preview">
      <Text style="heading" as="h2">
        Review configuration changes
      </Text>
      <Text style="caption">
        Values are withheld from this summary. Saved configuration requires a separate explicit apply.
      </Text>
      <ol>
        {changes.map((change, index) => (
          <li key={index}>
            <Text style="mono-id">{pathLabel(change.path)}</Text>
            <Text style="caption">{change.kind}</Text>
          </li>
        ))}
      </ol>
    </section>
  );
}
