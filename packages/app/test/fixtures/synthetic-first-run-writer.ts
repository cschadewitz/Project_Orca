/** Synthetic lifetime attestation for existing in-memory child tests; never proves a real kernel fence. */
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  fenceBoot,
  fenceDirectory,
  fenceHash,
  fenceRead,
  fenceWrite,
  firstRunAttempts,
  WriterSchema,
} from "@orca/protocol/first-run-fence";
export function syntheticFirstRunWriter(path: string, pid: number) {
  const latest = firstRunAttempts(join(path, ".orca-first-run-ownership"))!.at(-1)!;
  const attempt = join(path, ".orca-first-run-ownership", latest);
  const claimText = fenceRead(join(attempt, "claim.json"));
  const claim = JSON.parse(claimText) as { reservationId: string };
  mkdirSync(join(path, ".orca"), { recursive: true });
  fenceWrite(
    join(attempt, "writer.json"),
    WriterSchema.parse({
      version: 1,
      contract: "kernel-lifetime-v1",
      reservationId: claim.reservationId,
      claimHash: fenceHash(claimText),
      workspace: fenceDirectory(path),
      store: fenceDirectory(join(path, ".orca")),
      processId: pid,
      generation: randomUUID(),
      ...fenceBoot(),
    }),
  );
}
