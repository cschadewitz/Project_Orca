/**
 * `orca store ...` - the store's own format (#566).
 *
 *   store format                 print the store's recorded format and what this ORCA would do
 *   store carry-forward          convert an older-format store, with every other ORCA stopped
 *   store sqlite convert         convert the store into a SQLite store of its own beside it, and use that (#339)
 *   store sqlite switch          switch the store to SQLite in place: always refused (#339)
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
 * `convert` copies the store into `<store>-sqlite`, makes SQLite the authority there and names it
 * in the config, leaving the file store as it was (store-convert.ts); `switch`, the same in
 * place, always refuses (`refuseInPlaceSwitch`).
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { OrcaError } from "@orca/core";
import {
  backupSqliteMetadata,
  CONVERTED_STORE_SUFFIX,
  convertedSourceChanged,
  convertedStoreDir,
  convertStoreToSqlite,
  recordedStoreBackend,
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
import { configRevision, otherConfigs, writeConfigStoreDir } from "../config-store-dir.js";
import { storePrivacy } from "../store-privacy.js";
import type { CommandContext } from "./index.js";

export async function storeCommand(ctx: CommandContext): Promise<number> {
  const [sub = "format"] = ctx.positionals;
  const { config, configDir, configFile } = await loadConfig(ctx.cwd, ctx.configPath);
  const storeDir = resolve(configDir, config.storeDir);
  switch (sub) {
    case "format": {
      const marker = await readStoreFormat(storeDir);
      ctx.out(`store            ${storeDir}`);
      ctx.out(`recorded format  ${marker ? `${marker.epoch} (written by ORCA ${marker.writtenBy})` : "none"}`);
      ctx.out(`this version     ${STORE_FORMAT_EPOCH} (ORCA ${readOrcaVersion()})`);
      ctx.out(`metadata         ${recordedStoreBackend(storeDir) === "sqlite" ? "SQLite (metadata.sqlite)" : "files"}`);
      const converted = await convertedSourceChanged(storeDir);
      if (converted)
        ctx.out(
          `converted from   ${converted.source}${
            !converted.present
              ? " (no longer there)"
              : converted.changed
                ? " (CHANGED since: an older ORCA wrote there after the conversion, and that is not in this store)"
                : " (unchanged since)"
          }`,
        );
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
      if (ctx.positionals[1] === "convert") return convertCommand(ctx, { configDir, configFile, raw: config.storeDir });
      return sqliteCommand(ctx, configDir, storeDir);
    default:
      throw new OrcaError("CONFIG_INVALID", `unknown store subcommand '${sub}' (format | carry-forward | sqlite)`);
  }
}

/**
 * `store sqlite convert` (#339): the workspace's file store, converted into a SQLite store of its
 * own beside it (store-convert.ts), which the config then names. The file store is left as it
 * was, for any older ORCA still running against it.
 */
async function convertCommand(
  ctx: CommandContext,
  workspace: { configDir: string; configFile: string | undefined; raw: string },
): Promise<number> {
  const storeDir = resolve(workspace.configDir, workspace.raw);
  refuseAppOwned(workspace.configDir, storeDir);
  // The new store is put in use by editing the workspace's one config, before anything is copied.
  // A config is never created: it would be in use before it could be checked, and nothing could
  // take it back.
  const configFile = workspace.configFile;
  if (!configFile)
    throw new OrcaError(
      "CONFIG_INVALID",
      `no ORCA config names ${storeDir}: add ${join(workspace.configDir, "orca.config.yaml")} (with \`version: 1\`) and run the conversion again. Nothing was changed.`,
    );
  const others = await otherConfigs(configFile);
  if (others.length)
    throw new OrcaError(
      "CONFIG_INVALID",
      `${configFile} has ${others.join(", ")} beside it, so which config an ORCA opens depends on how it is started: keep one and run the conversion again. Nothing was changed.`,
    );
  // The config names the new store the way it named the old one: relative stays relative.
  const raw = isAbsolute(workspace.raw)
    ? convertedStoreDir(workspace.raw)
    : join(dirname(workspace.raw), `${basename(workspace.raw)}${CONVERTED_STORE_SUFFIX}`);
  if (resolve(workspace.configDir, raw) !== convertedStoreDir(storeDir))
    throw new OrcaError("CONFIG_INVALID", `cannot name the converted store of ${storeDir} in the config (${raw})`);
  // The config as it is now, which must still name this store: publication is conditional on it.
  const revision = configRevision(await readFile(configFile, "utf8"));
  const privacy = storePrivacy();
  let written: string | undefined;
  const outcome = await convertStoreToSqlite(storeDir, {
    appVersion: readOrcaVersion(),
    ...(privacy ? { privacy } : {}),
    publish: async () => {
      written = await writeConfigStoreDir(configFile, workspace.configDir, raw, {
        revision,
        source: storeDir,
      });
    },
  });
  if (outcome.status === "current") {
    ctx.out(`${storeDir} already keeps its metadata in SQLite; nothing to do`);
    return 0;
  }
  ctx.out(
    `${outcome.status === "finished" ? "finished converting" : "converted"} ${storeDir} into ${outcome.convertedDir} (SQLite metadata)`,
  );
  ctx.out(`${written} now names ${raw} as the store; ${storeDir} was left exactly as it was`);
  ctx.out(
    "ORCA 0.7.0 and earlier refuse the new store. One still running keeps using the old one, and what it writes there is not in the new store: `orca store format` says if that happened",
  );
  return 0;
}

/**
 * The in-place switch is not offered (#339): the legacy fence turns away a released ORCA that
 * starts after it, but nothing makes one that is already running (an idle daemon, a command
 * between two writes) stop, and released versions leave no trace of themselves to check for. So
 * the shipped command refuses, always; the release check of the fence switches through its own
 * entry point (tools/legacy-fence/switch.js), which is not shipped.
 */
function refuseInPlaceSwitch(storeDir: string): never {
  throw new StoreFormatError(
    "SWITCH_REFUSED",
    "Switching a workspace to SQLite in place is not available: ORCA 0.7.0 and earlier do not register as the store's writers, so this ORCA cannot make sure none of them is still running against it. Use `orca store sqlite convert`, which converts into a new store and leaves this one as it is. Nothing was changed.",
    storeDir,
  );
}

async function sqliteCommand(ctx: CommandContext, configDir: string, storeDir: string): Promise<number> {
  const [, action, file] = ctx.positionals;
  const needFile = () => {
    if (!file) throw new OrcaError("CONFIG_INVALID", `store sqlite ${action} needs a file path`);
    return resolve(ctx.cwd, file);
  };
  switch (action) {
    case "switch":
      refuseAppOwned(configDir, storeDir);
      return refuseInPlaceSwitch(storeDir);
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
