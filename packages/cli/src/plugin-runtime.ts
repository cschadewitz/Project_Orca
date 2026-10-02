/** Detect behavior-bearing plugin registrations before declaring a bootstrap restart-restorable. */
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
