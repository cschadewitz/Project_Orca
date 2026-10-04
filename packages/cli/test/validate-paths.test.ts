/** The validate adapter preserves platform-absolute arguments verbatim at the shared loader boundary. */
import { isAbsolute, join, posix, win32 } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadWorkflows, parseOrcaConfig } from "@orca/core";
import { loadConfig } from "../src/bootstrap.js";
import { commands } from "../src/commands/index.js";

vi.mock("node:path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:path")>();
  return { ...actual, isAbsolute: vi.fn(actual.isAbsolute), join: vi.fn(actual.join) };
});

vi.mock("@orca/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@orca/core")>();
  return {
    ...actual,
    loadWorkflows: vi.fn(async () => new actual.WorkflowRegistry()),
    loadTemplates: vi.fn(async () => new actual.TemplateRegistry()),
  };
});

vi.mock("../src/bootstrap.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/bootstrap.js")>();
  return { ...actual, loadConfig: vi.fn(), loadPlugins: vi.fn() };
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe.each([
  {
    platform: "POSIX",
    paths: posix,
    cwd: "/workspace",
    configDir: "/config",
    absolute: ["/workflows/tiny.yaml", "/workflows/./*.yaml"],
  },
  {
    platform: "Windows",
    paths: win32,
    cwd: "C:\\workspace",
    configDir: "D:\\config",
    absolute: [
      "C:\\workflows\\tiny.yaml",
      "D:\\workflows\\*.yaml",
      "C:/workflows/./*.yaml",
      "\\\\server\\share\\tiny.yaml",
      "\\\\server\\share\\*.yaml",
      "\\workflows\\tiny.yaml",
    ],
  },
])("$platform validate arguments", ({ paths, cwd, configDir, absolute }) => {
  it("preserves absolute files/globs and keeps relative files/globs anchored to cwd", async () => {
    vi.mocked(isAbsolute).mockImplementation(paths.isAbsolute);
    vi.mocked(join).mockImplementation(paths.join);
    vi.mocked(loadConfig).mockResolvedValue({ config: parseOrcaConfig({ templates: [], workflows: [] }), configDir });
    const relative = ["tiny.yaml", "./tiny.yaml", "../workflows/*.yaml"];

    expect(
      await commands.validate!.run({ cwd, positionals: [...absolute, ...relative], flags: {}, out() {}, err() {} }),
    ).toBe(0);

    expect(loadWorkflows).toHaveBeenCalledExactlyOnceWith(
      [...absolute, ...relative.map((file) => paths.join(cwd, file))],
      configDir,
    );
  });
});
