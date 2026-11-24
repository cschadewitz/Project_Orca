/**
 * A stand-in for ORCA's hook program that fails after the session has started (#1026): it hands
 * ORCA's startup probe to the real program (so the session is admitted exactly as a healthy one
 * is), and then fails on every later call in the way `ORCA_1026_HOOK_FAILURE` names:
 *
 * - `exit-1`: exits 1 with a message, as a crash of the runtime does;
 * - `quiet-exit-2`: exits 2 with nothing on stderr;
 * - `garbage`: exits 0 with output that is not ORCA's allow;
 * - `killed`: kills itself with SIGKILL;
 * - `hang`: never answers.
 *
 * Codex 0.171.0 on its own lets each of these calls through. The installed receipt and the
 * acceptance suite run it in place of ORCA's program to show the fail-closed line ORCA installs
 * around the program blocks every one of them.
 *
 * Usage (as Codex runs ORCA's program): node failing-hook-program.js --codex <context file>
 * with ORCA_1026_REAL_HOOK set to the real program.
 */
import { spawn } from "node:child_process";

const chunks = [];
process.stdin.on("data", (d) => chunks.push(d));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks);
  let probe = false;
  try {
    probe = String(JSON.parse(input.toString("utf8"))?.tool_use_id ?? "").startsWith("orca-hook-probe:");
  } catch {
    // Not a frame: treated like any later call.
  }
  if (probe) {
    const real = spawn(process.execPath, [process.env["ORCA_1026_REAL_HOOK"] ?? "", ...process.argv.slice(2)], {
      stdio: ["pipe", "inherit", "inherit"],
    });
    real.on("close", (code) => process.exit(code ?? 1));
    real.stdin.end(input);
    return;
  }
  switch (process.env["ORCA_1026_HOOK_FAILURE"]) {
    case "exit-1":
      process.stderr.write("TypeError: the hook crashed\n");
      process.exit(1);
      break;
    case "quiet-exit-2":
      process.exit(2);
      break;
    case "garbage":
      process.stdout.write('{"decision":"allow"}\n');
      process.exit(0);
      break;
    case "killed":
      process.kill(process.pid, "SIGKILL");
      break;
    case "hang":
      setInterval(() => undefined, 60_000);
      break;
    default:
      process.stderr.write("no ORCA_1026_HOOK_FAILURE\n");
      process.exit(1);
  }
});
