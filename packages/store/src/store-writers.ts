/**
 * Who is writing a store right now, so a change of who owns its metadata can be made with none
 * of them running (#339).
 *
 * The format lock (`.store-format.lock`) serializes opening and stamping a store, but a writer
 * holds it only while it opens: an idle daemon, or a CLI command between two writes, holds a
 * file-backed store without it. So every writer from this ORCA on also *registers* for as long
 * as it has the store open, and a switch of the metadata backend says it is starting before it
 * looks:
 *
 * - a writer publishes an entry in `<store>/.store-writers/` (an atomic rename), then reads
 *   `<store>/.store-switch.json`; if a live switch is under way it withdraws and is refused
 *   (`STORE_FORMAT`, `reason: "SWITCHING"`);
 * - a switch publishes `.store-switch.json`, then lists the entries, and is refused (`BUSY`) while
 *   any entry belongs to a live process, or to a process on another host it cannot check. It
 *   keeps the file until its marker is written.
 *
 * Each side writes before it reads the other's, so at least one of them sees the other: a writer
 * that registered first is seen by the switch, and one that registers later sees the switch (or,
 * once it is over, a store whose marker names the other backend, which both backends refuse).
 *
 * Only a dead process's entry or switch is ignored: same host, and the process is gone. A writer
 * never removes a switch's file; the next switch replaces a dead one. Writers from before this
 * registry cannot take part: the format marker records whether one may have opened the store
 * (`writerRegistry`, store-format.ts), and the switch refuses such a store until the operator
 * states that every older ORCA using it is stopped.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { OrcaError } from "@orca/core";

export const STORE_WRITERS_DIR = ".store-writers";
export const STORE_SWITCH_FILE = ".store-switch.json";

/** What a writer or a switch records about itself. */
export interface StoreWriterEntry {
  pid: number;
  host: string;
  appVersion: string;
  /** What the process opened the store for, for the refusal message: "daemon", "import", ... */
  purpose: string;
  since: string;
}

export interface StoreWriterHold {
  /** Withdraw the registration. Idempotent. */
  release(): void;
}

const held = new Set<string>();
let exitHook = false;

function onExit(): void {
  for (const path of held)
    try {
      unlinkSync(path);
    } catch {
      // Gone already; a dead process's entry is ignored anyway.
    }
  held.clear();
}

function parseEntry(text: string): StoreWriterEntry | undefined {
  try {
    const value = JSON.parse(text) as Partial<StoreWriterEntry>;
    if (typeof value.pid !== "number" || typeof value.host !== "string") return undefined;
    return {
      pid: value.pid,
      host: value.host,
      appVersion: String(value.appVersion ?? "?"),
      purpose: String(value.purpose ?? "?"),
      since: String(value.since ?? "?"),
    };
  } catch {
    return undefined;
  }
}

/** The entry at `path`; `null` when there is none, `undefined` when it cannot be read. */
function readEntry(path: string): StoreWriterEntry | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return undefined;
  }
  return parseEntry(text);
}

const unknown = (purpose: string): StoreWriterEntry => ({
  pid: -1,
  host: "unknown",
  appVersion: "?",
  purpose,
  since: "?",
});

/** False only when the process is provably gone: same host, and no such process. */
export function storeWriterAlive(entry: Pick<StoreWriterEntry, "pid" | "host">): boolean {
  if (entry.host !== hostname()) return true;
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function publish(dir: string, name: string, entry: StoreWriterEntry): string {
  const path = join(dir, name);
  const tmp = `${path}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry) + "\n", { flag: "wx", mode: 0o600 });
  renameSync(tmp, path);
  return path;
}

/** The switch under way on this store, when its process is not provably gone. */
export function activeStoreSwitch(storeDir: string): StoreWriterEntry | undefined {
  const entry = readEntry(join(storeDir, STORE_SWITCH_FILE));
  if (entry === null) return undefined;
  // Unreadable: a switch whose owner cannot be checked, so it is honoured.
  if (entry === undefined) return unknown("switch");
  return storeWriterAlive(entry) ? entry : undefined;
}

/**
 * Register this process as a writer of `storeDir` until {@link StoreWriterHold.release} or exit.
 * Throws `STORE_FORMAT` (`reason: "SWITCHING"`) while a live switch is under way.
 */
export function holdStoreWriter(storeDir: string, who: { appVersion: string; purpose: string }): StoreWriterHold {
  const dir = join(storeDir, STORE_WRITERS_DIR);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = publish(dir, `${process.pid}.${randomUUID()}.json`, {
    pid: process.pid,
    host: hostname(),
    appVersion: who.appVersion,
    purpose: who.purpose,
    since: new Date().toISOString(),
  });
  held.add(path);
  if (!exitHook) {
    exitHook = true;
    process.once("exit", onExit);
  }
  const release = () => {
    if (!held.delete(path)) return;
    rmSync(path, { force: true });
  };
  let active: StoreWriterEntry | undefined;
  try {
    active = activeStoreSwitch(storeDir);
  } catch (error) {
    release();
    throw error;
  }
  if (active) {
    release();
    throw new OrcaError(
      "STORE_FORMAT",
      `${storeDir} is being switched to SQLite metadata by process ${active.pid} on ${active.host}; start again once it is done.`,
      { reason: "SWITCHING", storeDir, switchPid: active.pid, switchHost: active.host },
    );
  }
  return { release };
}

/** Every registered writer of `storeDir` that is not provably gone; dead entries are removed. */
export function liveStoreWriters(storeDir: string): StoreWriterEntry[] {
  const dir = join(storeDir, STORE_WRITERS_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const live: StoreWriterEntry[] = [];
  for (const name of names.sort()) {
    // A registration is published by rename: a `.tmp` is one not published yet, whose writer
    // reads the switch's file next.
    if (!name.endsWith(".json")) continue;
    const path = join(dir, name);
    const entry = readEntry(path);
    if (entry === null) continue;
    if (entry === undefined) {
      live.push(unknown(name));
      continue;
    }
    if (storeWriterAlive(entry)) live.push(entry);
    else rmSync(path, { force: true });
  }
  return live;
}

/**
 * Announce a switch of `storeDir`: from now until `end()`, writers from this ORCA refuse to
 * register. The caller holds the format lock, so a file left here is a dead switch's.
 */
export function beginStoreSwitch(storeDir: string, appVersion: string): { end(): void } {
  const path = publish(storeDir, STORE_SWITCH_FILE, {
    pid: process.pid,
    host: hostname(),
    appVersion,
    purpose: "switch",
    since: new Date().toISOString(),
  });
  return { end: () => rmSync(path, { force: true }) };
}

/**
 * Remove a switch announcement whose process is provably gone (a switch that was killed). Only
 * under the format lock, which every switch holds while its announcement stands.
 */
export function clearDeadStoreSwitch(storeDir: string): void {
  const path = join(storeDir, STORE_SWITCH_FILE);
  const entry = readEntry(path);
  if (entry && !storeWriterAlive(entry)) rmSync(path, { force: true });
}
