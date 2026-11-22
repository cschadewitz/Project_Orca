/**
 * The preferences on disk: one JSON file, read whole and written whole. Plain Node — no
 * Electron import — so the main process can own an instance and the tests can point one at a
 * temp directory. A missing or unreadable file means defaults, never a crash: losing a theme
 * choice is a shrug, refusing to open the window is not.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { daemonEndpoint } from "../daemon-connection.js";
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
      console.warn("Ignoring invalid app preferences");
    } catch {
      console.warn("Ignoring invalid app preferences");
    }
    return DEFAULT_PREFERENCES;
  }

  /** Main-process only: the renderer's generic preference patch cannot change targets. */
  saveDaemonUrl(url: string | null): void {
    const next = { ...this.read() };
    delete next.daemonProfile;
    if (url === null) delete next.daemonUrl;
    else next.daemonUrl = daemonEndpoint(url);
    this.persist(next);
  }

  /** Main-process only: a saved SSH profile replaces a saved URL (#874). */
  saveDaemonProfile(id: string | null): void {
    const next = { ...this.read() };
    delete next.daemonUrl;
    if (id === null) delete next.daemonProfile;
    else next.daemonProfile = id;
    this.persist(next);
  }

  private persist(next: Preferences): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(tmp, this.path);
  }

  /** Validate the patch, merge it over what is on disk, write the result, return it. */
  write(patch: unknown): Preferences {
    const next = mergePreferences(this.read(), PreferencesPatchSchema.parse(patch));
    this.persist(next);
    return next;
  }
}
