/**
 * The interpreter process of crash-resume-357.test.ts, started with `<dir> <runId> <effectsFile>
 * <mode>` over the test's store directory:
 * - `park`: drive the run until it parks at its gate, then exit normally (a daemon restart);
 * - `kill-in-deploy`: SIGKILL itself inside `deploy`'s side effect, after it acted;
 * - `kill-before-deploy`: SIGKILL itself just after `deploy` was scheduled, before it started.
 * A SIGKILL runs no catch or finally and releases no lease, so the store holds exactly what a
 * crash there leaves behind.
 */
import { fileStores } from "@orca/store";
import { crashRuntime } from "./crash-resume-fixture.js";

const [dir, runId, effectsFile, mode] = process.argv.slice(2) as [string, string, string, string];
// Windows has no signals to send oneself: exit there, which runs no catch or finally either.
const die = () => (process.platform === "win32" ? process.exit(87) : process.kill(process.pid, "SIGKILL"));

const stores = fileStores(dir);
const orc = crashRuntime(stores, effectsFile, (nodeId) => {
  if (mode === "kill-in-deploy" && nodeId === "deploy") die();
});
if (mode === "kill-before-deploy") {
  const append = stores.events.append.bind(stores.events);
  stores.events.append = async (event) => {
    const result = await append(event);
    if (event.type === "step.scheduled" && (event.payload as { nodeId?: string }).nodeId === "deploy") die();
    return result;
  };
}
const state = await orc.run(runId);
process.stdout.write(state.run.status);
