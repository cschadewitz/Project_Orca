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
  // Capability selections (#335) name catalog entries; an agent's scope may also name its own
  // inline MCP servers.
  const selection =
    /^(capabilities\.workspace|agents\.\[\]\.capabilities)\.(mcpServers|skills)\.(replace|enable|disable|available)\.\[\]$/.exec(
      spelling,
    );
  if (selection) {
    const kind = selection[2] as "mcpServers" | "skills";
    const catalog = isObject(value.capabilities) ? value.capabilities[kind] : undefined;
    choices = isObject(catalog) ? Object.keys(catalog) : [];
    if (kind === "mcpServers" && path[0] === "agents") {
      const agent = Array.isArray(value.agents) ? value.agents[Number(path[1])] : undefined;
      if (isObject(agent) && Array.isArray(agent.mcpServers))
        choices = [
          ...choices,
          ...agent.mcpServers.flatMap((server) =>
            isObject(server) && typeof server.name === "string" ? [server.name] : [],
          ),
        ];
    }
  }
  return choices ? [...new Set(choices)].sort() : undefined;
}
