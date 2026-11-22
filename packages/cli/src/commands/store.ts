/**
 * `orca store ...` - the store's own format (#566).
 *
 *   store format                 print the store's recorded format and what this ORCA would do
 *   store carry-forward          convert an older-format store, with every other ORCA stopped
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
 * The SQLite metadata database is not what a workspace runs on yet: nothing reads it until the
 * backend can be selected (after the store format gates #897, #905, #910). `import` builds it
 * beside the files, as often as wanted; the files stay the authority meanwhile.
 */
import { resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  backupSqliteMetadata,
  carryStoreForward,
  enterStoreFormat,
  importFileMetadata,
  readStoreFormat,
  restoreSqliteMetadata,
  STORE_FORMAT_EPOCH,
  verifySqliteMetadata,
} from "@orca/store";
import { loadConfig } from "../bootstrap.js";
import { readOrcaVersion } from "../version.js";
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
      const outcome = await carryStoreForward(storeDir, { appVersion: readOrcaVersion() });
      if (outcome.status === "carried")
        ctx.out(`carried ${storeDir} forward from ${outcome.from} to ${outcome.epoch}; backup in ${outcome.backup}`);
      else ctx.out(`${storeDir} is already in store format ${outcome.epoch}; nothing to do`);
      return 0;
    }
    case "sqlite":
      return sqliteCommand(ctx, storeDir);
    default:
      throw new OrcaError("CONFIG_INVALID", `unknown store subcommand '${sub}' (format | carry-forward | sqlite)`);
  }
}

async function sqliteCommand(ctx: CommandContext, storeDir: string): Promise<number> {
  const [, action, file] = ctx.positionals;
  const needFile = () => {
    if (!file) throw new OrcaError("CONFIG_INVALID", `store sqlite ${action} needs a file path`);
    return resolve(ctx.cwd, file);
  };
  switch (action) {
    case "import": {
      const report = await importFileMetadata(storeDir);
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
      const { file: restored, schema } = await restoreSqliteMetadata(needFile(), storeDir);
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
        `unknown store sqlite action '${action ?? ""}' (import | backup <file> | restore <file> | verify)`,
      );
  }
}
