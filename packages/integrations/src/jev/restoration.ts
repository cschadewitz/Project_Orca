/**
 * Bounded JEV restoration adapter. The injected bridge is provisional pending #394;
 * this module neither activates a runtime generation nor reads ambient credentials.
 * The bridge must protect/authenticate descriptors and verify code/dependency digests.
 */
import { z } from "zod";
import type { NodeExecutor, OrcaPlugin } from "@orca/engine";
import { jevEvalExecutor, type JevEvalOptions } from "./executor.js";
import { DEFAULT_JEV_BASE_URL, JevHttpProvider } from "./http-provider.js";
import { JevProviderError, type JevProvider } from "./types.js";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const label = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9_.:/-]+$/);
const bindingSchema = z.strictObject({ provider: z.literal("typesafe"), account: label, reference: label });
const descriptorSchema = z.strictObject({
  plugin: z.literal("jev-eval"),
  schemaVersion: z.literal(1),
  codeIdentity: digest,
  dependencyIdentity: digest,
  transport: z.literal("typesafe-http-v1"),
  defaults: z.strictObject({
    model: z
      .string()
      .min(1)
      .max(256)
      .regex(/^[a-zA-Z0-9_.:/-]+$/)
      .nullable(),
    baseUrl: z.string().min(1).max(2048),
  }),
  credentialBinding: bindingSchema,
});

export type JevRestorationDescriptor = z.infer<typeof descriptorSchema>;
export type JevCredentialBinding = z.infer<typeof bindingSchema>;
export type JevRestorationReason =
  | "descriptor-invalid"
  | "schema-unsupported"
  | "identity-incompatible"
  | "binding-unavailable"
  | "binding-incompatible"
  | "options-unsupported";
export type JevRestorationResult<T> =
  { ok: true; value: T } | { ok: false; reason: JevRestorationReason; remediation: string };

/** Identities must describe the full adapter/dependency closure, verified by the substrate. */
export interface JevRestorationContext {
  codeIdentity: string;
  dependencyIdentity: string;
  /** Trusted non-secret metadata; an environment variable name alone cannot identify an account. */
  credentialBinding?: JevCredentialBinding;
  /** Current authorized boundary: enforce revocation and return the resolved binding with the key. */
  resolveCredential?: (
    binding: JevCredentialBinding,
    execution: { signal: AbortSignal },
  ) => Promise<{ binding: JevCredentialBinding; apiKey: string }>;
}

export interface JevRestorationAdapter {
  /** Capture only the defaults pinned when this generation's adapter was created. */
  capture(): JevRestorationResult<JevRestorationDescriptor>;
  /** Build an isolated executor, without a provider call or a credential read. */
  restore(descriptor: unknown): JevRestorationResult<NodeExecutor>;
}

/** Provisional #394 injection point: attach must not register unsupported capture results as restorable. */
export interface JevRestorationBridge {
  attach(plugin: OrcaPlugin, adapter: JevRestorationAdapter): OrcaPlugin;
}

/** Structural projection of #394's published provisional hook; the shared owner owns final types. */
export interface JevPluginRestoration {
  identity: { id: string; schemaVersion: number; codeVersion: string; dependencyIdentity: string };
  capture(): Record<string, unknown>;
  validate(data: unknown): boolean;
  restore(data: Record<string, unknown>, api: { executors: { register(executor: NodeExecutor): void } }): void;
}

/** Adapt the bounded implementation to #394's provisional executor-only hook without shared-file edits. */
export function createJevRestorationBridge(context: JevRestorationContext): JevRestorationBridge {
  const identity = {
    id: "jev-eval",
    schemaVersion: 1,
    codeVersion: context.codeIdentity,
    dependencyIdentity: context.dependencyIdentity,
  };
  return {
    attach(plugin, adapter) {
      const restoration: JevPluginRestoration = {
        identity: { ...identity },
        capture() {
          const captured = adapter.capture();
          if (!captured.ok) throw new Error(`JEV restoration ${captured.reason}: ${captured.remediation}`);
          return captured.value;
        },
        validate(data) {
          return adapter.restore(data).ok;
        },
        restore(data, api) {
          const restored = adapter.restore(data);
          if (!restored.ok) throw new Error(`JEV restoration ${restored.reason}: ${restored.remediation}`);
          api.executors.register(restored.value);
        },
      };
      return { ...plugin, restoration };
    },
  };
}

function refuse<T>(reason: JevRestorationReason): JevRestorationResult<T> {
  const remediation: Record<JevRestorationReason, string> = {
    "descriptor-invalid": "Preserve the historical record; supply its intact protected JEV descriptor.",
    "schema-unsupported": "Use a compatible JEV adapter; older records cannot acquire invented defaults.",
    "identity-incompatible": "Use the admitted code and dependency identities; do not substitute current code.",
    "binding-unavailable": "Provide an authorized credential resolver and explicit provider/account binding.",
    "binding-incompatible": "Resolve the recorded provider/account/reference under current authority.",
    "options-unsupported": "Arbitrary providers and inline keys remain non-restorable; use the bound HTTP adapter.",
  };
  return { ok: false, reason, remediation: remediation[reason] };
}

