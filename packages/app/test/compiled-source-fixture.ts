/** Worker-local immutable code only: callers still own every file, process and store. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildSync } from "esbuild";
import { sha256 } from "../src/main/mac-candidate-manifest.js";

export function compiledSourceFixture(root: string, entryPoint: string, controls: readonly string[]) {
  // Build options, runtime, entry and root are fixed for this cache's lifetime. No
  // disk cache can survive a worker, dependency install or runtime replacement.
  const controlPaths = controls.map((path) => resolve(root, path));
  let cached: ReturnType<typeof compile> | undefined;
  function compile() {
    const result = buildSync({
      absWorkingDir: root,
      entryPoints: [entryPoint],
      bundle: true,
      platform: "node",
      format: "esm",
      target: `node${process.versions.node}`,
      tsconfig: resolve(root, "tsconfig.json"),
      banner: {
        js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
      },
      external: ["bufferutil", "utf-8-validate"],
      metafile: true,
      write: false,
      logLevel: "silent",
    });
    const paths = new Set([...controlPaths, ...Object.keys(result.metafile.inputs).map((path) => resolve(root, path))]);
    const inputs = new Map([...paths].map((path) => [path, sha256(readFileSync(path))]));
    // A string cannot be mutated by a fixture that tampers with its own image.
    const source = result.outputFiles[0]!.text;
    const assertCurrent = () => {
      for (const [path, digest] of inputs)
        if (sha256(readFileSync(path)) !== digest) throw new Error("Synthetic source changed before fresh process");
    };
    return Object.freeze({ source, digest: sha256(Buffer.from(source)), assertCurrent });
  }
  return () => {
    if (cached) {
      try {
        cached.assertCurrent();
        return cached;
      } catch {
        // Changed or removed inputs must never select stale compiled bytes. Old
        // fixtures retain their old assertion, so a mid-fixture edit still fails.
        cached = undefined;
      }
    }
    return (cached = compile());
  };
}
