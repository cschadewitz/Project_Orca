/** Focused boundary coverage separated from the mixed suite. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_PREFERENCES, PreferencesSchema } from "../src/preferences/schema.js";
import { PreferencesFile } from "../src/preferences/preferences-file.js";
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
describe("authenticated daemon connection transaction", () => {
  it("round trips the saved URL through restart and clears it for bundled return", async () => {
    const dir = await mkdtemp(join(tmpdir(), "orca-connection-"));
    dirs.push(dir);
    const path = join(dir, "preferences.json");
    const prefs = new PreferencesFile(path);
    prefs.saveDaemonUrl("http://localhost:9999");
    prefs.write({ theme: "dark" });
    expect(new PreferencesFile(path).read().daemonUrl).toBe("http://localhost:9999");
    expect(() => prefs.saveDaemonUrl("https://owner:secret@host")).toThrow();
    expect(await readFile(path, "utf8")).not.toContain("secret");
    prefs.saveDaemonUrl(null);
    expect(new PreferencesFile(path).read().daemonUrl).toBeUndefined();
  });
  it.each(["not-a-url-with-private-token", "https://owner:private-token@host"])(
    "rejects an invalid saved endpoint without disclosing it in diagnostics",
    async (daemonUrl) => {
      const parsed = PreferencesSchema.safeParse({ daemonUrl });
      expect(parsed.success).toBe(false);
      if (parsed.success) throw new Error("Expected invalid preferences to be refused");
      expect(parsed.error.issues).toEqual([
        { code: "custom", path: ["daemonUrl"], message: "Invalid daemon endpoint" },
      ]);
      expect(parsed.error.message).not.toContain(daemonUrl);
      expect(parsed.error.message).not.toContain("private-token");

      const dir = await mkdtemp(join(tmpdir(), "orca-connection-"));
      dirs.push(dir);
      const path = join(dir, "preferences.json");
      await writeFile(path, JSON.stringify({ daemonUrl }));
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(new PreferencesFile(path).read()).toEqual(DEFAULT_PREFERENCES);
        expect(warn).toHaveBeenCalledExactlyOnceWith("Ignoring invalid app preferences");
        expect(JSON.stringify(warn.mock.calls)).not.toContain("private-token");
      } finally {
        warn.mockRestore();
      }
    },
  );
});
