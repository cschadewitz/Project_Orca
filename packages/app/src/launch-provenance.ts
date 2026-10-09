/** Safe projection helpers shared by main and the renderer; no input values or runtime imports. */
import type { LaunchSelectionProvenance } from "./configuration-launch-contract.js";

export function launchSelectionProvenance(result: LaunchSelectionProvenance): LaunchSelectionProvenance | undefined {
  if (result.selections === undefined && result.itemWorkflow === undefined && result.templatePack === undefined)
    return undefined;
  return {
    ...(result.selections === undefined ? {} : { selections: result.selections }),
    ...(result.itemWorkflow === undefined ? {} : { itemWorkflow: result.itemWorkflow }),
    ...(result.templatePack === undefined ? {} : { templatePack: result.templatePack }),
  };
}

export function launchSelectionLines(provenance: LaunchSelectionProvenance): string[] {
  return [
    ...(provenance.selections ?? []).flatMap((selection) => [
      `${selection.nodeId}: agent ${selection.agent.value} (${selection.agent.source})${selection.role ? `; role ${selection.role}` : ""}.`,
      ...(selection.model
        ? [`${selection.nodeId}: model ${selection.model.value} (${selection.model.source}).`]
        : [`${selection.nodeId}: model provenance is unavailable for this review.`]),
      ...(selection.template
        ? [
            `${selection.nodeId}: instruction ${selection.template.value}${selection.template.revision ? ` / ${selection.template.revision}` : ""} (${selection.template.source}).`,
          ]
        : []),
    ]),
    ...(provenance.itemWorkflow
      ? [`Item workflow ${provenance.itemWorkflow.value} (${provenance.itemWorkflow.source}).`]
      : []),
    ...(provenance.templatePack
      ? [`Template pack ${provenance.templatePack.value} (${provenance.templatePack.source}).`]
      : []),
  ];
}
