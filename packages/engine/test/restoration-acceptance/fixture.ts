/** Synthetic fixtures only. Every config, plugin, input and store belongs to a fresh test root. */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
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
  | "resume-without-answer"
  | "new"
  | "run-new"
  | "restore-current"
  | "historical-admit"
  | "inspect"
  | "admit"
  | "admit-lost-response"
  | "execute-admitted"
  | "permission-open"
  | "permission-answer"
  | "hold-lease";
export type VerificationMode = "verified" | "absent" | "refused" | "throws" | "restore-refused";
export interface Command {
  action: Action;
  root: string;
  owner: string;
  authority?: AuthorityMode;
  verification?: VerificationMode;
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
  restorationReason?: string;
  adapterReason?: "options-unsupported";
  factoryCalls?: number;
  accessorReads?: number;
  descriptorPresent?: boolean;
  executionModels?: string[];
  currentGenerationUnchanged?: boolean;
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
export interface FixtureIdentity {
  id: string;
  schemaVersion: number;
  codeVersion: string;
  dependencyIdentity: string;
}
export interface VerificationRecord {
  spec: string;
  entryDigest: string;
  identity: FixtureIdentity;
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
export type JevFailure =
  | "none"
  | "absent"
  | "revoked"
  | "account-changed"
  | "reference-changed"
  | "provider-changed"
  | "key-accessor"
  | "binding-accessor"
  | "response-lost"
  | "success-echo"
  | "transport-echo"
  | "injected-provider"
  | "inline-key";

/**
 * Deterministic integration fixture for explicitly selected exact implementation heads.
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
  if(failure==="transport-echo")throw new Error(${JSON.stringify(canaries[0])});
  return Response.json({model:failure==="success-echo"?${JSON.stringify(canaries[0])}:request.model,answers:{accepted:{type:"noul",noul:0.93}}});
};
const failure=(await settings()).failure;
export default createRestorableJevEvalPlugin({model:defaults.model,baseUrl:defaults.baseUrl,env:{},...(failure==="injected-provider"?{provider:{evaluate:async()=>{throw new Error("Unsupported provider must never execute");}}}:{}),...(failure==="inline-key"?{apiKey:${JSON.stringify(canaries[0])}}:{})},{
  codeIdentity:data.codeIdentity,dependencyIdentity:data.dependencyIdentity,credentialBinding:binding,
  resolveCredential:async(recorded,{signal})=>{
    const failure=(await settings()).failure;
    signal.throwIfAborted();
    await trace("credential-trace.jsonl",{resolved:true});
    if(failure==="revoked")throw new Error(${JSON.stringify(canaries[0])});
    if(failure==="key-accessor")return {binding:recorded,get apiKey(){throw new Error(${JSON.stringify(canaries[0])});}};
    if(failure==="binding-accessor")return {get binding(){throw new Error(${JSON.stringify(canaries[0])});},apiKey:${JSON.stringify(canaries[0])}};
    return {binding:failure==="reference-changed"?{...recorded,reference:"different-reference"}:failure==="provider-changed"?{...recorded,provider:"different-provider"}:failure==="account-changed"?{...recorded,account:"different-account"}:recorded,
      apiKey:failure==="absent"?"":${JSON.stringify(canaries[0])}};
  }
});
`;
  await writeFile(join(fixture.root, "plugin.mjs"), source);
  await writeFile(
    join(fixture.root, "restoration-verification.json"),
    JSON.stringify([
      {
        spec: "./plugin.mjs",
        entryDigest: createHash("sha256").update(source).digest("hex"),
        identity: {
          id: "jev-eval",
          schemaVersion: 1,
          codeVersion: jevFixtureData.codeIdentity,
          dependencyIdentity: jevFixtureData.dependencyIdentity,
        },
      },
    ]),
    { mode: 0o600 },
  );
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

export type ReconstructionFault =
  | "none"
  | "throw"
  | "omit"
  | "duplicate"
  | "validate-throw"
  | "capture-secret"
  | "capture-closure"
  | "sparse-small"
  | "sparse-huge"
  | "array-property"
  | "capture-accessor"
  | "capture-nonfinite"
  | "capture-prototype"
  | "capture-symbol"
  | "validate-mutate";
export interface RestorationSettings {
  callback?:
    | "host-exec"
    | "host-fs"
    | "workspace"
    | "plan"
    | "plan-direct"
    | "plan-prototype"
    | "plan-nested"
    | "builtin-mutation"
    | "human-input";
  identity?: Partial<FixtureIdentity>;
  composition?: "single" | "pair" | "mixed" | "duplicate-identity";
  fault?: ReconstructionFault;
  secondFault?: ReconstructionFault;
  descriptorData?: Record<string, unknown>;
}

/** Exercise #546's actual executor-only contract through bootstrap; all inputs/effects are fixture-owned. */
export async function prepareRestorationFixture(
  fixture: Fixture,
  era: "old" | "new",
  settings: RestorationSettings = {},
): Promise<void> {
  await configure(fixture, era);
  const source = (second: boolean) => `import {readFile,appendFile} from "node:fs/promises";
const settings=JSON.parse(await readFile(new URL("restoration-settings.json",import.meta.url),"utf8"));
const second=${second};
const fault=second?settings.secondFault:settings.fault;
const identity=second?settings.secondIdentity:settings.identity;
const type=second?"custom:fixture-second":"custom:fixture-eval";
let captured;
const executor=(data)=>({type,execute:async()=>{
  await appendFile(new URL("provider-trace.jsonl",import.meta.url),JSON.stringify({type,model:data.value})+"\\n");
  return {kind:"completed",result:{artifactIds:[],data:{model:data.value}}};
}});
export default {name:identity.id,register(api){
  captured={schema:1,value:settings.value};api.executors.register(executor(captured));
  if(!second)switch(settings.callback){
    case "host-exec":api.agents.host("local").exec=async()=>({code:0,stdout:"",stderr:""});break;
    case "host-fs":api.agents.host("local").fs.readTextFile=async()=>"unrecorded";break;
    case "workspace":api.setWorkspaceProvider({name:"fixture",provision:async()=>({hostId:"local",cwd:new URL("old-workspace",import.meta.url).pathname,provider:"fixture"})});break;
    case "plan":api.plan.addSignalExtractor(()=>[]);break;
    case "plan-direct":api.plan.listPlans=async()=>[{name:settings.value}];break;
    case "plan-prototype":Object.getPrototypeOf(api.plan).listPlans=async()=>[{name:settings.value}];break;
    case "plan-nested":api.plan.stores.plan.plans.list=async()=>[];break;
    case "builtin-mutation":api.executors.get("custom:plan-register").execute=executor(captured).execute;break;
    case "human-input":api.setHumanInput({ask:async()=>undefined});break;
  }
},restoration:{identity,
  capture(){
    if(fault==="sparse-small")return {values:new Array(3)};
    if(fault==="sparse-huge")return {values:new Array(0xffffffff)};
    if(fault==="array-property"){const values=[null];values.extra="unrecorded";return {values};}
    if(fault==="capture-accessor")return {get value(){globalThis.fixture396AccessorReads=(globalThis.fixture396AccessorReads??0)+1;throw new Error(${JSON.stringify(canaries[0])});}};
    if(fault==="capture-nonfinite")return {value:Infinity};
    if(fault==="capture-prototype")return {value:new Date(0)};
    if(fault==="capture-symbol")return {[Symbol("unrecorded")]:"value"};
    if(settings.descriptorData!==undefined)return settings.descriptorData;
    return fault==="capture-secret"?{schema:1,value:${JSON.stringify(canaries[0])}}:fault==="capture-closure"?{schema:1,value:()=>settings.value}:captured;},
  validate(data){
    if(fault==="validate-throw")throw new Error(${JSON.stringify(canaries[0])});
    if(fault==="validate-mutate"){data.value="x".repeat(65537);return true;}
    // These cases intentionally delegate structural limits to the production bounded reader.
    if(settings.descriptorData!==undefined || ["sparse-small","sparse-huge","array-property","capture-accessor","capture-nonfinite","capture-prototype","capture-symbol"].includes(fault))return true;
    return data!==null&&typeof data==="object"&&Object.keys(data).sort().join() === "schema,value"&&data.schema === 1&&/^(old|new)-model$/.test(data.value);
  },
  restore(data,api){
    globalThis.fixture396Factories=(globalThis.fixture396Factories??0)+1;
    if(fault==="omit")return;
    api.executors.register(executor(data));
    if(fault==="duplicate")api.executors.register(executor(data));
    if(fault==="throw")throw new Error(${JSON.stringify(canaries[0])});
  }
}};
`;
  const firstSource = source(false),
    secondSource = source(true);
  await writeFile(join(fixture.root, "plugin.mjs"), firstSource);
  await writeFile(join(fixture.root, "second.mjs"), secondSource);
  await writeFile(join(fixture.root, "legacy.mjs"), 'export default {name:"legacy",register(){}};\n');
  const dependencyIdentity = `sha256:${createHash("sha256")
    .update(await readFile(process.execPath))
    .digest("hex")}`;
  const identity: FixtureIdentity = {
    id: "fixture-396",
    schemaVersion: 1,
    codeVersion: `sha256:${createHash("sha256").update(firstSource).digest("hex")}`,
    dependencyIdentity,
    ...settings.identity,
  };
  const secondIdentity: FixtureIdentity = {
    ...identity,
    id: settings.composition === "duplicate-identity" ? identity.id : "fixture-second-396",
    codeVersion: `sha256:${createHash("sha256").update(secondSource).digest("hex")}`,
  };
  await writeFile(
    join(fixture.root, "restoration-settings.json"),
    JSON.stringify({
      value: `${era}-model`,
      identity,
      secondIdentity,
      callback: settings.callback,
      fault: settings.fault ?? "none",
      secondFault: settings.secondFault ?? "none",
      descriptorData: settings.descriptorData,
    }),
    { mode: 0o600 },
  );
  const pair = settings.composition === "pair" || settings.composition === "duplicate-identity";
  const plugins = [
    "./plugin.mjs",
    ...(pair ? ["./second.mjs"] : settings.composition === "mixed" ? ["./legacy.mjs"] : []),
  ];
  const verification: VerificationRecord[] = [
    { spec: "./plugin.mjs", identity, entryDigest: createHash("sha256").update(firstSource).digest("hex") },
    ...(pair
      ? [
          {
            spec: "./second.mjs",
            identity: secondIdentity,
            entryDigest: createHash("sha256").update(secondSource).digest("hex"),
          },
        ]
      : []),
  ];
  await writeFile(join(fixture.root, "restoration-verification.json"), JSON.stringify(verification), { mode: 0o600 });
  const config = JSON.parse(await readFile(join(fixture.root, "orca.config.json"), "utf8")) as Record<string, unknown>;
  config.plugins = plugins;
  await writeFile(join(fixture.root, "orca.config.json"), JSON.stringify(config));
  // Always park before the custom effect, independently of human-input callback support.
  await writeFile(
    join(fixture.root, "workflow.yaml"),
    `id: restoration-396
name: ${era} restoration workflow
version: '${era === "old" ? "1" : "2"}'
inputSchema:
  fields:
    secret: {type: string, sensitive: true}
start: s
nodes:
  s: {type: start}
  first: {type: gate, question: Continue?, options: [go]}
  effect: {type: custom:fixture-eval}
${pair ? "  effect2: {type: custom:fixture-second}\n" : ""}  done: {type: end}
edges:
  - {from: s, to: first}
  - {from: first, to: effect}
  - {from: effect, to: ${pair ? "effect2" : "done"}}
${pair ? "  - {from: effect2, to: done}\n" : ""}`,
  );
}

export async function providerTrace(
  fixture: Pick<Fixture, "root" | "owner">,
): Promise<{ type?: string; model: string }[]> {
  await assertOwned(fixture);
  const text = await readFile(join(fixture.root, "provider-trace.jsonl"), "utf8").catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return "";
      throw error;
    },
  );
  return text.trim()
    ? text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type?: string; model: string })
    : [];
}
