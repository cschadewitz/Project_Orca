/**
 * `orca store ...` - the store's own format (#566).
 *
 *   store format                 print the store's recorded format and what this ORCA would do
 *   store carry-forward          convert an older-format store, with every other ORCA stopped
 *   store sqlite switch          move the store's metadata from files to SQLite in place (#339); refused for now
 *                                (LEGACY_UNFENCED): released 0.7.0 and earlier never read the format marker
 *   store sqlite import          mirror the file-backed metadata into <store>/metadata.sqlite (#339)
 *   store sqlite backup <file>   a consistent copy of the SQLite metadata, taken while it is in use
 *   store sqlite restore <file>  put a backup in place in a store that has no SQLite metadata
 *   store sqlite verify          integrity, sequence gaps and artifact references; exit 1 on a problem
 *
 * Ordinary startup never converts a store from an older format; it refuses with
 * STORE_FORMAT / CARRYOVER_REQUIRED and points here. `carry-forward` is the explicit, offline
 * step: it backs the whole store up into `format-backups/`, confirms nothing else wrote
 * meanwhile and that this ORCA can read everything, and only then stamps the current format.
 *
 * A store runs on the backend its format marker records (store-backend.ts). `import` builds a
 * SQLite database beside the files, as often as wanted, and the files stay the authority;
 * `switch` would make SQLite the authority, after a verified backup, an import and a verify; it
 * is refused until released ORCA versions that ignore the format marker can be kept out
 * (IN_PLACE_SQLITE_SWITCH), and on Windows while store format changes are (#910, #947).
 */
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  backupSqliteMetadata,
  recordedStoreBackend,
  switchStoreToSqlite,
  carryStoreForward,
  enterStoreFormat,
  holdStoreWriter,
  importFileMetadata,
  readStoreFormat,
  restoreSqliteMetadata,
  STORE_FORMAT_EPOCH,
  StoreFormatError,
  verifySqliteMetadata,
} from "@orca/store";
import { assertNoUnownedFirstRunMutation } from "@orca/protocol/first-run-fence";
import { loadConfig } from "../bootstrap.js";
import { readOrcaVersion } from "../version.js";
import { storePrivacy } from "../store-privacy.js";
import type { CommandContext } from "./index.js";

export async function storeCommand(ctx: CommandContext): Promise<number> {
  const [sub = "format"] = ctx.positionals;
  const { config, configDir } = await loadConfig(ctx.cwd, ctx.configPath);
  const storeDir = resolve(configDir, config.storeDir);
  switch (sub) {
    case "format": {
      const marker = await readStoreFormat(storeDir);
      ctx.out(`store            ${storeDir}`);
      ctx.out(`recorded format  ${marker ? `${marker.epoch} (written by ORCA ${marker.writtenBy})` : "none"}`);
      ctx.out(`this ORCA        ${STORE_FORMAT_EPOCH} (ORCA ${readOrcaVersion()})`);
      ctx.out(`metadata         ${recordedStoreBackend(storeDir) === "sqlite" ? "SQLite (metadata.sqlite)" : "files"}`);
      try {
        const outcome = await enterStoreFormat(storeDir, { appVersion: readOrcaVersion(), mode: "read" });
        ctx.out(
          `on startup       ${outcome.status === "current" ? "opens in place" : `${outcome.status}: stamps the current format`}`,
        );
      } catch (error) {
        ctx.out(`on startup       refused: ${(error as Error).message}`);
        return 1;
      }
      return 0;
    }
    case "carry-forward": {
      refuseAppOwned(configDir, storeDir);
      const privacy = storePrivacy();
      const outcome = await carryStoreForward(storeDir, {
        appVersion: readOrcaVersion(),
        ...(privacy ? { privacy } : {}),
      });
      if (outcome.status === "carried")
        ctx.out(`carried ${storeDir} forward from ${outcome.from} to ${outcome.epoch}; backup in ${outcome.backup}`);
      else ctx.out(`${storeDir} is already in store format ${outcome.epoch}; nothing to do`);
      return 0;
    }
    case "sqlite":
      return sqliteCommand(ctx, configDir, storeDir);
    default:
      throw new OrcaError("CONFIG_INVALID", `unknown store subcommand '${sub}' (format | carry-forward | sqlite)`);
  }
}

