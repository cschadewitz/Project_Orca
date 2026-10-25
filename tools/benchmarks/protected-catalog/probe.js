/** Child-local transparent builtin observers; retain counts/times, never paths, keys or plaintext. */
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { basename, dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { unionMs } from "../persistence-baseline/model.js";

export function installProbe() {
  let active;
  const originals = [];
  function record(label, start, extra = {}) {
    if (!active) return;
    const entry = (active[label] ??= { count: 0, bytes: 0, entries: 0, intervals: [] });
    entry.count++;
    entry.bytes += extra.bytes ?? 0;
    entry.entries += extra.entries ?? 0;
    entry.intervals.push([start, performance.now()]);
  }
  function category(path) {
    if (typeof path !== "string" && !Buffer.isBuffer(path)) return "other";
    if (basename(String(path)) === ".execution-key") return "key";
    if (basename(String(path)) === "private-execution") return "catalog";
    if (basename(dirname(String(path))) !== "private-execution") return "other";
    for (const kind of ["inputs", "payload", "generation"]) if (String(path).endsWith(`.${kind}.json`)) return kind;
    if (String(path).includes(".sensitivity.")) return "overlay";
    return "publication";
  }
  function replace(object, method, wrapper) {
    const original = object[method];
    originals.push(() => (object[method] = original));
    object[method] = wrapper(original);
  }
  for (const method of ["readdir", "lstat", "mkdir", "link", "unlink", "open"])
    replace(fs, method, (original) => async (...args) => {
      const start = performance.now();
      let result;
      try {
        result = await original(...args);
        if (method === "open") {
          const kind = category(args[0]);
          for (const name of ["readFile", "writeFile", "stat", "sync", "close"]) {
            const action = result[name];
            result[name] = async function (...values) {
              const begin = performance.now();
              let value;
              try {
                value = await action.apply(this, values);
                return value;
              } finally {
                record(`handle.${name}.${kind}`, begin, {
                  bytes: name === "readFile" && value ? Buffer.byteLength(value) : 0,
                });
              }
            };
          }
        }
        return result;
      } finally {
        record(`fs.${method}.${category(args[0])}`, start, {
          entries: method === "readdir" && result ? result.length : 0,
        });
      }
    });
  for (const [factory, kind, methods] of [
    ["createDecipheriv", "decrypt", ["setAAD", "setAuthTag", "update", "final"]],
    ["createCipheriv", "encrypt", ["setAAD", "update", "final", "getAuthTag"]],
  ])
    replace(crypto, factory, (original) => (...args) => {
      const start = performance.now();
      const object = original(...args);
      record(`crypto.${kind}.create`, start);
      for (const method of methods) {
        const action = object[method];
        object[method] = function (...values) {
          const begin = performance.now();
          try {
            return action.apply(this, values);
          } finally {
            record(`crypto.${kind}.${method}`, begin);
          }
        };
      }
      return object;
    });
  syncBuiltinESMExports();
  return {
    begin() {
      if (active) throw new Error("probe-already-active");
      active = {};
    },
    end() {
      const captured = active;
      active = undefined;
      return Object.fromEntries(
        Object.entries(captured).map(([label, { intervals, ...values }]) => [
          label,
          { ...values, unionMs: unionMs(intervals) },
        ]),
      );
    },
    restore() {
      active = undefined;
      originals.reverse().forEach((restore) => restore());
      syncBuiltinESMExports();
    },
  };
}
