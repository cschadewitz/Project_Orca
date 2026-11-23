// A child process that switches a store on SQLite back to files and is killed (SIGKILL) at one
// point of it; see sqlite-switch-back.test.ts. The point is a legacy fence path (killed once that
// path is restored), "afterExport", "beforeMarker", "afterMarkerRename" or "afterMarker".
import { switchStoreToFiles } from "@orca/store";

const [dir, point] = process.argv.slice(2) as [string, string];
const crash = async () => {
  process.kill(process.pid, "SIGKILL");
  await new Promise(() => undefined);
};
const at = (name: string) => async () => {
  if (point === name) await crash();
};
await switchStoreToFiles(dir, {
  appVersion: "0.8.0",
  afterExport: at("afterExport"),
  afterRestoreStep: async (path) => {
    if (path === point) await crash();
  },
  beforeMarker: at("beforeMarker"),
  afterMarkerRename: at("afterMarkerRename"),
  afterMarker: at("afterMarker"),
});
process.stdout.write("finished\n");
