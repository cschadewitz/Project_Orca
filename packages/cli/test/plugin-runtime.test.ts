import { expect, it } from "vitest";
import { captureRuntimeObjects } from "../src/plugin-runtime.js";
it("recognizes unchanged graphs without invoking getters or serializing values", () => {
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  const object = {
    cycle,
    run: () => 1,
    get unsafe() {
      throw new Error("getter must not run");
    },
  };
  expect(captureRuntimeObjects([object, null, 3])()).toBe(false);
});
it.each(["add", "remove", "value", "function", "nested", "prototype", "descriptor", "getter", "map", "set"])(
  "recognizes %s registration changes",
  (mode) => {
    const nested = { callback: () => 1 };
    const object: Record<string, unknown> = {
      field: 1,
      run: () => 1,
      nested,
      map: new Map([["a", 1]]),
      set: new Set([1]),
    };
    const changed = captureRuntimeObjects([object]);
    switch (mode) {
      case "add":
        object.extra = true;
        break;
      case "remove":
        delete object.field;
        break;
      case "value":
        object.field = 2;
        break;
      case "function":
        object.run = () => 2;
        break;
      case "nested":
        nested.callback = () => 2;
        break;
      case "prototype":
        Object.setPrototypeOf(object, { extra: 1 });
        break;
      case "descriptor":
        Object.defineProperty(object, "field", { writable: false });
        break;
      case "getter":
        Object.defineProperty(object, "field", { get: () => 1 });
        break;
      case "map":
        (object.map as Map<string, number>).set("a", 2);
        break;
      case "set":
        (object.set as Set<number>).add(2);
        break;
    }
    expect(changed()).toBe(true);
  },
);
