// The test's hand inside a machine (#885): call this machine's daemon on its own loopback,
// with the local token the daemon wrote beside its workspace config, and print the answer.
// Run as the daemon's user. The daemon is never bound beyond loopback for the test's sake.
//
//   node rpc.mjs <method> [params-json]   one call; prints the daemon's JSON answer
//   node rpc.mjs --peak                   until /tmp/orca-peak.stop exists, polls agents.list
//                                         and prints the most sessions in use at once
import { existsSync, readFileSync } from "node:fs";

const workspace = process.env.ORCA_WORKSPACE ?? "/home/orca/ws";
const port = process.env.ORCA_PORT ?? "6722";

async function call(method, params) {
  const token = readFileSync(`${workspace}/auth/local-client.token`, "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${port}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}`, connection: "close" },
    body: JSON.stringify({ kind: "request", id: 1, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  return response.text();
}

if (process.argv[2] === "--peak") {
  let peak = 0;
  while (!existsSync("/tmp/orca-peak.stop")) {
    const answer = JSON.parse(await call("agents.list", {}));
    if (answer.ok) peak = Math.max(peak, answer.result.sessionSlots.inUse.total);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  process.stdout.write(`${peak}\n`);
} else {
  process.stdout.write(await call(process.argv[2], JSON.parse(process.argv[3] ?? "{}")));
}
