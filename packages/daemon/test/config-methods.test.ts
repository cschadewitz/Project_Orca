/**
 * `config.get`, `config.set` and `config.changed` over a real config directory on disk
 * (#174, #266).
 *
 * A temp directory rather than a mocked filesystem: the whole of what these methods are
 * about is bytes, revisions and atomic replacement, and a fake `fs` would agree with
 * whatever this file assumed. The two documents are written and read back the way `orca
 * serve` would find them.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { recordAlwaysDecision, readPermissionPolicyFile } from "@orca/agents";
import { DEFAULT_PERMISSION_POLICY, FakeClock } from "@orca/core";
import {
  CONFIG_CHANGED,
  CONFIG_GET_METHOD,
  CONFIG_SET_METHOD,
  ConfigGetResultSchema,
  ConfigSetResultSchema,
  HelloResultSchema,
  parseNotification,
  type NotificationMessage,
} from "@orca/protocol";
import {
  ConfigModel,
  Subscription,
  describeConfigSchema,
  dispatch,
  dottedPath,
  methodsFor,
  splitPath,
  type MethodContext,
} from "@orca/daemon";
import { emptyFixture, type Fixture } from "./fixture.js";

const CONFIG_WITH_COMMENT = `version: 1
storeDir: .orca

# Keep me: a patch write that eats this comment is the bug this file exists for.
hosts:
  - { id: local, type: local }
  - { id: build, type: ssh, host: build.example }

agents:
  - id: claude
    command: claude-code
    permissions:
      default: ask
      rules:
        - match: { kind: execute, titlePattern: "^npm test$" }
          decision: allow
  # No permissions block at all: everything it gets is the #140 default layer.
  - id: codex
    command: codex
`;

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A config directory with `orca.config.yaml` in it, unless `bare` says otherwise. */
async function workspace(
  opts: { bare?: boolean } = {},
): Promise<{ dir: string; model: ConfigModel; clock: FakeClock }> {
  const dir = await mkdtemp(join(tmpdir(), "orca-config-"));
  dirs.push(dir);
  const configFile = join(dir, "orca.config.yaml");
  if (!opts.bare) await writeFile(configFile, CONFIG_WITH_COMMENT, "utf8");
  const clock = new FakeClock(Date.UTC(2026, 8, 21, 12, 0, 0));
  const model = new ConfigModel({
    configDir: dir,
    ...(opts.bare ? {} : { configFile }),
    clock,
  });
  return { dir, model, clock };
}

