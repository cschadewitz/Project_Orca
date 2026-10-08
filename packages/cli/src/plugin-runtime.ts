/** Detect behavior-bearing plugin registrations before declaring a bootstrap restart-restorable. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readFile } from "node:fs/promises";
import {
  builtinExecutors,
  readPluginRestorationData,
  PluginRestorationIdentitySchema,
  PluginRestorationRecordsSchema,
  pluginRestorationRefusal,
  type OrcaPlugin,
  type PluginRestorationData,
  type PluginRestorationRecord,
  type NodeExecutorRegistry,
  type PluginRestorationIdentityVerifier,
} from "@orca/engine";

export interface LoadedRestorationPlugin {
  spec: string;
  plugin: OrcaPlugin;
  /** Resolved local entry bytes are an additional check, not a dependency identity. */
  entry?: { url: string; digest: string };
  executors: string[];
}

/** v1 requires every plugin in a behavior-bearing generation to opt in. Mixed legacy composition stays bound. */
export async function capturePluginRestoration(
  plugins: readonly LoadedRestorationPlugin[],
  unsupported: boolean,
  verifyIdentity?: PluginRestorationIdentityVerifier,
): Promise<PluginRestorationRecord[] | undefined> {
  if (
    !plugins.length ||
    unsupported ||
    !verifyIdentity ||
    plugins.some(({ plugin, entry }) => !plugin.restoration || !entry)
  )
    return undefined;
  const identities = new Set<string>();
  const records: PluginRestorationRecord[] = [];
  for (const loaded of plugins) {
    const contract = loaded.plugin.restoration!;
    const identity = PluginRestorationIdentitySchema.safeParse(contract.identity);
    if (!identity.success || identities.has(identity.data.id)) throw pluginRestorationRefusal("invalid_descriptor");
    identities.add(identity.data.id);
    try {
      if (
        (await verifyIdentity({ spec: loaded.spec, identity: { ...identity.data }, entry: { ...loaded.entry! } })) !==
        true
      )
        throw pluginRestorationRefusal("identity_unverified");
    } catch {
      throw pluginRestorationRefusal("identity_unverified");
    }
    let data: PluginRestorationData;
    try {
      data = readPluginRestorationData(await contract.capture());
      if (contract.validate(data) !== true) throw pluginRestorationRefusal("invalid_descriptor");
    } catch {
      throw pluginRestorationRefusal("invalid_descriptor");
    }
    records.push({
      contractVersion: 1,
      spec: loaded.spec,
      entryDigest: loaded.entry!.digest,
      identity: identity.data,
      data,
      executors: loaded.executors,
    });
  }
  const parsed = PluginRestorationRecordsSchema.safeParse(records);
  if (!parsed.success) throw pluginRestorationRefusal("invalid_descriptor");
  return parsed.data;
}

/** Validate the entire composition before invoking a single restoration factory. No plugin import/installation here. */
export async function restorePluginExecutors(
  raw: unknown,
  plugins: readonly LoadedRestorationPlugin[],
  verifyIdentity?: PluginRestorationIdentityVerifier,
): Promise<NodeExecutorRegistry> {
  const parsed = PluginRestorationRecordsSchema.safeParse(raw);
  if (!parsed.success) throw pluginRestorationRefusal("invalid_descriptor");
  const records = parsed.data;
  if (records.length !== plugins.length) throw pluginRestorationRefusal("unavailable_plugin");
  const identities = new Set<string>();
  const types = new Set<string>();
  for (const [index, record] of records.entries()) {
    const loaded = plugins[index]!;
    const contract = loaded.plugin.restoration;
    if (loaded.spec !== record.spec || !contract || !loaded.entry) throw pluginRestorationRefusal("unavailable_plugin");
    if (identities.has(record.identity.id)) throw pluginRestorationRefusal("invalid_descriptor");
    identities.add(record.identity.id);
    if (!isDeepStrictEqual(contract.identity, record.identity) || loaded.entry.digest !== record.entryDigest)
      throw pluginRestorationRefusal("incompatible_identity");
    const bytes = await readFile(new URL(loaded.entry.url)).catch(() => undefined);
    if (!bytes || createHash("sha256").update(bytes).digest("hex") !== record.entryDigest)
      throw pluginRestorationRefusal("incompatible_identity");
    try {
      if (
        !verifyIdentity ||
        (await verifyIdentity({ spec: loaded.spec, identity: { ...record.identity }, entry: { ...loaded.entry } })) !==
          true
      )
        throw pluginRestorationRefusal("identity_unverified");
    } catch {
      throw pluginRestorationRefusal("identity_unverified");
    }
    try {
      if (contract.validate(readPluginRestorationData(record.data)) !== true)
        throw pluginRestorationRefusal("invalid_descriptor");
    } catch {
      throw pluginRestorationRefusal("invalid_descriptor");
    }
    for (const type of record.executors) {
      if (types.has(type)) throw pluginRestorationRefusal("invalid_descriptor");
      types.add(type);
    }
  }
  const candidate = builtinExecutors();
  for (const type of candidate.types()) candidate.register({ ...candidate.get(type)! });
  for (const [index, record] of records.entries()) {
    const registered = new Set<string>();
    let accepting = true;
    const api = Object.freeze({
      executors: Object.freeze({
        register: (executor: Parameters<NodeExecutorRegistry["register"]>[0]) => {
          if (!accepting || !record.executors.includes(executor.type) || registered.has(executor.type))
            throw pluginRestorationRefusal("unsupported_registration");
          registered.add(executor.type);
          candidate.register(executor);
          return api.executors;
        },
      }),
    });
    try {
      await plugins[index]!.plugin.restoration!.restore(readPluginRestorationData(record.data), api);
      if (registered.size !== record.executors.length) throw pluginRestorationRefusal("reconstruction_failed");
    } catch {
      throw pluginRestorationRefusal("reconstruction_failed");
    } finally {
      accepting = false;
    }
  }
  // Factories cannot retain a writable registration surface after candidate validation.
  Object.defineProperty(candidate, "register", {
    value: () => {
      throw pluginRestorationRefusal("unsupported_registration");
    },
  });
  Object.freeze(candidate);
  return candidate;
}

