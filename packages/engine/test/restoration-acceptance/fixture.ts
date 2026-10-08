/** Synthetic fixtures only. Every config, plugin, input and store belongs to a fresh test root. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

export const canaries = ["fixture-credential-canary-396", "fixture-sensitive-input-396"];
export const pluginKinds = [
  "builtin",
  "noop",
  "declarative",
  "executor",
  "host-exec",
  "host-fs",
  "workspace",
  "plan",
  "builtin-mutation",
] as const;
export type PluginKind = (typeof pluginKinds)[number];
export type AuthorityMode = "owner" | "revoked" | "principal-mismatch" | "workspace-mismatch" | "missing";
export type Action =
  | "park"
  | "restore"
  | "resume"
  | "new"
  | "historical-admit"
  | "inspect"
  | "admit"
  | "admit-lost-response"
  | "execute-admitted"
  | "permission-open"
  | "permission-answer"
  | "hold-lease";
export interface Command {
  action: Action;
  root: string;
  owner: string;
  authority?: AuthorityMode;
}
export interface Receipt {
  runId: string;
  generationId: string;
  inputId?: string;
  admissionId?: string;
}
export interface Report {
  pid: number;
  bootId: string;
  nodeVersion: string;
  runtimeSha256: string;
  outcome: "ok" | "refused" | "response-lost";
  code?: string;
  receipt?: Receipt;
  status?: string;
  recordedModel?: string;
  activeModel?: string;
  recordedWorkspace?: string;
  activeWorkspace?: string;
  workflowVersion?: string;
  workflowName?: string;
  pending?: number;
  runs?: number;
  events?: number;
  provisioned: number;
  providerCalls: number;
  permissionDelivered: number;
  consentWrites: number;
  publicLeak: boolean;
  logLeak: boolean;
  errorLeak: boolean;
}
export interface Fixture {
  root: string;
  owner: string;
  kind: PluginKind;
}
export const containsCanary = (value: unknown): boolean =>
  canaries.some((canary) => (JSON.stringify(value) ?? "").includes(canary));

export async function makeFixture(kind: PluginKind = "builtin"): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "orca-restoration-acceptance-396-"));
  const fixture = { root, owner: randomUUID(), kind };
  await writeFile(join(root, "fixture-owner.json"), JSON.stringify({ owner: fixture.owner }), { mode: 0o600 });
  await mkdir(join(root, "old-workspace"));
  await mkdir(join(root, "new-workspace"));
  await writeFile(join(root, "plugin.mjs"), pluginSource(kind));
  await configure(fixture, "old");
  return fixture;
}

export async function assertOwned(fixture: Pick<Fixture, "root" | "owner">): Promise<void> {
  if (!resolve(fixture.root).startsWith(`${resolve(tmpdir())}/orca-restoration-acceptance-396-`))
    throw new Error("Fixture root is outside its disposable namespace");
  const marker = JSON.parse(await readFile(join(fixture.root, "fixture-owner.json"), "utf8")) as { owner?: unknown };
  if (marker.owner !== fixture.owner) throw new Error("Fixture ownership mismatch");
}

export async function configure(fixture: Fixture, era: "old" | "new"): Promise<void> {
  await assertOwned(fixture);
  await writeFile(
    join(fixture.root, "workflow.yaml"),
    `id: restoration-396
name: ${era} workflow
version: '${era === "old" ? "1" : "2"}'
inputSchema:
  fields:
    secret: {type: string, sensitive: true}
start: s
nodes:
  s: {type: start}
  effect: {type: agent, agent: {role: builder}, prompt: Synthetic deterministic turn, produces: []}
  first: {type: gate, question: '${canaries[0]}', options: [go]}
  second: {type: gate, question: Continue again?, options: [go]}
  done: {type: end}
edges:
  - {from: s, to: effect}
  - {from: effect, to: first}
  - {from: first, to: second}
  - {from: second, to: done}
`,
  );
  await writeFile(
    join(fixture.root, "orca.config.json"),
    JSON.stringify({
      workflows: ["workflow.yaml"],
      templates: [],
      storeDir: "store",
      plugins: fixture.kind === "builtin" ? [] : ["./plugin.mjs"],
      agents: [
        {
          id: "worker",
          command: "must-never-execute",
          defaultModel: `${era}-model`,
          models: [{ id: `${era}-model`, name: "Synthetic model" }],
          env: { TOKEN: canaries[0] },
          permissions: { default: era === "old" ? "allow" : "deny" },
        },
      ],
      roles: { builder: "worker" },
      workspace: { provider: "local", root: `${era}-workspace` },
      humanInput: era === "old" ? { mode: "pause" } : { mode: "auto", option: "go" },
    }),
  );
}

function pluginSource(kind: PluginKind): string {
  const effect = `await import("node:fs/promises").then(fs => fs.appendFile(new URL("effect.marker", import.meta.url), "called\\n"));`;
  const callback = `async () => { ${effect} return {kind:"completed",result:{artifactIds:[],data:{}}}; }`;
  const registration: Record<PluginKind, string> = {
    builtin: "",
    noop: "",
    declarative: 'api.agents.mapRole("builder", "worker");',
    executor: `const captured = api.agents.resolve("worker").agent.defaultModel; api.executors.register({type:"custom:fixture-effect",execute: ${callback}}); void captured;`,
    "host-exec": `api.agents.host("local").exec = ${callback};`,
    "host-fs": `api.agents.host("local").fs.readTextFile = ${callback};`,
    workspace: `api.setWorkspaceProvider({name:"fixture",async provision(){ ${effect} return {hostId:"local",cwd:new URL("old-workspace",import.meta.url).pathname,provider:"fixture"}; }});`,
    plan: "api.plan.addSignalExtractor(() => []);",
    "builtin-mutation": `api.executors.get("custom:plan-register").execute = ${callback};`,
  };
  return `export default {name:"fixture-396",register(api){${registration[kind]}}};\n`;
}

/** Ready-to-bind input data for #543's actual adapter; never exercised as accepted restoration on main. */
export const jevFixtureData = {
  old: { model: "jev-1.13.0", baseUrl: "https://old-provider.example.invalid" },
  new: { model: "jev-2.0.0", baseUrl: "https://new-provider.example.invalid" },
  nodeOverride: "jev-3.0.0",
  credentialBinding: { provider: "typesafe", account: "synthetic-account-396", reference: "fixture:credential-396" },
  codeIdentity: `sha256:${"a".repeat(64)}`,
  dependencyIdentity: `sha256:${"b".repeat(64)}`,
} as const;
export type JevFailure = "none" | "absent" | "revoked" | "account-changed" | "response-lost";

