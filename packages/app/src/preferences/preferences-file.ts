/**
 * The preferences on disk: one JSON file, read whole and written whole. Plain Node — no
 * Electron import — so the main process can own an instance and the tests can point one at a
 * temp directory. A missing or unreadable file means defaults, never a crash: losing a theme
 * choice is a shrug, refusing to open the window is not.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_PREFERENCES,
  mergePreferences,
  PreferencesPatchSchema,
  PreferencesSchema,
  type Preferences,
} from "./schema.js";

export class PreferencesFile {
  constructor(readonly path: string) {}

  read(): Preferences {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch {
      return DEFAULT_PREFERENCES;
    }
    try {
      const parsed = PreferencesSchema.safeParse(JSON.parse(text));
      if (parsed.success) return parsed.data;
      console.warn(`ignoring ${this.path}: ${parsed.error.message}`);
    } catch (e) {
      console.warn(`ignoring ${this.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return DEFAULT_PREFERENCES;
  }

  /** Validate the patch, merge it over what is on disk, write the result, return it. */
  write(patch: unknown): Preferences {
    const next = mergePreferences(this.read(), PreferencesPatchSchema.parse(patch));
    mkdirSync(dirname(this.path), { recursive: true });
    // Write beside, then rename: a crash mid-write leaves the old file, not half of a new one.
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.path);
    return next;
  }
}