interface ObjectState {
  object: object;
  prototype: object | null;
  properties: Map<PropertyKey, PropertyDescriptor>;
  mapEntries?: [unknown, unknown][];
  setEntries?: unknown[];
}
const sharedPrototypes = new Set<object>([
  Object.prototype,
  Function.prototype,
  Array.prototype,
  Map.prototype,
  Set.prototype,
]);
/** Takes no getter calls and does not serialize closures or secrets. */
export function captureRuntimeObjects(roots: readonly unknown[]): () => boolean {
  const states: ObjectState[] = [];
  const seen = new Set<object>();
  const visit = (value: unknown): void => {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    const object = value;
    if (seen.has(object) || sharedPrototypes.has(object)) return;
    seen.add(object);
    const descriptors = Object.getOwnPropertyDescriptors(object);
    const properties = new Map(
      Reflect.ownKeys(descriptors).map((key) => [key, Reflect.get(descriptors, key) as PropertyDescriptor]),
    );
    const state: ObjectState = { object, prototype: Object.getPrototypeOf(object) as object | null, properties };
    if (object instanceof Map) state.mapEntries = [...object.entries()] as [unknown, unknown][];
    if (object instanceof Set) state.setEntries = [...object.values()] as unknown[];
    states.push(state);
    visit(state.prototype);
    for (const descriptor of properties.values()) {
      if ("value" in descriptor) visit(descriptor.value);
      // Inspect getter/setter identities without ever invoking or rebinding them.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      visit(descriptor.get);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      visit(descriptor.set);
    }
    for (const [key, item] of state.mapEntries ?? []) {
      visit(key);
      visit(item);
    }
    for (const item of state.setEntries ?? []) visit(item);
  };
  for (const root of roots) visit(root);
  return () =>
    states.some((state) => {
      if (Object.getPrototypeOf(state.object) !== state.prototype) return true;
      const keys = Reflect.ownKeys(state.object);
      if (keys.length !== state.properties.size) return true;
      for (const [key, before] of state.properties) {
        const after = Object.getOwnPropertyDescriptor(state.object, key);
        if (
          !after ||
          after.configurable !== before.configurable ||
          after.enumerable !== before.enumerable ||
          after.writable !== before.writable ||
          !Object.is(after.value, before.value) ||
          after.get !== before.get ||
          after.set !== before.set
        )
          return true;
      }
      if (state.mapEntries) {
        const after = [...(state.object as Map<unknown, unknown>).entries()];
        if (
          after.length !== state.mapEntries.length ||
          after.some(
            ([key, item], i) => !Object.is(key, state.mapEntries![i]![0]) || !Object.is(item, state.mapEntries![i]![1]),
          )
        )
          return true;
      }
      if (state.setEntries) {
        const after = [...(state.object as Set<unknown>).values()];
        if (after.length !== state.setEntries.length || after.some((item, i) => !Object.is(item, state.setEntries![i])))
          return true;
      }
      return false;
    });
}