describe("config.get", () => {
  it("returns both documents, each with its own path and revision", async () => {
    const { dir, model } = await workspace();
    await writeFile(join(dir, "orca.permissions.json"), `{ "version": 1, "agents": {} }\n`, "utf8");

    const result = ConfigGetResultSchema.parse(await model.get());

    expect(result.config.path).toBe(join(dir, "orca.config.yaml"));
    expect(result.config.exists).toBe(true);
    expect(result.config.text).toBe(CONFIG_WITH_COMMENT);
    expect(result.permissions.path).toBe(join(dir, "orca.permissions.json"));
    expect(result.permissions.exists).toBe(true);
    // Two files, two hashes: a client can hold a stale revision of one and a fresh one of
    // the other, which is the whole reason they are not one document.
    expect(result.config.revision).not.toBe(result.permissions.revision);
    expect(result.config.revision).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reports a missing sidecar as absent rather than as an error", async () => {
    const { dir, model } = await workspace();
    const result = await model.get();
    expect(result.permissions).toMatchObject({
      exists: false,
      revision: "",
      text: "",
      path: join(dir, "orca.permissions.json"),
    });
  });

  it("names the file a config.set would create when there is none", async () => {
    const { dir, model } = await workspace({ bare: true });
    const result = await model.get();
    expect(result.config).toMatchObject({ exists: false, revision: "", path: join(dir, "orca.config.yaml") });
  });

  it("layers the sidecar's rules after the configured ones, labelled by document", async () => {
    const { dir, model } = await workspace();
    await writeFile(
      join(dir, "orca.permissions.json"),
      JSON.stringify({
        version: 1,
        agents: {
          claude: {
            rules: [
              {
                match: { kind: "edit", pathPrefix: "src" },
                decision: "allow",
                addedAt: "2026-09-20T10:00:00.000Z",
                grantedFor: "Edit src/index.ts",
              },
            ],
          },
        },
      }),
      "utf8",
    );

    const { effective } = await model.get();
    const claude = effective.agents["claude"];

    // Configured first, sidecar second: `effectivePermissionPolicy`'s order, which is the
    // order `decidePermission` matches in (ADR 0009). This agent's config sets `default: ask`,
    // so it has opted out of the #140 default layer and there is no third group (#140).
    expect(claude?.rules.map((r) => r.source)).toEqual(["config", "permissions"]);
    expect(claude?.rules[1]).toMatchObject({ grantedFor: "Edit src/index.ts", addedAt: "2026-09-20T10:00:00.000Z" });
    // The default comes from configuration alone and the sidecar cannot supply one.
    expect(claude?.default).toBe("ask");
  });

  /**
   * #140's first cut folded the default rules into the parsed config, so `config.get` counted
   * them as configured and the Config surface offered to edit rules that are not in any file.
   */
  it("labels the built-in rules `default`, not `config`, for an agent with no permissions block", async () => {
    const { model } = await workspace();
    const { effective } = await model.get();
    const bare = effective.agents["codex"];

    expect(bare?.rules.map((r) => r.source)).toEqual(DEFAULT_PERMISSION_POLICY.rules.map(() => "default"));
    expect(bare?.rules.some((r) => r.source === "config")).toBe(false);
    // A default rule has no provenance to report: nobody wrote it and no file holds it.
    expect(bare?.rules[0]).toEqual({ ...DEFAULT_PERMISSION_POLICY.rules[0], source: "default" });
    expect(bare?.default).toBe("ask");
  });
});

describe("the schema description", () => {
  const schema = describeConfigSchema();
  const at = (path: string) => schema.find((f) => f.path === path);

  it("writes an array's element type once, not per index", () => {
    expect(at("hosts")?.type).toBe("array");
    expect(at("hosts[]")?.type).toBe("object");
    expect(at("hosts[].id")).toMatchObject({ type: "string", required: true });
    expect(schema.some((f) => f.path.startsWith("hosts[0]"))).toBe(false);
  });

  it("flattens a discriminated union and merges its discriminator into one enum", () => {
    // `hosts[]` is `local | ssh`; a form needs one dropdown and both branches' fields.
    expect(at("hosts[].type")).toMatchObject({ type: "enum" });
    expect(at("hosts[].type")?.enum?.sort()).toEqual(["local", "ssh"]);
    expect(at("hosts[].host")?.type).toBe("string");
    // Present in only one branch, so not required in general.
    expect(at("hosts[].host")?.required).toBe(false);
    expect(at("humanInput.mode")?.enum?.sort()).toEqual(["auto", "cli", "pause"]);
  });

  it("carries the schema's defaults so a form can show what a blank field means", () => {
    expect(at("storeDir")).toMatchObject({ type: "string", required: false, default: ".orca" });
    expect(at("roles")?.type).toBe("record");
    expect(at("plugins")).toMatchObject({ type: "array", default: [] });
  });
});

describe("dotted paths", () => {
  it("spell an array index the way a form reads it — #174's done-when", () => {
    expect(dottedPath(["hosts", 1, "transport"])).toBe("hosts[1].transport");
    expect(dottedPath(["agents", 0, "permissions", "rules", 2, "decision"])).toBe(
      "agents[0].permissions.rules[2].decision",
    );
  });

  it("read both spellings back, because a form may send either", () => {
    expect(splitPath("hosts[1].type")).toEqual(["hosts", 1, "type"]);
    expect(splitPath("hosts.1.type")).toEqual(["hosts", 1, "type"]);
  });
});

