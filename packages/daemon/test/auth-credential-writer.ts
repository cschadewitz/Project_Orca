/** Separate process for deterministic credential-writer contention tests. */
import { existsSync } from "node:fs";
import { CredentialStore } from "../src/auth/credentials.js";
import { bootstrapLocalOwner } from "../src/auth/bootstrap.js";

const [file, operation, id, release, tokenFile] = process.argv.slice(2) as [string, string, string, string, string];
let paused = false;
const credentials = new CredentialStore({
  file,
  now: () => {
    // create() calls now only after the transaction has reloaded its snapshot.
    if (release && !paused) {
      paused = true;
      process.send?.({ kind: "snapshot" });
      const deadline = Date.now() + 10_000;
      while (!existsSync(release)) {
        if (Date.now() > deadline) throw new Error("writer barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return new Date();
  },
});
process.send?.({ kind: "attempt" });
try {
  if (operation === "revoke") await credentials.revoke(id);
  else if (operation === "rotate") await credentials.rotate(id);
  else if (operation === "bootstrap") await bootstrapLocalOwner({ credentials, tokenFile });
  else await credentials.issue({ principal: "writer", preset: "client" });
  process.send?.({ kind: "done" });
} catch (error) {
  process.send?.({ kind: "failed", message: (error as Error).message });
  process.exitCode = 1;
}
process.disconnect?.();
