/** Reference selectors use the unsaved local config and authorized file catalog; no agent probing or defaults. */
import type { TemplateCatalog } from "@orca/protocol";
import type { DocumentPath } from "./structured-form/contracts.js";
import { isObject } from "./structured-form/collection-model.js";
export function configurationReferenceChoices(
  value: unknown,
  catalog: TemplateCatalog | undefined,
  path: DocumentPath,
): readonly string[] | undefined {
  if (!isObject(value)) return undefined;
  const ids = (name: string) =>
    Array.isArray(value[name])
      ? value[name].flatMap((entry) => (isObject(entry) && typeof entry.id === "string" ? [entry.id] : []))
      : [];
  const spelling = path.map((part) => (typeof part === "number" ? "[]" : part)).join(".");
  let choices: readonly string[] | undefined;
  if (spelling === "agents.[].host" || spelling === "agents.[].hostId" || spelling === "workspace.hostId")
    choices = ids("hosts");
  if (path[0] === "roles" && path.length === 2) choices = ids("agents");
  if (spelling === "program.workflow" || spelling === "program.itemWorkflow")
    choices = catalog?.workflows.map((workflow) => workflow.id);
  if (spelling === "agents.[].defaultModel") {
    const agent = Array.isArray(value.agents) ? value.agents[Number(path[1])] : undefined;
    if (isObject(agent) && Array.isArray(agent.models))
      choices = agent.models.flatMap((model) => (isObject(model) && typeof model.id === "string" ? [model.id] : []));
  }
  return choices ? [...new Set(choices)].sort() : undefined;
}
