/** Closed read-only replacement inspection of an existing first-run store; no adoption. */
import { lstatSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { z } from "zod";
import {
  acquireFirstRunFence,
  fenceBoot,
  fenceDirectory,
  fenceHash,
  fenceRead,
  firstRunAttempts,
  firstRunLayout,
  holdsFirstRunOwnership,
  FenceBootSchema,
  FenceDirectorySchema,
  WriterSchema,
} from "./first-run-fence.js";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unavailable = () => new Error("Closed first-run inspection unavailable");
const digest = z.string().regex(/^[a-f0-9]{64}$/);
function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** The ordinary first-run launch capability still owns ordinary startup. A replacement
 * inspection instead holds BOTH the enrolled update lease and the existing kernel first-run
 * fence before migration/reads. It verifies retained anchor/claim/writer/config/store evidence,
 * never creates a first-run attempt, overwrites writer.json, adopts or signals the old PID,
 * and never obtains run/agent/config control. Unknown or pending recovery evidence refuses. */
export async function enterClosedFirstRunInspection(
  configDir: string,
  storeDir: string,
  updateOwned: () => Promise<boolean>,
): Promise<void> {
  if (!(await updateOwned())) throw unavailable();
  for (const input of [configDir, storeDir]) {
    let path = resolve(input);
    for (let depth = 0; depth < 256; depth++) {
      if (holdsFirstRunOwnership(path) && path !== configDir) throw unavailable();
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  const layout = firstRunLayout(configDir);
  const journal = layout.journal,
    anchorPath = layout.anchor;
  if (!exists(journal) && !exists(anchorPath)) return;
  if (storeDir !== layout.store) throw unavailable();
  const workspace = fenceDirectory(configDir);
  let retained: z.infer<typeof WriterSchema> | undefined;
  const kernel = await acquireFirstRunFence(workspace, () =>
    retained ? fenceHash(JSON.stringify(retained)) : undefined,
  );
  try {
    const anchor = z
      .strictObject({ version: z.literal(1), workspace: FenceDirectorySchema, journal: FenceDirectorySchema })
      .parse(JSON.parse(fenceRead(anchorPath)));
    if (!same(anchor.workspace, workspace) || !same(anchor.journal, fenceDirectory(journal))) throw unavailable();
    const names = firstRunAttempts(journal);
    if (!names) throw unavailable();
    const attempt = join(journal, names.at(-1)!);
    fenceDirectory(attempt);
    if (readdirSync(attempt).sort().join(",") !== "claim.json,writer.json") throw unavailable();
    const claimBytes = fenceRead(join(attempt, "claim.json"));
    const claim = z
      .strictObject({
        version: z.literal(2),
        reservationId: z.uuid(),
        workspace: FenceDirectorySchema,
        configHash: digest,
        previous: digest.nullable(),
        launchHash: digest,
        fence: z.literal("kernel-lifetime-v1"),
        boot: FenceBootSchema,
        store: FenceDirectorySchema.nullable(),
      })
      .parse(JSON.parse(claimBytes));
    retained = WriterSchema.parse(JSON.parse(fenceRead(join(attempt, "writer.json"))));
    if (
      !same(claim.workspace, workspace) ||
      !same(claim.boot, fenceBoot()) ||
      claim.configHash !== fenceHash(fenceRead(layout.config, 1024 * 1024)) ||
      retained.claimHash !== fenceHash(claimBytes) ||
      retained.reservationId !== claim.reservationId ||
      !same(retained.workspace, workspace) ||
      !same(retained.store, fenceDirectory(storeDir)) ||
      retained.bootId !== claim.boot.bootId ||
      retained.hostHash !== claim.boot.hostHash ||
      retained.kernelDomain !== claim.boot.kernelDomain ||
      !(await updateOwned())
    )
      throw unavailable();
    // No runtime close capability: the kernel fence lasts until this inspection child exits.
  } catch (error) {
    await new Promise<void>((done) => kernel.close(() => done()));
    throw error;
  }
}