describe("config.set on the config document", () => {
  it("round-trips a whole-text write", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("config");

    const result = ConfigSetResultSchema.parse(
      await model.set({
        document: "config",
        expectedRevision: before.revision,
        text: "version: 1\nstoreDir: .store\n",
      }),
    );

    expect(result.written).toBe(true);
    expect(result.document.revision).not.toBe(before.revision);
    expect(await readFile(join(dir, "orca.config.yaml"), "utf8")).toBe("version: 1\nstoreDir: .store\n");
    expect((await model.get()).config.text).toBe(result.document.text);
  });

  it("keeps the comments when a patch changes one field", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("config");

    await model.set({
      document: "config",
      expectedRevision: before.revision,
      patch: [{ path: "hosts[1].host", value: "build2.example" }],
    });

    const text = await readFile(join(dir, "orca.config.yaml"), "utf8");
    expect(text).toContain("# Keep me: a patch write that eats this comment is the bug this file exists for.");
    expect(text).toContain("build2.example");
    // And no default materialised: `templates`, `plugins` and the rest are still unsaid.
    expect(text).not.toContain("plugins");
    expect(text).not.toContain("turnTimeoutMs");
  });

  it("deletes a key when a patch entry carries no value", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("config");

    await model.set({ document: "config", expectedRevision: before.revision, patch: [{ path: "storeDir" }] });

    const text = await readFile(join(dir, "orca.config.yaml"), "utf8");
    expect(text).not.toContain("storeDir");
    expect(text).toContain("# Keep me");
  });

  it("creates the file when the workspace has none", async () => {
    const { dir, model } = await workspace({ bare: true });

    const result = await model.set({
      document: "config",
      expectedRevision: "",
      patch: [{ path: "storeDir", value: ".orca" }],
    });

    expect(result.written).toBe(true);
    expect(await readFile(join(dir, "orca.config.yaml"), "utf8")).toContain("storeDir: .orca");
  });

  it("refuses an invalid host and keys the error at its path — #174's done-when", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("config");

    const failure = await model
      .set({
        document: "config",
        expectedRevision: before.revision,
        patch: [{ path: "hosts[1].type", value: "carrier-pigeon" }],
      })
      .then(
        () => undefined,
        (e: unknown) => e as { code: string; details?: { errors?: { path: string }[] } },
      );

    expect(failure?.code).toBe("CONFIG_INVALID");
    // The second host, the field that is wrong: what #175 places the message under.
    expect(failure?.details?.errors?.map((e) => e.path)).toContain("hosts[1].type");
    // And nothing was written: a refusal leaves the file exactly as it was.
    expect(await readFile(join(dir, "orca.config.yaml"), "utf8")).toBe(CONFIG_WITH_COMMENT);
  });

  it("reports rather than throws under validateOnly, and writes nothing", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("config");

    const result = await model.set({
      document: "config",
      expectedRevision: before.revision,
      patch: [{ path: "hosts[1].type", value: "carrier-pigeon" }],
      validateOnly: true,
    });

    expect(result.written).toBe(false);
    expect(result.validation?.errors.map((e) => e.path)).toContain("hosts[1].type");
    expect(await readFile(join(dir, "orca.config.yaml"), "utf8")).toBe(CONFIG_WITH_COMMENT);
  });

  it("refuses a stale revision with CONFIG_STALE and both revisions", async () => {
    const { model } = await workspace();
    const stale = await model.read("config");
    await model.set({ document: "config", expectedRevision: stale.revision, text: "version: 1\n" });

    const failure = await model
      .set({ document: "config", expectedRevision: stale.revision, text: "version: 1\nstoreDir: .other\n" })
      .then(
        () => undefined,
        (e: unknown) => e as { code: string; details?: Record<string, unknown> },
      );

    expect(failure?.code).toBe("CONFIG_STALE");
    expect(failure?.details).toMatchObject({ document: "config", expectedRevision: stale.revision });
    expect(failure?.details?.["actualRevision"]).not.toBe(stale.revision);
  });
});

