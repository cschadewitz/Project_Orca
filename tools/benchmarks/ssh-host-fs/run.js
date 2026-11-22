/**
 * Artifact pickup over SSH: the SFTP session (`SshHost.fs`) against the
 * per-command path (`SshHost.execFs`) on the same host (#886).
 *
 * Needs built packages (`npx tsc -b packages/agents`) and key-based ssh to the
 * target. Every repeat starts cold: the SFTP session is closed first, so its
 * handshake is part of the measured time.
 *
 *   node tools/benchmarks/ssh-host-fs/run.js --host HOST --dir REMOTE-SCRATCH-DIR
 *     [--user U] [--port P] [--identity FILE] [--ssh-arg ARG]... [--small 100] [--large-mb 50] [--repeat 3]
 *
 * Writes a JSON summary to stdout. Results are recorded in
 * docs/performance/ssh-host-fs.md.
 */
import { performance } from "node:perf_hooks";
import { cpus, platform, release } from "node:os";
import { HostSpecSchema } from "../../../packages/core/dist/index.js";
import { SshHost } from "../../../packages/agents/dist/index.js";

const opts = { small: "100", "large-mb": "50", repeat: "3", "ssh-arg": [] };
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i].replace(/^--/, "");
  const value = process.argv[i + 1];
  if (value === undefined) throw new Error(`--${key} needs a value`);
  if (key === "ssh-arg") opts[key].push(value);
  else opts[key] = value;
}
if (!opts.host || !opts.dir) throw new Error("usage: run.js --host HOST --dir REMOTE-SCRATCH-DIR [options]");

const host = new SshHost(
  HostSpecSchema.parse({
    id: "bench",
    type: "ssh",
    host: opts.host,
    ...(opts.user ? { user: opts.user } : {}),
    ...(opts.port ? { port: Number(opts.port) } : {}),
    ...(opts.identity ? { identityFile: opts.identity } : {}),
    sshArgs: opts["ssh-arg"],
  }),
);
const small = Number(opts.small);
const largeBytes = Number(opts["large-mb"]) * 1024 * 1024;
const repeat = Number(opts.repeat);
const dir = opts.dir.replace(/\/$/, "");
const smallPaths = Array.from({ length: small }, (_, i) => `${dir}/small/artifact-${String(i).padStart(3, "0")}.md`);
const smallBody = (i) => `# artifact ${i}\n${"lorem ipsum dolor sit amet ".repeat(40)}\n`;
const largePath = `${dir}/large/artifact.log`;
const largeBody = "0123456789abcdef".repeat(largeBytes / 16);

async function time(fn) {
  host.close();
  const t = performance.now();
  await fn();
  return performance.now() - t;
}

/** What `agent-step` does on pickup: one batched existence check, then every present file read at once. */
async function pickupSmall(fs) {
  const present = await fs.existsMany(smallPaths);
  if (!present.every(Boolean)) throw new Error("small artifacts missing");
  const bodies = await Promise.all(smallPaths.map((p) => fs.readFile(p)));
  bodies.forEach((b, i) => {
    if (b !== smallBody(i)) throw new Error(`small artifact ${i} differs`);
  });
}
async function pickupLarge(fs) {
  const [present] = await fs.existsMany([largePath]);
  if (!present) throw new Error("large artifact missing");
  const body = await fs.readFile(largePath);
  if (body.length !== largeBody.length || body !== largeBody) throw new Error("large artifact differs");
}
async function writeSmall(fs) {
  await Promise.all(smallPaths.map((p, i) => fs.writeFile(p, smallBody(i))));
}
async function writeLarge(fs) {
  await fs.writeFile(largePath, largeBody);
}

const scenarios = {
  [`write ${small} small files`]: writeSmall,
  [`write one ${opts["large-mb"]} MB file`]: writeLarge,
  [`pick up ${small} small files`]: pickupSmall,
  [`pick up one ${opts["large-mb"]} MB file`]: pickupLarge,
};
const modes = { "per-command ssh": host.execFs, sftp: host.fs };

await writeSmall(host.fs);
await writeLarge(host.fs);
const results = [];
for (const [scenario, run] of Object.entries(scenarios)) {
  for (const [mode, fs] of Object.entries(modes)) {
    const runs = [];
    for (let r = 0; r < repeat; r++) runs.push(Math.round(await time(() => run(fs))));
    const sorted = [...runs].sort((a, b) => a - b);
    results.push({ scenario, mode, runsMs: runs, medianMs: sorted[Math.floor(sorted.length / 2)] });
  }
}
host.close();
await host.exec(`rm -rf '${dir.replace(/'/g, `'\\''`)}'`);
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: `${platform()} ${release()}`,
      cpu: cpus()[0]?.model,
      small,
      largeBytes,
      repeat,
      results,
    },
    null,
    2,
  ),
);