function endpoint(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return undefined;
    // Preserve the provider's path semantics rather than normalize a historical URL silently.
    return value.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function sameBinding(a: JevCredentialBinding, b: JevCredentialBinding): boolean {
  return a.provider === b.provider && a.account === b.account && a.reference === b.reference;
}

/** Pure readability check: reject unknown fields/versions and unsafe endpoint material without echoing it. */
export function readJevRestorationDescriptor(value: unknown): JevRestorationResult<JevRestorationDescriptor> {
  try {
    if (value !== null && typeof value === "object" && "schemaVersion" in value && value.schemaVersion !== 1)
      return refuse("schema-unsupported");
    if (JSON.stringify(value)?.length > 16_384) return refuse("descriptor-invalid");
    const parsed = descriptorSchema.safeParse(value);
    if (!parsed.success) return refuse("descriptor-invalid");
    const descriptor = parsed.data;
    if (endpoint(descriptor.defaults.baseUrl) !== descriptor.defaults.baseUrl) return refuse("descriptor-invalid");
    if (["jev-latest", "jev-preview"].includes(descriptor.defaults.model ?? "")) return refuse("descriptor-invalid");
    return { ok: true, value: descriptor };
  } catch {
    return refuse("descriptor-invalid");
  }
}

export function serializeJevRestorationDescriptor(value: unknown): JevRestorationResult<string> {
  const read = readJevRestorationDescriptor(value);
  return read.ok ? { ok: true, value: JSON.stringify(read.value) } : read;
}

/**
 * Freeze non-secret defaults for one generation. The caller creates a fresh adapter for new
 * admissions; node model/rubric/input overrides remain in the recorded workflow, not here.
 * Raw provider callbacks and inline keys deliberately have no restoration representation.
 */
export function createJevEvalRestorationAdapter(
  options: JevEvalOptions,
  context: JevRestorationContext,
): JevRestorationAdapter {
  const unsupported = options.provider !== undefined || options.apiKey !== undefined;
  const env = options.env ?? process.env;
  const baseUrl = endpoint(options.baseUrl ?? env.TYPESAFE_BASE_URL ?? DEFAULT_JEV_BASE_URL);
  const captured = {
    plugin: "jev-eval",
    schemaVersion: 1,
    codeIdentity: context.codeIdentity,
    dependencyIdentity: context.dependencyIdentity,
    transport: "typesafe-http-v1",
    defaults: { model: options.model ?? env.ORCA_JEV_MODEL ?? null, baseUrl },
    credentialBinding: context.credentialBinding ? { ...context.credentialBinding } : undefined,
  };
  // Copy context metadata too: changing current configuration cannot mutate an admitted adapter.
  const identities = { code: context.codeIdentity, dependencies: context.dependencyIdentity };
  const binding = context.credentialBinding ? { ...context.credentialBinding } : undefined;
  const resolveCredential = context.resolveCredential;

  function capture(): JevRestorationResult<JevRestorationDescriptor> {
    if (unsupported) return refuse("options-unsupported");
    if (!binding || !resolveCredential) return refuse("binding-unavailable");
    return readJevRestorationDescriptor(captured);
  }

  function restore(value: unknown): JevRestorationResult<NodeExecutor> {
    if (unsupported) return refuse("options-unsupported");
    const read = readJevRestorationDescriptor(value);
    if (!read.ok) return read;
    const descriptor = read.value;
    if (descriptor.codeIdentity !== identities.code || descriptor.dependencyIdentity !== identities.dependencies)
      return refuse("identity-incompatible");
    if (!binding || !resolveCredential) return refuse("binding-unavailable");
    if (!sameBinding(descriptor.credentialBinding, binding)) return refuse("binding-incompatible");
    const provider: JevProvider = {
      async evaluate(request, execution) {
        execution.signal.throwIfAborted();
        let resolvedApiKey: string | undefined;
        let bindingMatches: boolean;
        try {
          const credential = await resolveCredential({ ...descriptor.credentialBinding }, execution);
          // Resolver results may be cache-backed objects or accessors. Read and validate
          // them inside the sanitized boundary, then retain only request-scoped primitives.
          const parsedBinding = bindingSchema.safeParse(credential.binding);
          bindingMatches = parsedBinding.success && sameBinding(parsedBinding.data, descriptor.credentialBinding);
          const resolvedKey: unknown = credential.apiKey;
          resolvedApiKey = typeof resolvedKey === "string" && resolvedKey ? resolvedKey : undefined;
        } catch {
          throw new JevProviderError("JEV credential unavailable or revoked; resolve the recorded binding", false);
        }
        execution.signal.throwIfAborted();
        if (!bindingMatches)
          throw new JevProviderError("JEV credential binding changed; resolve the recorded provider/account", false);
        const apiKey = resolvedApiKey;
        if (apiKey === undefined)
          throw new JevProviderError("JEV credential unavailable or revoked; resolve the recorded binding", false);
        try {
          const response = await new JevHttpProvider({
            apiKey,
            baseUrl: descriptor.defaults.baseUrl,
          }).evaluate(request, execution);
          // Refuse an echoed key even in a nominally successful response (e.g. a score legend).
          if (JSON.stringify(response)?.includes(JSON.stringify(apiKey).slice(1, -1)))
            throw new JevProviderError("JEV response contains credential material", false);
          return response;
        } catch (error) {
          if (execution.signal.aborted) throw new JevProviderError("JEV evaluation interrupted", false);
          // A proxy may echo authorization in an error body; never persist transport text.
          throw new JevProviderError(
            "JEV bound HTTP evaluation failed",
            error instanceof JevProviderError && error.retryable,
            error instanceof JevProviderError ? error.status : undefined,
          );
        }
      },
    };
    return {
      ok: true,
      value: jevEvalExecutor({
        provider,
        env: {},
        ...(descriptor.defaults.model !== null ? { model: descriptor.defaults.model } : {}),
      }),
    };
  }

  return { capture, restore };
}