describe("config.set on the permissions document", () => {
  it("round-trips the sidecar through the writer in @orca/agents", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("permissions");

    const result = await model.set({
      document: "permissions",
      expectedRevision: before.revision,
      text: JSON.stringify({
        version: 1,
        agents: { claude: { rules: [{ match: { kind: "edit", pathPrefix: "src" }, decision: "allow" }] } },
      }),
    });

    expect(result.written).toBe(true);
    const doc = await readPermissionPolicyFile(join(dir, "orca.permissions.json"));
    expect(doc.agents["claude"]?.rules).toHaveLength(1);
    // The writer canonicalises: fixed key order, two-space indent, trailing newline.
    expect(result.document.text.endsWith("\n")).toBe(true);
    expect(result.document.text).toContain(`"match"`);
  });

  it("refuses a document carrying a `default` (ADR 0009)", async () => {
    const { dir, model } = await workspace();
    const before = await model.read("permissions");

    const failure = await model
      .set({
        document: "permissions",
        expectedRevision: before.revision,
        text: JSON.stringify({ version: 1, default: "allow", agents: {} }),
      })
      .then(
        () => undefined,
        (e: unknown) => e as { code: string; details?: { errors?: { path: string; message: string }[] } },
      );

    expect(failure?.code).toBe("CONFIG_INVALID");
    expect(failure?.details?.errors?.map((e) => e.path)).toContain("default");
    expect(failure?.details?.errors?.[0]?.message).toContain("ADR 0009");
    // Nothing written: answering one prompt must not change the answer to every other one.
    await expect(readFile(join(dir, "orca.permissions.json"), "utf8")).rejects.toThrow();
  });

  it("lands beside a concurrent `recordAlwaysDecision` rather than over it", async () => {
    const { dir, model } = await workspace();
    const file = join(dir, "orca.permissions.json");
    await mkdir(dir, { recursive: true });
    const before = await model.read("permissions");

    const always = recordAlwaysDecision({
      file,
      agentId: "codex",
      request: {
        sessionId: "s",
        toolCall: { toolCallId: "t", title: "Edit lib/a.ts", kind: "edit", locations: [{ path: "/work/lib/a.ts" }] },
        options: [],
      } as never,
      decision: "allow",
      workspaceCwd: "/work",
    });
    const operator = model.set({
      document: "permissions",
      expectedRevision: before.revision,
      text: JSON.stringify({
        version: 1,
        agents: { claude: { rules: [{ match: { kind: "read", pathPrefix: "docs" }, decision: "allow" }] } },
      }),
    });
    const [, saved] = await Promise.all([
      always,
      operator.then(
        () => undefined,
        (e: unknown) => e as { code: string },
      ),
    ]);

    // Both writers take the same lock, so the file is never half-written or unparseable, and
    // exactly one of two things happened. Either the operator's save got in first and the
    // grant was appended on top of it, or the grant got in first - in which case the save is
    // a replace of bytes it never saw, and is refused as stale rather than dropping it
    // silently (#266). What must never happen is the third case: a save that lands and takes
    // the grant with it.
    const doc = await readPermissionPolicyFile(file);
    if (saved?.code === "CONFIG_STALE") expect(Object.keys(doc.agents)).toEqual(["codex"]);
    else expect(Object.keys(doc.agents).sort()).toEqual(["claude", "codex"]);
  });

  /**
   * The window the revision compare used to leave open. `config.set` is a *replace*, so a
   * grant appended between the operator's `config.get` and their save is not merged - it is
   * overwritten. The compare is what is supposed to prevent that, and it only can if it
   * happens under the same lock as the write, which is why `expectedRevision` now travels
   * into `replacePermissionPolicyFile` instead of being checked out here (ADR 0009, #266).
   */
  it("refuses a save that would drop a grant recorded after the client read", async () => {
    const { dir, model } = await workspace();
    const file = join(dir, "orca.permissions.json");
    await mkdir(dir, { recursive: true });
    const read = await model.read("permissions");

    // The run answers "always" while the operator's form is open.
    await recordAlwaysDecision({
      file,
      agentId: "codex",
      request: {
        sessionId: "s",
        toolCall: { toolCallId: "t", title: "Edit lib/a.ts", kind: "edit", locations: [{ path: "/work/lib/a.ts" }] },
        options: [],
      } as never,
      decision: "allow",
      workspaceCwd: "/work",
    });

    const failure = await model
      .set({
        document: "permissions",
        expectedRevision: read.revision,
        text: JSON.stringify({
          version: 1,
          agents: { claude: { rules: [{ match: { kind: "read", pathPrefix: "docs" }, decision: "allow" }] } },
        }),
      })
      .then(
        () => undefined,
        (e: unknown) => e as { code: string; details?: Record<string, unknown> },
      );

    expect(failure?.code).toBe("CONFIG_STALE");
    expect(failure?.details).toMatchObject({ document: "permissions", expectedRevision: read.revision });
    expect(failure?.details?.["actualRevision"]).not.toBe(read.revision);
    // And nothing was lost: the grant is still the only thing in the file.
    const doc = await readPermissionPolicyFile(file);
    expect(Object.keys(doc.agents)).toEqual(["codex"]);
    expect(doc.agents["codex"]?.rules).toHaveLength(1);
  });
});

