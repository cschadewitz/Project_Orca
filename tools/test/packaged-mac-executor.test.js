/** Synthetic executor observations and environment canaries; never native/product acceptance. */
import { spawnSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { inspectMacExecutor, SYSTEM_PATH } from "../packaged-mac/executor-preflight.js";
import { createMacAppEnvironment } from "../packaged-mac/launch-environment.js";

afterEach(() => vi.unstubAllEnvs());

function syntheticExecutor(outputs = ["arm64\n", "26.0.1\n", "25A123\n"]) {
  const run = vi.fn().mockImplementation(async () => ({ stdout: outputs.shift() }));
  return { platform: "darwin", arch: "arm64", run };
}

it.each(["linux", "win32", "unknown"])("blocks %s without invoking any command", async (platform) => {
  const input = syntheticExecutor();
  expect(await inspectMacExecutor({ ...input, platform })).toEqual({
    status: "blocked",
    scope: "executor-only",
    code: "HOST_PLATFORM",
  });
  expect(input.run).not.toHaveBeenCalled();
});

it.each(["x64", "ia32", "unknown"])("blocks tooling architecture %s before system probes", async (arch) => {
  const input = syntheticExecutor();
  expect((await inspectMacExecutor({ ...input, arch })).code).toBe("HARNESS_ARCHITECTURE");
  expect(input.run).not.toHaveBeenCalled();
});

it("bounds absolute system probes, strips inherited injection, and keeps app/daemon/GUI checks open", async () => {
  vi.stubEnv("NODE_OPTIONS", "synthetic-injection-canary");
  vi.stubEnv("PATH", "/synthetic/developer/tools");
  const input = syntheticExecutor();
  expect(await inspectMacExecutor(input)).toEqual({
    status: "observed",
    scope: "executor-only",
    hostArch: "arm64",
    harnessArch: "arm64",
    macOS: "26.0.1",
    macOSBuild: "25A123",
    gui: "not-checked",
    appArch: "not-checked",
    daemonArch: "not-checked",
    candidate: "not-run",
  });
  expect(input.run.mock.calls.map(([command, args]) => [command, args])).toEqual([
    ["/usr/bin/uname", ["-m"]],
    ["/usr/bin/sw_vers", ["-productVersion"]],
    ["/usr/bin/sw_vers", ["-buildVersion"]],
  ]);
  for (const [, , options] of input.run.mock.calls) {
    expect(options).toEqual({
      env: { PATH: SYSTEM_PATH, LANG: "C" },
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024,
      windowsHide: true,
    });
  }
  expect(process.env.NODE_OPTIONS).toBe("synthetic-injection-canary");
});

it("refuses a non-arm64 host observation without further probes", async () => {
  const input = syntheticExecutor(["x86_64\n"]);
  expect((await inspectMacExecutor(input)).code).toBe("HOST_ARCHITECTURE");
  expect(input.run).toHaveBeenCalledTimes(1);
});

it.each([
  ["arm64\n", "latest", "25A123"],
  ["arm64\n", "26.0", "secret/path"],
  ["arm64\n", "26.0\nprivate-text", "25A123"],
  ["arm64\n", "26.0", "x".repeat(33)],
])("refuses malformed OS observations without returning raw data", async (...outputs) => {
  expect(await inspectMacExecutor(syntheticExecutor(outputs))).toEqual({
    status: "blocked",
    scope: "executor-only",
    code: "OS_OBSERVATION",
  });
});

it.each([0, 1, 2])("contains a rejected system probe at stage %s", async (stage) => {
  const input = syntheticExecutor();
  input.run = vi.fn().mockImplementation(async () => {
    if (stage-- === 0)
      throw Object.assign(new Error("synthetic-secret"), { stdout: "private-output", stderr: "private-path" });
    return { stdout: "arm64" };
  });
  expect(await inspectMacExecutor(input)).toEqual({
    status: "blocked",
    scope: "executor-only",
    code: "SYSTEM_OBSERVATION",
  });
});

const paths = { accountHome: "/Users/Disposable α", temporaryDirectory: "/private/tmp/owned-run/Scratch β" };
it("constructs only reviewed app keys and preserves spaces/non-ASCII without inheriting canaries", () => {
  for (const key of [
    "ORCA_DAEMON_URL",
    "ORCA_DAEMON_TOKEN",
    "ORCA_DAEMON_TOKEN_FILE",
    "ORCA_RENDERER_URL",
    "ORCA_WORKSPACE",
    "ORCA_SMOKE_NO_SANDBOX",
    "CSC_LINK",
    "APPLE_API_KEY",
    "NODE_OPTIONS",
    "NODE_PATH",
    "ELECTRON_RUN_AS_NODE",
    "HTTP_PROXY",
    "OPENAI_API_KEY",
  ])
    vi.stubEnv(key, "synthetic-secret-canary");
  const env = createMacAppEnvironment(paths);
  expect(env).toEqual({
    HOME: paths.accountHome,
    TMPDIR: paths.temporaryDirectory,
    PATH: SYSTEM_PATH,
    LANG: "en_US.UTF-8",
    LC_CTYPE: "en_US.UTF-8",
  });
  expect(JSON.stringify(env)).not.toContain("synthetic-secret-canary");
  expect(Object.isFrozen(env)).toBe(true);
  expect(process.env.ORCA_DAEMON_TOKEN).toBe("synthetic-secret-canary");
});

it.each([
  "relative",
  "/",
  "/tmp/../other",
  "/tmp//alias",
  "/tmp/./alias",
  "/tmp/trailing/",
  "/tmp/\nsecret",
  "/tmp/\u0000secret",
  "/tmp/\ud800",
  "a".repeat(4097),
])("refuses invalid directory syntax %j without echoing paths", (accountHome) => {
  expect(() => createMacAppEnvironment({ ...paths, accountHome })).toThrow("[DIRECTORY_SYNTAX]");
});

it.each([
  undefined,
  null,
  {},
  { ...paths, env: { ORCA_WORKSPACE: "override" } },
  { ...paths, locale: "C\nsecret" },
  { ...paths, temporaryDirectory: paths.accountHome },
  { ...paths, temporaryDirectory: "/Users" },
])("refuses missing/extra/unsafe explicit input %j", (input) => {
  expect(() => createMacAppEnvironment(input)).toThrow();
});

it("allows an explicitly chosen locale and scratch inside the disposable account", () => {
  expect(
    createMacAppEnvironment({ ...paths, temporaryDirectory: `${paths.accountHome}/scratch`, locale: "C" }).LANG,
  ).toBe("C");
});

it("the real CLI refuses extra arguments before any system observations", () => {
  const result = spawnSync(process.execPath, ["tools/packaged-mac/executor-preflight.js", "synthetic-private-path"], {
    encoding: "utf8",
    timeout: 5000,
  });
  expect(result.status).toBe(2);
  expect(JSON.parse(result.stderr)).toEqual({ status: "blocked", scope: "executor-only", code: "USAGE" });
  expect(result.stdout).toBe("");
});

it("a real tooling subprocess receives the explicit environment without parent canaries", () => {
  vi.stubEnv("ORCA_DAEMON_TOKEN", "synthetic-secret-canary");
  vi.stubEnv("NODE_OPTIONS", "--require=synthetic-injection-canary");
  const env = createMacAppEnvironment(paths);
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", "console.log(JSON.stringify(process.env))"],
    {
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 8192,
    },
  );
  expect(result.status).toBe(0);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toEqual(env);
  expect(result.stdout).not.toContain("synthetic-secret-canary");
});
