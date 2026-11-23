/**
 * Which metadata backend a store runs on (#339): files, or the SQLite database at
 * `<store>/metadata.sqlite`. The store records it, and only it decides.
 *
 * The choice is part of the store's format marker (`store-format.json`, store-format.ts): a
 * store switched to SQLite carries {@link SQLITE_STORE_FORMAT_EPOCH} instead of the file
 * format's epoch. That is what keeps one populated workspace from ever being opened by both
 * backends:
 *
 * - an ORCA from before SQLite does not know that epoch, so it refuses the store as newer than
 *   it can open, instead of reading file metadata the switch left behind and has not kept up;
 * - this ORCA's file backend ({@link refuseOtherBackend} in `fileStores`) refuses a store
 *   recorded for SQLite, and its SQLite backend refuses a store recorded for files, unless the
 *   caller is a maintenance tool that builds or checks a database beside the files (an import
 *   before the switch, a backup, a verify) and says so;
 * - the only way from files to SQLite is `switchStoreToSqlite` (store-format.ts): an offline,
 *   verified backup, an import, a verify, and only then the marker.
 *
 * Kept free of other store imports so both backends can check it synchronously at open.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OrcaError } from "@orca/core";

export const STORE_FORMAT_FILE = "store-format.json";

/**
 * The format of a store whose metadata is in SQLite: the current file format's epoch with the
 * backend named, so that a later change to the file format needs a SQLite epoch of its own too.
 * A test holds it to `${STORE_FORMAT_EPOCH}-sqlite`.
 */
export const SQLITE_STORE_FORMAT_EPOCH = "operator-journals-v4-sqlite";

export type StoreBackend = "file" | "sqlite";

export function backendOfEpoch(epoch: string): StoreBackend {
  return epoch === SQLITE_STORE_FORMAT_EPOCH ? "sqlite" : "file";
}

function recordedMarker(dir: string): { epoch?: unknown; sqliteId?: unknown } | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, STORE_FORMAT_FILE), "utf8");
  } catch {
    return undefined;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The backend the store's marker records, read synchronously; `undefined` when the store has no
 * readable marker (a fresh store, or one the format gate will judge first).
 */
export function recordedStoreBackend(dir: string): StoreBackend | undefined {
  const epoch = recordedMarker(dir)?.epoch;
  return typeof epoch === "string" ? backendOfEpoch(epoch) : undefined;
}

/**
 * The id of the database a store on SQLite runs on, as its marker records it (`sqliteId`); the
 * database holds the same id in `store_binding`. `undefined` when the marker records none.
 */
export function recordedSqliteBinding(dir: string): string | undefined {
  const id = recordedMarker(dir)?.sqliteId;
  return typeof id === "string" ? id : undefined;
}

/** Throws `STORE_FORMAT` (`reason: "OTHER_BACKEND"`) when the store records the other backend. */
export function refuseOtherBackend(dir: string, opening: StoreBackend): void {
  const recorded = recordedStoreBackend(dir);
  if (recorded === undefined || recorded === opening) return;
  throw new OrcaError(
    "STORE_FORMAT",
    recorded === "sqlite"
      ? `${dir} keeps its metadata in SQLite (metadata.sqlite); the file-backed metadata beside it is no longer current and is not opened.`
      : `${dir} keeps its metadata in files; its SQLite database is not what the workspace runs on. Switch the store with \`orca store sqlite switch\` first.`,
    { reason: "OTHER_BACKEND", storeDir: dir, recorded, opening },
  );
}
