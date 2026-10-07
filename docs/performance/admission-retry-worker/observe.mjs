/** Local paired experiment only: observe fork/IPC/close events without changing arguments or messages. */
import fs from "node:fs";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";
const fork = childProcess.fork;
childProcess.fork = function (modulePath, args, options) {
  const begin = performance.now();
  const child = fork.call(this, modulePath, args, options);
  if (!/admission-retry-multiprocess\/worker\.(ts|js)$/.test(modulePath)) return child;
  const record = { pid: child.pid, module: modulePath.endsWith(".ts") ? "source" : "emitted", args: args.slice(1) };
  child.on("message", (message) => {
    if (message.type === "ready") record.forkToReadyMs = performance.now() - begin;
  });
  child.on("close", (code, signal) => {
    Object.assign(record, { code, signal, forkToCloseMs: performance.now() - begin });
    fs.appendFileSync(process.env.ORCA_RETRY_OBSERVATIONS, JSON.stringify([record]) + "\n");
  });
  return child;
};
syncBuiltinESMExports();
