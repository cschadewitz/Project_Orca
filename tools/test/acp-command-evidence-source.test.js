/** #594 source-loss witness only: no native provider, command execution, or approval acceptance. */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { beforeAll, expect, it } from "vitest";

let stripShellPrefix;
beforeAll(async () => {
  const bytes = await readFile(new URL("./fixtures/codex-acp-594/CommandUtils.ts.txt", import.meta.url));
  expect(bytes.byteLength).toBe(300);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "ca8042763f4bb36a2cbf9641beb647fed95338a4f4f827ddecaeb143b2628890",
  );
  // Import only the digest-checked, reviewed pure helper. Never dispatch these strings.
  const source = stripTypeScriptTypes(bytes.toString("utf8"));
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  ({ stripShellPrefix } = await import(/* @vite-ignore */ moduleUrl));
});

it("collapses distinct shell executables and startup flags into the same presentation", () => {
  const commands = [
    "printf orca-594",
    "/bin/bash -c 'printf orca-594'",
    "/bin/bash -lc 'printf orca-594'",
    "/bin/zsh -c 'printf orca-594'",
    "/bin/sh -c 'printf orca-594'",
  ];
  expect(new Set(commands).size).toBe(5);
  expect(new Set(commands.map(stripShellPrefix))).toEqual(new Set(["printf orca-594"]));
});

it.each(["/usr/bin/bash -c 'printf orca-594'", "python -c 'print(594)'"])(
  "retains the unrecognized wrapper as a control: %s",
  (command) => {
    expect(stripShellPrefix(command)).toBe(command);
  },
);

it("also erases surrounding quotes without a shell prefix", () => {
  expect(stripShellPrefix("'printf orca-594'")).toBe(stripShellPrefix("printf orca-594"));
});

it("leaves embedded text uninterpreted, including a newline", () => {
  const text = "printf first\nprintf second";
  expect(stripShellPrefix(`/bin/bash -lc '${text}'`)).toBe(text);
});
