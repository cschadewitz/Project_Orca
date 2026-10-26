/** #704/#705 pure source witnesses and offline vectors; no provider, hook, shell or policy activation. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { beforeAll, expect, it } from "vitest";

const root = new URL("../../", import.meta.url);
const packet = new URL("docs/preparation/provider-enforcement-704-705/", root);
const sources = new Map();
let pins;
let vectors;
let pi;
let claude;

async function pureModule(source) {
  // Only digest-checked excerpts plus reviewed scaffolding below; no provider imports.
  const code = stripTypeScriptTypes(source);
  const url = `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`;
  return import(/* @vite-ignore */ url);
}

beforeAll(async () => {
  pins = JSON.parse(await readFile(new URL("source-pins.json", packet), "utf8"));
  vectors = JSON.parse(await readFile(new URL("vectors.json", packet), "utf8"));
  for (const excerpt of pins.excerpts) {
    const bytes = await readFile(new URL(excerpt.path, root));
    expect(bytes.byteLength).toBe(excerpt.bytes);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(excerpt.sha256);
    expect(excerpt.revision).toMatch(/^[a-f0-9]{40}$/);
    expect(excerpt.sourceBlobSha).toMatch(/^[a-f0-9]{40}$/);
    sources.set(excerpt.id, bytes.toString("utf8"));
  }

  pi = await pureModule(`
    function snapshotEventHandlers(extensions) { return extensions; }
    // Synthetic environment only. This does not read process.env or any host state.
    function getShellEnv() { return { FIXTURE: "public", PI_SESSION_ID: "old" }; }
    export class FixtureRunner {
      extensions;
      constructor(handlers) { this.extensions = [{ handlers }]; }
      createContext() { return {}; }
      ${sources.get("pi-emit")}
    }
    ${sources.get("pi-spawn")}
    export function finalContext(command, commandPrefix, cwd, ctx, spawnHook) {
      const exposeSessionEnvironment = false;
      ${sources.get("pi-resolve")}
      return spawnContext;
    }
  `);
  claude = await pureModule(`
    // Isolate the real decoder's membership check and argument binding.
    // Parsing/effects are synthetic probes, not the SDK or full native implementation.
    function parseClaudePermissionSelection(response) { return response; }
    export const effects = [];
    function applyClaudePermissionSelection(selection, context) {
      effects.push({ selection, context });
      return { behavior: "allow", updatedInput: context.input };
    }
    ${sources.get("claude-decode")}
  `);
});

it("keeps all qualification vectors non-executing with explicit strict dispositions", () => {
  expect(vectors.execution).toBe("none");
  expect(vectors.authority).toBe("rehearsal-data-only");
  expect(new Set(vectors.cases.map((entry) => entry.id)).size).toBe(vectors.cases.length);
  for (const entry of vectors.cases) {
    expect(sources.has(entry.sourceExcerpt), entry.id).toBe(true);
    expect(["block", "unknown", "unsupported"]).toContain(entry.strictDisposition);
    expect(entry.nextProof.length).toBeGreaterThan(20);
  }
  expect(new Set(vectors.cases.map((entry) => entry.provider))).toEqual(
    new Set(["claude", "codex", "pi", "gemini", "all"]),
  );
  expect(pins.providers.every((provider) => provider.installed === "unknown")).toBe(true);
});

it("demonstrates that later Pi handlers can change the same previously checked input", async () => {
  const event = { input: { command: "printf original" } };
  let checked;
  const runner = new pi.FixtureRunner([
    (call) => {
      checked = structuredClone(call.input);
    },
    (call) => {
      call.input.command = "printf changed";
    },
  ]);
  await expect(runner.emitToolCall(event)).resolves.toBeUndefined();
  expect(checked).toEqual({ command: "printf original" });
  expect(event.input).toEqual({ command: "printf changed" });
});

it("preserves Pi block short-circuit before later handlers", async () => {
  let reached = 0;
  const block = { block: true, reason: "fixture revoked" };
  const runner = new pi.FixtureRunner([
    () => block,
    () => {
      reached++;
    },
  ]);
  await expect(runner.emitToolCall({ input: {} })).resolves.toBe(block);
  expect(reached).toBe(0);
});

it("propagates Pi handler failure rather than converting it into permission", async () => {
  let reached = 0;
  const runner = new pi.FixtureRunner([
    () => {
      throw new Error("checker unavailable");
    },
    () => {
      reached++;
    },
  ]);
  await expect(runner.emitToolCall({ input: {} })).rejects.toThrow("checker unavailable");
  expect(reached).toBe(0);
});

it("shows missing Pi handlers produce no block decision", async () => {
  await expect(new pi.FixtureRunner([]).emitToolCall({ input: {} })).resolves.toBeUndefined();
});

it("preserves Pi prefix and effective context cwd transformations as uninterpreted strings", () => {
  const result = pi.finalContext("printf fixture", "printf prefix", "/fixture/a", { cwd: "/fixture/b" });
  expect(result.command).toBe("printf prefix\nprintf fixture");
  expect(result.cwd).toBe("/fixture/b");
  expect(result.env).toEqual({ FIXTURE: "public" });
});

it("shows Pi spawnHook can change command cwd and environment after prefix resolution", () => {
  const result = pi.finalContext("printf original", undefined, "/fixture/a", undefined, (context) => ({
    ...context,
    command: "printf changed",
    cwd: "/fixture/b",
    env: { FIXTURE: "changed" },
  }));
  expect(result).toEqual({ command: "printf changed", cwd: "/fixture/b", env: { FIXTURE: "changed" } });
});

it("rejects an unoffered Claude option before applying any synthetic effect", () => {
  const before = claude.effects.length;
  expect(() =>
    claude.decodeClaudePermissionResponse({ optionId: "forged" }, "Bash", { command: "printf fixture" }, "tool-a", [
      { optionId: "offered", kind: "allow_once" },
    ]),
  ).toThrow("Permission option was not offered");
  expect(claude.effects).toHaveLength(before);
});

it("passes the original Claude input toolUseID and durable-change object to its effects seam", () => {
  const input = { command: "printf fixture" };
  const changes = { fixture: "separate persistent effect; not an exact-command grant" };
  const result = claude.decodeClaudePermissionResponse(
    { optionId: "offered" },
    "Bash",
    input,
    "tool-b",
    [{ optionId: "offered", kind: "allow_once" }],
    changes,
  );
  const last = claude.effects.at(-1);
  expect(last.context.input).toBe(input);
  expect(last.context.toolUseID).toBe("tool-b");
  expect(last.context.durableChangeSet).toBe(changes);
  expect(result.permissionResult.updatedInput).toBe(input);
});

it("does not equate identical Claude inputs with the same native invocation", () => {
  const input = { command: "printf fixture" };
  for (const id of ["distinct-a", "distinct-b"]) {
    claude.decodeClaudePermissionResponse({ optionId: "offered" }, "Bash", input, id, [{ optionId: "offered" }]);
  }
  expect(claude.effects.slice(-2).map((effect) => effect.context.toolUseID)).toEqual(["distinct-a", "distinct-b"]);
});