/**
 * The same window, on the YAML. Two saves made against one revision - two people with the
 * Config surface open, or one of them and a script - must not both land: the second is a
 * replace of bytes the first has already replaced, and it wins only by arriving second.
 */
describe("two concurrent config.set on the YAML", () => {
  it("lets exactly one through and tells the other its revision is stale", async () => {
    const { dir, model } = await workspace();
    const read = await model.read("config");

    const results = await Promise.allSettled(
      [".one", ".two"].map((storeDir) =>
        model.set({ document: "config", expectedRevision: read.revision, patch: [{ path: "storeDir", value: storeDir }] }),
      ),
    );

    const written = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(written).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect((refused[0] as PromiseRejectedResult).reason).toMatchObject({ code: "CONFIG_STALE" });

    // One whole write on disk, not two interleaved ones - and the comment still in it.
    const text = await readFile(join(dir, "orca.config.yaml"), "utf8");
    expect(text).toContain("# Keep me");
    expect([".one", ".two"]).toContain(parseOrcaConfigStoreDir(text));
  });
});

/** `storeDir:` as the file now spells it, without parsing the whole config. */
function parseOrcaConfigStoreDir(text: string): string | undefined {
  return /^storeDir:\s*(\S+)\s*$/m.exec(text)?.[1];
}

describe("the method table", () => {
  let fixture: Fixture;

  async function ctx(opts: { readOnly: boolean }): Promise<MethodContext> {
    fixture = emptyFixture();
    const { model } = await workspace();
    return {
      orcaVersion: "0.1.0-test",
      capabilities: opts.readOnly ? ["runs.read"] : ["runs.read", "runs.control"],
      reads: { runsList: () => ({}) } as never,
      config: model,
      ...(opts.readOnly ? {} : { control: {} as never }),
    };
  }

  const hello = async (context: MethodContext) =>
    HelloResultSchema.parse(
      JSON.parse(
        JSON.stringify(
          (
            (await dispatch(
              JSON.stringify({
                kind: "request",
                id: 1,
                method: "hello",
                params: { client: "test", protocol: { major: 1, minor: 7 } },
              }),
              methodsFor(context),
              context,
            )) as { result: unknown }
          ).result,
        ),
      ),
    );

  it("advertises config.get on a read-only daemon and config.set only with control", async () => {
    const readOnly = await hello(await ctx({ readOnly: true }));
    expect(readOnly.methods).toContain(CONFIG_GET_METHOD);
    expect(readOnly.methods).not.toContain(CONFIG_SET_METHOD);

    const writing = await hello(await ctx({ readOnly: false }));
    expect(writing.methods).toContain(CONFIG_GET_METHOD);
    expect(writing.methods).toContain(CONFIG_SET_METHOD);
    expect(fixture).toBeDefined();
  });

  it("answers `unknown method` for config.set on a read-only daemon, not a refusal", async () => {
    const context = await ctx({ readOnly: true });
    const answer = (await dispatch(
      JSON.stringify({ kind: "request", id: 2, method: CONFIG_SET_METHOD, params: {} }),
      methodsFor(context),
      context,
    )) as { ok: boolean; error?: { code: string } };
    expect(answer.ok).toBe(false);
    expect(answer.error?.code).toBe("PROTOCOL_METHOD");
  });
});

