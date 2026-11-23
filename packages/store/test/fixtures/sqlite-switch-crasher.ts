// A child process that switches a store to SQLite and is killed (SIGKILL) at one point of the
// switch; see sqlite-legacy-fence.test.ts. The point is a legacy fence path (killed once that
// path is fenced), "beforeMarker", "afterMarkerRename" (renamed, not yet flushed) or "afterMarker".
import { switchStoreToSqlite } from "@orca/store";

const [dir, point] = process.argv.slice(2) as [string, string];
const crash = async () => {
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => undefined);
};
await switchStoreToSqlite(dir, {
  appVersion: "0.8.0",
  afterFenceStep: async (path) => {
    if (path === point) await crash();
  },
  beforeMarker: async () => {
    if (point === "beforeMarker") await crash();
  },
  afterMarkerRename: async () => {
    if (point === "afterMarkerRename") await crash();
  },
  afterMarker: async () => {
    if (point === "afterMarker") await crash();
  },
});
process.stdout.write("finished\n");
