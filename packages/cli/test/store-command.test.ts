/** `orca store format | carry-forward | sqlite` and the startup refusal that points to it (#566, #339, #897). */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { silentLogger } from "@orca/core";
import { bootstrap } from "../src/bootstrap.js";
import { storeCommand } from "../src/commands/store.js";
import { readStoreFormat, switchStoreToSqlite } from "@orca/store";
import type { CommandContext } from "../src/commands/index.js";

/** The opt-in an earlier draft of the switch read; the shipped command must ignore it. */
const OLD_OPT_IN = "ORCA_IN_PLACE_SQLITE_SWITCH";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
function ctx(cwd: string, positionals: string[]): CommandContext & { lines: string[] } {
  const lines: string[] = [];
  return { cwd, flags: {}, positionals, out: (l) => lines.push(l), err: () => {}, lines };
}
const LOG =
  [
    {
      id: "evt_0",
      seq: 0,
      runId: "run_old",
      at: "2026-01-02T03:04:00.000Z",
      type: "run.created",
      payload: { workflowId: "tiny", workflowVersion: "1", workspace: { hostId: "local", cwd: "/w" }, vars: {} },
    },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n") + "\n";

describe("orca store", () => {
  it("refuses an older store at startup until carry-forward converts it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-command-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);

    await expect(bootstrap({ cwd: dir, logger: silentLogger })).rejects.toMatchObject({
      code: "STORE_FORMAT",
      details: { reason: "CARRYOVER_REQUIRED" },
    });
    const format = ctx(dir, ["format"]);
    expect(await storeCommand(format)).toBe(1);
    expect(format.lines.join("\n")).toContain("orca store carry-forward");

    const carry = ctx(dir, ["carry-forward"]);
    expect(await storeCommand(carry)).toBe(0);
    expect(carry.lines[0]).toMatch(/^carried .* forward from unmarked to .*; backup in .*format-backups/);
    expect(await readFile(join(dir, ".orca", "runs", "run_old.jsonl"), "utf8")).toBe(LOG);
    await bootstrap({ cwd: dir, logger: silentLogger });
    const again = ctx(dir, ["carry-forward"]);
    expect(await storeCommand(again)).toBe(0);
    expect(again.lines[0]).toContain("nothing to do");
  });

  it("refuses to carry forward a desktop app's own store, whose write fence it cannot hold (#897)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-command-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);
    // The app's first-run ownership journal marks the workspace as the app's.
    await mkdir(join(dir, ".orca-first-run-ownership"), { mode: 0o700 });
    await expect(storeCommand(ctx(dir, ["carry-forward"]))).rejects.toMatchObject({
      code: "STORE_FORMAT",
      details: { reason: "APP_OWNED" },
    });
    expect(await readdir(join(dir, ".orca"))).toEqual(["runs"]);
    expect(await readFile(join(dir, ".orca", "runs", "run_old.jsonl"), "utf8")).toBe(LOG);
  });

  it("sqlite import, verify, backup and restore round-trip a store's metadata", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-sqlite-command-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);

    const imported = ctx(dir, ["sqlite", "import"]);
    expect(await storeCommand(imported)).toBe(0);
    expect(imported.lines.join("\n")).toContain("runs       1 (1 new events)");
    const verify = ctx(dir, ["sqlite", "verify"]);
    expect(await storeCommand(verify)).toBe(0);
    expect(verify.lines.at(-1)).toBe("ok");

    const backup = join(dir, "metadata-backup.sqlite");
    expect(await storeCommand(ctx(dir, ["sqlite", "backup", backup]))).toBe(0);
    const fresh = await mkdtemp(join(tmpdir(), "orca-store-sqlite-restore-"));
    dirs.push(fresh);
    await writeFile(join(fresh, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    expect(await storeCommand(ctx(fresh, ["sqlite", "restore", backup]))).toBe(0);
    const restored = ctx(fresh, ["sqlite", "verify"]);
    expect(await storeCommand(restored)).toBe(0);
    expect(restored.lines.find((l) => l.startsWith("counts"))).toContain("runs 1, events 1");
    await expect(storeCommand(ctx(dir, ["sqlite", "nope"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("sqlite switch is not offered yet, and changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-sqlite-switch-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    (await bootstrap({ cwd: dir, logger: silentLogger })).orchestrator.stores.close?.();
    const before = (await readdir(join(dir, ".orca"))).sort();
    const saved = process.env[OLD_OPT_IN];
    // Including the opt-in an earlier draft read: the shipped command has none.
    for (const value of [undefined, "unenforced", "1"]) {
      if (value === undefined) delete process.env[OLD_OPT_IN];
      else process.env[OLD_OPT_IN] = value;
      try {
        await expect(storeCommand(ctx(dir, ["sqlite", "switch"]))).rejects.toMatchObject({
          code: "STORE_FORMAT",
          details: { reason: "SWITCH_REFUSED" },
        });
      } finally {
        if (saved === undefined) delete process.env[OLD_OPT_IN];
        else process.env[OLD_OPT_IN] = saved;
      }
    }
    expect((await readdir(join(dir, ".orca"))).sort()).toEqual(before);
  });

  // The release check's opt-in (tools/legacy-fence), Linux only.
  // The store package's switch (what tools/legacy-fence/switch.js runs), seen from the CLI side.
  it.runIf(process.platform !== "win32")(
    "a store switched by the store package opens on SQLite in the daemon and the CLI from then on",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "orca-store-sqlite-switch-"));
      dirs.push(dir);
      await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
      // Opened once on files (stamps the current format), then given a run.
      (await bootstrap({ cwd: dir, logger: silentLogger })).orchestrator.stores.close?.();
      await mkdir(join(dir, ".orca", "runs"), { recursive: true });
      await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);
      const before = ctx(dir, ["format"]);
      expect(await storeCommand(before)).toBe(0);
      expect(before.lines).toContain("metadata         files");
      expect(await switchStoreToSqlite(join(dir, ".orca"), { appVersion: "0.8.0" })).toMatchObject({
        status: "switched",
      });
      // What a released ORCA opens first is a marker now, not the run log it would write to.
      expect((await readFile(join(dir, ".orca", "runs"), "utf8")).startsWith("{")).toBe(true);
      const after = ctx(dir, ["format"]);
      expect(await storeCommand(after)).toBe(0);
      expect(after.lines).toContain("metadata         SQLite (metadata.sqlite)");
      expect(after.lines.at(-1)).toContain("opens in place");

      // The run log is no longer on disk at all: the daemon has the run from SQLite.
      const app = await bootstrap({ cwd: dir, logger: silentLogger });
      expect(app.orchestrator.stores.capabilities?.backend).toBe("sqlite");
      expect((await app.orchestrator.stores.events.read("run_old")).map((e) => e.type)).toEqual(["run.created"]);
      app.orchestrator.stores.close?.();

      // Nothing to import from files any more.
      await expect(storeCommand(ctx(dir, ["sqlite", "import"]))).rejects.toMatchObject({ code: "CONFIG_INVALID" });

      // Its database lost: startup refuses instead of starting on an empty one.
      for (const name of await readdir(join(dir, ".orca")))
        if (name.startsWith("metadata.sqlite")) await rm(join(dir, ".orca", name));
      await expect(bootstrap({ cwd: dir, logger: silentLogger })).rejects.toMatchObject({
        code: "STORE_FORMAT",
        details: { reason: "METADATA_MISSING" },
      });
      expect((await readdir(join(dir, ".orca"))).filter((n) => n.startsWith("metadata.sqlite"))).toEqual([]);
    },
  );

  it("refuses to switch a desktop app's own store, whose write fence it cannot hold", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-sqlite-switch-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);
    await mkdir(join(dir, ".orca-first-run-ownership"), { mode: 0o700 });
    await expect(storeCommand(ctx(dir, ["sqlite", "switch"]))).rejects.toMatchObject({
      code: "STORE_FORMAT",
      details: { reason: "APP_OWNED" },
    });
    expect(await readdir(join(dir, ".orca"))).toEqual(["runs"]);
  });

  /** A workspace on files with one run, opened once (stamped), and its config file's text. */
  async function fileWorkspace(config: { name: string; text: string } | undefined) {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-convert-"));
    dirs.push(dir);
    if (config) await writeFile(join(dir, config.name), config.text, "utf8");
    (await bootstrap({ cwd: dir, logger: silentLogger })).orchestrator.stores.close?.();
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await writeFile(join(dir, ".orca", "runs", "run_old.jsonl"), LOG);
    return dir;
  }

  it.runIf(process.platform !== "win32")(
    "sqlite convert puts a SQLite store of its own in use, keeping the config's comments, and leaves the old one as it was",
    async () => {
      const text = "# my workspace\nversion: 1 # keep\nworkflows: []\ntemplates: []\n";
      const dir = await fileWorkspace({ name: "orca.config.yaml", text });
      const oldLog = await readFile(join(dir, ".orca", "runs", "run_old.jsonl"), "utf8");
      const converted = ctx(dir, ["sqlite", "convert"]);
      expect(await storeCommand(converted)).toBe(0);
      expect(converted.lines[0]).toBe(
        `converted ${join(dir, ".orca")} into ${join(dir, ".orca-sqlite")} (SQLite metadata)`,
      );
      const config = await readFile(join(dir, "orca.config.yaml"), "utf8");
      expect(config).toContain("# my workspace");
      expect(config).toContain("version: 1 # keep");
      expect(config).toContain("storeDir: .orca-sqlite");
      // The old store: still on files, its run log where it was.
      expect(await readFile(join(dir, ".orca", "runs", "run_old.jsonl"), "utf8")).toBe(oldLog);
      expect((await readStoreFormat(join(dir, ".orca")))?.epoch).not.toContain("sqlite");

      const format = ctx(dir, ["format"]);
      expect(await storeCommand(format)).toBe(0);
      expect(format.lines).toContain(`store            ${join(dir, ".orca-sqlite")}`);
      expect(format.lines).toContain("metadata         SQLite (metadata.sqlite)");
      expect(format.lines).toContain(`converted from   ${join(dir, ".orca")} (unchanged since)`);
      const app = await bootstrap({ cwd: dir, logger: silentLogger });
      expect(app.orchestrator.stores.capabilities?.backend).toBe("sqlite");
      expect((await app.orchestrator.stores.events.read("run_old")).map((e) => e.type)).toEqual(["run.created"]);
      app.orchestrator.stores.close?.();

      // A released ORCA still running on the old store writes there: reported, not merged.
      await writeFile(join(dir, ".orca", "runs", "run_late.jsonl"), LOG.replaceAll("run_old", "run_late"));
      const after = ctx(dir, ["format"]);
      await storeCommand(after);
      expect(after.lines.find((l) => l.startsWith("converted from"))).toContain("CHANGED since");
      // And converting again has nothing to do.
      const again = ctx(dir, ["sqlite", "convert"]);
      expect(await storeCommand(again)).toBe(0);
      expect(again.lines[0]).toContain("nothing to do");
    },
  );

  it.runIf(process.platform !== "win32")("sqlite convert rewrites a JSON config", async () => {
    const json = await fileWorkspace({ name: "orca.config.json", text: '{"version":1,"workflows":[]}' });
    expect(await storeCommand(ctx(json, ["sqlite", "convert"]))).toBe(0);
    expect(JSON.parse(await readFile(join(json, "orca.config.json"), "utf8"))).toEqual({
      version: 1,
      workflows: [],
      storeDir: ".orca-sqlite",
    });
    const app = await bootstrap({ cwd: json, logger: silentLogger });
    expect(app.orchestrator.stores.capabilities?.backend).toBe("sqlite");
    app.orchestrator.stores.close?.();
  });

  it("refuses to convert, before copying anything, without exactly one config", async () => {
    // None: a config is never created, since it could not be taken back.
    const bare = await fileWorkspace(undefined);
    const before = (await readdir(bare)).sort();
    await expect(storeCommand(ctx(bare, ["sqlite", "convert"]))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("no ORCA config"),
    });
    expect((await readdir(bare)).sort()).toEqual(before);

    // Two: which one an ORCA opens depends on how it is started.
    const two = await fileWorkspace({ name: "orca.config.yaml", text: "version: 1\nworkflows: []\ntemplates: []\n" });
    await writeFile(join(two, "orca.config.json"), '{"version":1}', "utf8");
    const both = (await readdir(two)).sort();
    await expect(storeCommand(ctx(two, ["sqlite", "convert"]))).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: expect.stringContaining("orca.config.json"),
    });
    expect((await readdir(two)).sort()).toEqual(both);
    expect(await readFile(join(two, "orca.config.yaml"), "utf8")).not.toContain("sqlite");
  });

  it("refuses to convert a desktop app's own store, and changes nothing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-store-convert-"));
    dirs.push(dir);
    await writeFile(join(dir, "orca.config.yaml"), "version: 1\nworkflows: []\ntemplates: []\n", "utf8");
    await mkdir(join(dir, ".orca", "runs"), { recursive: true });
    await mkdir(join(dir, ".orca-first-run-ownership"), { mode: 0o700 });
    await expect(storeCommand(ctx(dir, ["sqlite", "convert"]))).rejects.toMatchObject({
      code: "STORE_FORMAT",
      details: { reason: "APP_OWNED" },
    });
    expect((await readdir(dir)).sort()).toEqual([".orca", ".orca-first-run-ownership", "orca.config.yaml"]);
  });
});
