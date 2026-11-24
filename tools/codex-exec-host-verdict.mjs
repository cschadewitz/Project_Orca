/**
 * The verdict on two reports of tools/codex-exec-host-probe.mjs, for the Codex exec gate's
 * host job (#1026, .github/workflows/codex-exec-gate-host.yml): every claim the job's summary
 * makes is checked here, so the job cannot stay green while its reports say otherwise.
 *
 *   node tools/codex-exec-host-verdict.mjs <plain.json> <installed.json> <installed-label>
 *
 * The plain report (a program with no profile of its own) has to show the host's control: an
 * `unconfined` label, bubblewrap and `unshare` each refused a user namespace, and the closed
 * executor refused. The installed report has to show the closed executor admitted and seen as
 * closed, with `<installed-label>` on the probe, on what bubblewrap and `unshare` ran alone, on
 * the holder, on the executor and on a command inside. Prints each failure and exits 1 if any.
 */
import { readFileSync } from "node:fs";

const [plainFile, installedFile, label] = process.argv.slice(2);
if (!plainFile || !installedFile || !label) {
  process.stderr.write("usage: codex-exec-host-verdict.mjs <plain.json> <installed.json> <installed-label>\n");
  process.exit(2);
}
const plain = JSON.parse(readFileSync(plainFile, "utf8"));
const installed = JSON.parse(readFileSync(installedFile, "utf8"));

const failures = [];
const expect = (ok, what) => {
  if (!ok) failures.push(what);
};
const refused = (alone) =>
  alone !== undefined &&
  alone.status !== 0 &&
  /uid.map|Permission denied|Operation not permitted/.test(alone.stderr ?? "");

// The control: without the package's profile, nothing here makes a user namespace.
expect(plain.label === "unconfined", `plain: label is ${JSON.stringify(plain.label)}, not "unconfined"`);
expect(
  refused(plain.bubblewrapAlone),
  `plain: bubblewrap alone was not refused (${JSON.stringify(plain.bubblewrapAlone)})`,
);
expect(refused(plain.unshareAlone), `plain: unshare alone was not refused (${JSON.stringify(plain.unshareAlone)})`);
expect(plain.admitted === false, "plain: the closed executor was admitted");
expect(
  typeof plain.refused === "string" && /namespace could not be made/.test(plain.refused),
  `plain: refused for another reason (${JSON.stringify(plain.refused)})`,
);

// The installed program: admitted, closed as shown, and every part under the package's label.
expect(
  installed.label === label,
  `installed: label is ${JSON.stringify(installed.label)}, not ${JSON.stringify(label)}`,
);
for (const which of ["bubblewrapAlone", "unshareAlone"]) {
  const alone = installed[which];
  expect(
    alone?.status === 0 && alone.stdout === label,
    `installed: ${which} did not run under ${label} (${JSON.stringify(alone)})`,
  );
}
expect(
  installed.admitted === true,
  `installed: the closed executor was refused (${JSON.stringify(installed.refused)})`,
);
expect(installed.proof?.closed !== undefined, "installed: the proof does not say closed");
expect(installed.proof?.network === "none", "installed: the proof's network is not none");
for (const which of ["holderLabel", "executorLabel"])
  expect(installed[which] === label, `installed: ${which} is ${JSON.stringify(installed[which])}`);
expect(
  installed.inside?.label === label,
  `installed: a command inside runs as ${JSON.stringify(installed.inside?.label)}`,
);
for (const [check, ok] of Object.entries(installed.checks ?? {})) expect(ok === true, `installed: ${check} failed`);
expect(
  ["workspaceWritten", "outsideRefused", "hiddenAbsent"].every((check) => installed.checks?.[check] === true) &&
    installed.closedAsShown === true,
  "installed: not closed as shown",
);
// The standing shortfalls are reported, never an empty list.
expect(
  Array.isArray(installed.shortfalls) && installed.shortfalls.some((s) => /named pipe/.test(s)),
  "installed: the shortfall list does not name the pipe",
);

for (const failure of failures) process.stderr.write(`::error::${failure}\n`);
process.stdout.write(failures.length === 0 ? "verdict: every claim checked\n" : `verdict: ${failures.length} failed\n`);
process.exit(failures.length === 0 ? 0 : 1);
