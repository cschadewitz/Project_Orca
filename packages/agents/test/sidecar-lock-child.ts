/** Disposable subprocess fixture: a plain sidecar writer that takes the lock and waits, to be paused or killed. */
import { once } from "node:events";
import { saveJudgedRule } from "../src/permissions.js";
const [file] = process.argv.slice(2);
if (!file) throw new Error("missing synthetic fixture input");
let paused = false;
await saveJudgedRule({
  file,
  agentId: "a",
  match: { kind: "read", scope: "workspace" },
  criterion: "Written by the child.",
  authorize: async () => {
    if (paused) return;
    paused = true;
    process.send?.({ state: "locked" });
    const [message] = await once(process, "message");
    if (message !== "continue") throw new Error("synthetic writer not resumed");
  },
});
process.send?.({ state: "saved" });
process.disconnect?.();