async function sqliteCommand(ctx: CommandContext, configDir: string, storeDir: string): Promise<number> {
  const [, action, file] = ctx.positionals;
  const needFile = () => {
    if (!file) throw new OrcaError("CONFIG_INVALID", `store sqlite ${action} needs a file path`);
    return resolve(ctx.cwd, file);
  };
  switch (action) {
    case "switch": {
      refuseAppOwned(configDir, storeDir);
      const privacy = storePrivacy();
      const outcome = await switchStoreToSqlite(storeDir, {
        appVersion: readOrcaVersion(),
        ...(privacy ? { privacy } : {}),
      });
      if (outcome.status === "switched") {
        ctx.out(`switched ${storeDir} to SQLite metadata (store format ${outcome.epoch})`);
        ctx.out(`backup of the store as it was on files: ${outcome.backup}`);
        ctx.out("ORCA 0.7.1 and later refuse this store unless they know its format; 0.7.0 and earlier do not check");
      } else ctx.out(`${storeDir} already keeps its metadata in SQLite; nothing to do`);
      return 0;
    }
    case "import": {
      if (recordedStoreBackend(storeDir) === "sqlite")
        throw new OrcaError(
          "CONFIG_INVALID",
          `${storeDir} already runs on SQLite metadata; its file metadata is no longer current, so there is nothing to import`,
        );
      // A maintenance writer like any other: refused while a switch runs, and seen by one.
      const hold = holdStoreWriter(storeDir, { appVersion: readOrcaVersion(), purpose: "store sqlite import" });
      let report: Awaited<ReturnType<typeof importFileMetadata>>;
      try {
        report = await importFileMetadata(storeDir);
      } finally {
        hold.release();
      }
      const docs = Object.entries(report.documents)
        .map(([name, n]) => `${name} ${n}`)
        .join(", ");
      ctx.out(`imported into ${storeDir}/metadata.sqlite`);
      ctx.out(`documents  ${docs}`);
      ctx.out(`runs       ${report.runs} (${report.eventsImported} new events)`);
      ctx.out(`plans      ${report.plans} (${report.planEventsImported} new journal events)`);
      ctx.out(`artifacts  ${report.artifacts}`);
      return 0;
    }
    case "backup": {
      const { file: written, bytes } = await backupSqliteMetadata(storeDir, needFile());
      ctx.out(`backed up SQLite metadata to ${written} (${bytes} bytes)`);
      ctx.out("artifact blobs, execution records, workflows, claims and leases are files: back them up as files");
      return 0;
    }
    case "restore": {
      const hold = holdStoreWriter(storeDir, { appVersion: readOrcaVersion(), purpose: "store sqlite restore" });
      let restored: string, schema: number;
      try {
        ({ file: restored, schema } = await restoreSqliteMetadata(needFile(), storeDir));
      } finally {
        hold.release();
      }
      ctx.out(`restored ${restored} (schema ${schema}); run 'orca store sqlite verify' next`);
      return 0;
    }
    case "verify": {
      const report = await verifySqliteMetadata(storeDir);
      ctx.out(`integrity  ${report.integrity.join("; ")}`);
      ctx.out(`schema     ${report.schema}`);
      ctx.out(
        `counts     ${Object.entries(report.documents)
          .map(([name, n]) => `${name} ${n}`)
          .join(
            ", ",
          )}; runs ${report.runs}, events ${report.events}; plans ${report.plans}, journal ${report.planEvents}; artifacts ${report.artifacts}`,
      );
      if (report.unreferencedBlobs.length)
        ctx.out(
          `note       ${report.unreferencedBlobs.length} blob(s) no artifact references (interrupted puts; not deleted)`,
        );
      for (const problem of report.problems) ctx.out(`problem    ${problem.kind} ${JSON.stringify(problem.detail)}`);
      ctx.out(report.ok ? "ok" : `${report.problems.length} problem(s)`);
      return report.ok ? 0 : 1;
    }
    default:
      throw new OrcaError(
        "CONFIG_INVALID",
        `unknown store sqlite action '${action ?? ""}' (switch | import | backup <file> | restore <file> | verify)`,
      );
  }
}

/**
 * The desktop app's own workspaces are written only by the daemon the app launches, which holds
 * the workspace's first-run writer fence. This command cannot hold that fence, and the format
 * lock does not keep that daemon out, so it refuses there: the app carries its store forward
 * itself on the first start after an update (#897).
 */
function refuseAppOwned(configDir: string, storeDir: string): void {
  for (const path of [configDir, storeDir])
    try {
      assertNoUnownedFirstRunMutation(path);
    } catch {
      throw new StoreFormatError(
        "APP_OWNED",
        `${storeDir} belongs to the ORCA desktop app, which carries it forward itself after an update. This command cannot hold the app's write fence, so it changed nothing.`,
        storeDir,
      );
    }
}