/**
 * Provisional preparation only. Call after the parent binds/reviews both exact heads.
 * Uses createRestorableJevEvalPlugin, never a substitute descriptor or JEV executor.
 */
export async function prepareJevFixture(
  fixture: Fixture,
  era: "old" | "new",
  boundary: "before-evaluation" | "after-evaluation",
  failure: JevFailure = "none",
  nodeOverride = false,
): Promise<void> {
  if (fixture.kind === "builtin") throw new Error("Prepare JEV from a fixture with a plugin entry");
  await configure(fixture, era);
  await writeFile(join(fixture.root, "jev-settings.json"), JSON.stringify({ era, failure }), { mode: 0o600 });
  const adapterModule = pathToFileURL(
    fileURLToPath(new URL("../../../integrations/src/jev/plugin.ts", import.meta.url)),
  ).href;
  const source = `import {createRestorableJevEvalPlugin} from ${JSON.stringify(adapterModule)};
import {appendFile,readFile} from "node:fs/promises";
const data=${JSON.stringify(jevFixtureData)};
const settings=async()=>JSON.parse(await readFile(new URL("jev-settings.json",import.meta.url),"utf8"));
const defaults=data[(await settings()).era];
const binding={...data.credentialBinding};
const trace=async(name,value)=>appendFile(new URL(name,import.meta.url),JSON.stringify(value)+"\\n");
// The exact adapter uses platform fetch; this fixture always intercepts it without opening a socket.
globalThis.fetch=async(url,init)=>{
  const failure=(await settings()).failure;
  const request=JSON.parse(String(init?.body));
  if(![data.old.baseUrl,data.new.baseUrl].some(base=>String(url)===base+"/v1/systemone"))throw new Error("Unexpected synthetic endpoint");
  if(init?.headers?.authorization!=="Bearer "+${JSON.stringify(canaries[0])})throw new Error("Synthetic credential mismatch");
  await trace("provider-trace.jsonl",{endpoint:String(url),model:request.model});
  if(failure==="response-lost")throw new Error("Synthetic response lost after provider effect");
  return Response.json({model:request.model,answers:{accepted:{type:"noul",noul:0.93}}});
};
export default createRestorableJevEvalPlugin({model:defaults.model,baseUrl:defaults.baseUrl,env:{}},{
  codeIdentity:data.codeIdentity,dependencyIdentity:data.dependencyIdentity,credentialBinding:binding,
  resolveCredential:async(recorded,{signal})=>{
    const failure=(await settings()).failure;
    signal.throwIfAborted();
    await trace("credential-trace.jsonl",{resolved:true});
    if(failure==="revoked")throw new Error(${JSON.stringify(canaries[0])});
    return {binding:failure==="account-changed"?{...recorded,account:"different-account"}:recorded,
      apiKey:failure==="absent"?"":${JSON.stringify(canaries[0])}};
  }
});
`;
  await writeFile(join(fixture.root, "plugin.mjs"), source);
  const before = boundary === "before-evaluation";
  await writeFile(
    join(fixture.root, "workflow.yaml"),
    `id: restoration-396
name: ${era} JEV workflow
version: '${era === "old" ? "1" : "2"}'
inputSchema:
  fields:
    secret: {type: string, sensitive: true}
start: s
nodes:
  s: {type: start}
  first: {type: gate, question: Continue?, options: [go]}
  jev:
    type: custom:jev-eval
    inputs: [{kind: review, required: false}]
    rubric: {id: fixture/restoration-396, version: 1}
    questions: {accepted: {type: noul, instructions: Is it accepted?}}
${nodeOverride ? `    model: ${jevFixtureData.nodeOverride}\n` : ""}  second: {type: gate, question: Finish?, options: [go]}
  done: {type: end}
edges:
  - {from: s, to: ${before ? "first" : "jev"}}
${before ? "  - {from: first, to: jev}\n  - {from: jev, to: second}" : "  - {from: jev, to: first}\n  - {from: first, to: second}"}
  - {from: second, to: done}
`,
  );
}
