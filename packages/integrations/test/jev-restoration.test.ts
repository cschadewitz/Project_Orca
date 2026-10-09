/** JEV descriptor and credential binding contracts with injected collaborators. */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createJevEvalRestorationAdapter,
  createRestorableJevEvalPlugin,
  readJevRestorationDescriptor,
  serializeJevRestorationDescriptor,
  type JevRestorationContext,
  type JevRestorationBridge,
  type JevRestorationDescriptor,
  type JevRestorationResult,
  type JevPluginRestoration,
} from "@orca/integrations";

const KEY = "synthetic-private-value";
const binding = { provider: "typesafe", account: "account-a", reference: "env:TYPESAFE_API_KEY" } as const;
const context = (): JevRestorationContext => ({
  codeIdentity: `sha256:${"a".repeat(64)}`,
  dependencyIdentity: `sha256:${"b".repeat(64)}`,
  credentialBinding: { ...binding },
  resolveCredential: vi.fn(async () => ({ binding: { ...binding }, apiKey: KEY })),
});
const unwrap = <T>(result: JevRestorationResult<T>): T => {
  if (!result.ok) throw new Error(result.reason);
  return result.value;
};
const descriptor = (): JevRestorationDescriptor =>
  unwrap(createJevEvalRestorationAdapter({ model: "jev-1.13.0", env: {} }, context()).capture());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("JEV restoration adapter", () => {
  it("pins only non-secret defaults, including absent model, and keeps node overrides in the workflow", () => {
    const env = {
      ORCA_JEV_MODEL: "jev-1.13.0",
      TYPESAFE_BASE_URL: "https://original.example/",
      TYPESAFE_API_KEY: KEY,
      OTHER_SECRET: KEY,
    };
    const admitted = createJevEvalRestorationAdapter({ env }, context());
    env.ORCA_JEV_MODEL = "jev-2.0.0";
    env.TYPESAFE_BASE_URL = "https://new.example";
    const captured = unwrap(admitted.capture());
    expect(captured.defaults).toEqual({ model: "jev-1.13.0", baseUrl: "https://original.example" });
    const serialized = unwrap(serializeJevRestorationDescriptor(captured));
    expect(serialized).not.toContain(KEY);
    expect(serialized).not.toContain("OTHER_SECRET");
    expect(serialized).not.toContain("questions");
    captured.defaults.model = "jev-9.0.0";
    expect(unwrap(admitted.capture()).defaults.model).toBe("jev-1.13.0");
    expect(unwrap(createJevEvalRestorationAdapter({ env: {} }, context()).capture()).defaults.model).toBeNull();
  });

  it.each([
    undefined,
    null,
    {},
    { schemaVersion: 0 },
    { schemaVersion: 2 },
    { ...descriptor(), apiKey: KEY },
    { ...descriptor(), defaults: { model: "jev-latest", baseUrl: "https://api.typesafe.ai" } },
    { ...descriptor(), defaults: { model: "jev-preview", baseUrl: "https://api.typesafe.ai" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "https://user:private@example.com" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "https://example.com?key=private" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "https://example.com/#private" } },
    { ...descriptor(), defaults: { model: null, baseUrl: "file:///private" } },
    { ...descriptor(), codeIdentity: "unknown" },
    { ...descriptor(), unknown: "x".repeat(16_384) },
  ])("refuses malformed/legacy/unsupported records without leaking input (%#)", (record) => {
    const result = createJevEvalRestorationAdapter({ env: {} }, context()).restore(record);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(JSON.stringify(result)).not.toContain("private");
  });

  it.each(["codeIdentity", "dependencyIdentity"] as const)("refuses changed %s before credentials or HTTP", (field) => {
    const authority = context();
    const record = descriptor();
    record[field] = `sha256:${"c".repeat(64)}`;
    expect(createJevEvalRestorationAdapter({ env: {} }, authority).restore(record)).toMatchObject({
      ok: false,
      reason: "identity-incompatible",
    });
    expect(authority.resolveCredential).not.toHaveBeenCalled();
  });

  it.each([{ provider: { evaluate: vi.fn() } }, { apiKey: KEY }])(
    "classifies arbitrary callbacks and inline secrets as non-restorable (%#)",
    (options) => {
      const adapter = createJevEvalRestorationAdapter(options, context());
      expect(adapter.capture()).toMatchObject({ ok: false, reason: "options-unsupported" });
      expect(adapter.restore(descriptor())).toMatchObject({ ok: false, reason: "options-unsupported" });
    },
  );

  it("requires explicit current binding metadata and resolver", () => {
    const missing = context();
    delete missing.credentialBinding;
    expect(createJevEvalRestorationAdapter({ env: {} }, missing).capture()).toMatchObject({
      reason: "binding-unavailable",
    });
    expect(createJevEvalRestorationAdapter({ env: {} }, missing).restore(descriptor())).toMatchObject({
      reason: "binding-unavailable",
    });
    const noResolver = context();
    delete noResolver.resolveCredential;
    expect(createJevEvalRestorationAdapter({ env: {} }, noResolver).capture()).toMatchObject({
      reason: "binding-unavailable",
    });
    const changed = context();
    changed.credentialBinding = { ...binding, account: "account-b" };
    expect(createJevEvalRestorationAdapter({ env: {} }, changed).restore(descriptor())).toMatchObject({
      reason: "binding-incompatible",
    });
  });

  it("requires a bridge and exposes the supported executor with no eager credential read", () => {
    const attach = vi.fn<JevRestorationBridge["attach"]>((plugin, _adapter) => plugin);
    const authority = context();
    const plugin = createRestorableJevEvalPlugin({ env: {} }, authority, { attach });
    expect(plugin.name).toBe("jev-eval");
    expect(attach).toHaveBeenCalledTimes(1);
    const adapter = attach.mock.calls[0]?.[1];
    expect(adapter).toBeDefined();
    expect(authority.resolveCredential).not.toHaveBeenCalled();
    expect(() => createRestorableJevEvalPlugin({ apiKey: KEY }, authority, { attach })).toThrow(/options-unsupported/);
  });

  it("maps capture/validation/isolated registration to #394's published provisional hook", async () => {
    const authority = context();
    const plugin = createRestorableJevEvalPlugin({ model: "jev-1.13.0", env: {} }, authority) as ReturnType<
      typeof createRestorableJevEvalPlugin
    > & { restoration: JevPluginRestoration };
    const hook = plugin.restoration;
    expect(hook.identity).toEqual({
      id: "jev-eval",
      schemaVersion: 1,
      codeVersion: authority.codeIdentity,
      dependencyIdentity: authority.dependencyIdentity,
    });
    const data = await Promise.resolve(hook.capture());
    expect(hook.validate(data)).toBe(true);
    expect(hook.validate({ ...data, schemaVersion: 2 })).toBe(false);
    const register = vi.fn();
    hook.restore(data, { executors: { register } });
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ type: "custom:jev-eval" }));
    expect(() => hook.restore({ ...data, schemaVersion: 2 }, { executors: { register } })).toThrow(
      /schema-unsupported/,
    );
    expect(register).toHaveBeenCalledTimes(1);
    expect(authority.resolveCredential).not.toHaveBeenCalled();
  });

  it("validates descriptor serialization and rejects corrupt or unbounded content", () => {
    const record = descriptor();
    expect(unwrap(readJevRestorationDescriptor(JSON.parse(unwrap(serializeJevRestorationDescriptor(record)))))).toEqual(
      record,
    );
    expect(serializeJevRestorationDescriptor({})).toMatchObject({ ok: false });
    expect(
      readJevRestorationDescriptor({
        toJSON() {
          throw new Error(KEY);
        },
      }),
    ).toMatchObject({ ok: false });
    expect(
      readJevRestorationDescriptor({
        get schemaVersion() {
          throw new Error(KEY);
        },
      }),
    ).toMatchObject({ ok: false });
  });
});