describe("config.changed", () => {
  it("reaches a store-wide subscriber, with no runId and no seq", async () => {
    const fixture = emptyFixture();
    const { model } = await workspace();
    const frames: NotificationMessage[] = [];
    const subscription = new Subscription({
      id: "sub-1",
      params: {},
      source: fixture.orchestrator,
      send: (message) => frames.push(message),
      config: model,
    });
    await subscription.start();

    const before = await model.read("config");
    await model.set({ document: "config", expectedRevision: before.revision, text: "version: 1\n" });
    subscription.stop();

    const pushed = frames.map((f) => parseNotification(f)).filter((n) => n?.method === CONFIG_CHANGED);
    expect(pushed).toHaveLength(1);
    const params = pushed[0]?.params as { document: string; revision: string; path: string; at: string };
    expect(params.document).toBe("config");
    expect(params.revision).not.toBe(before.revision);
    expect(params).not.toHaveProperty("seq");
    expect(params).not.toHaveProperty("runId");
  });

  it("announces a sidecar ORCA wrote itself, not only one an operator wrote", async () => {
    // The path `inputs.answer` with `always` takes: `recordAlwaysDecision` appends under its
    // own lock and knows nothing about subscriptions, so `ControlModel` calls `announce`
    // afterwards. A config screen has to see ORCA's own grants (ADR 0009).
    const fixture = emptyFixture();
    const { dir, model } = await workspace();
    const frames: NotificationMessage[] = [];
    const subscription = new Subscription({
      id: "sub-3",
      params: {},
      source: fixture.orchestrator,
      send: (message) => frames.push(message),
      config: model,
    });
    await subscription.start();

    await recordAlwaysDecision({
      file: join(dir, "orca.permissions.json"),
      agentId: "claude",
      request: {
        sessionId: "s",
        toolCall: { toolCallId: "t", title: "Edit lib/a.ts", kind: "edit", locations: [{ path: "/work/lib/a.ts" }] },
        options: [],
      } as never,
      decision: "allow",
      workspaceCwd: "/work",
    });
    await model.announce("permissions");
    subscription.stop();

    const pushed = frames.map((f) => parseNotification(f)).filter((n) => n?.method === CONFIG_CHANGED);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.params).toMatchObject({ document: "permissions", path: join(dir, "orca.permissions.json") });
    expect((pushed[0]?.params as { revision: string }).revision).not.toBe("");
  });

  it("does not reach a subscription scoped to one run", async () => {
    const fixture = emptyFixture();
    const { model } = await workspace();
    const frames: NotificationMessage[] = [];
    const subscription = new Subscription({
      id: "sub-2",
      params: { runId: "run-1" },
      source: fixture.orchestrator,
      send: (message) => frames.push(message),
      config: model,
    });
    await subscription.start();

    const before = await model.read("config");
    await model.set({ document: "config", expectedRevision: before.revision, text: "version: 1\n" });
    subscription.stop();

    expect(frames.filter((f) => f.method === CONFIG_CHANGED)).toHaveLength(0);
  });
});
