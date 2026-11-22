/** Markdown table of run.js outputs: `node summarize.js NAME.json...` (missing files are skipped). */
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

const lines = [
  "| Network | Scenario | per-command ssh (median ms) | sftp (median ms) | Speed-up |",
  "| --- | --- | ---: | ---: | ---: |",
];
for (const file of process.argv.slice(2)) {
  if (!existsSync(file)) continue;
  const { results } = JSON.parse(readFileSync(file, "utf8"));
  const scenarios = [...new Set(results.map((r) => r.scenario))];
  for (const scenario of scenarios) {
    const exec = results.find((r) => r.scenario === scenario && r.mode === "per-command ssh");
    const sftp = results.find((r) => r.scenario === scenario && r.mode === "sftp");
    lines.push(
      `| ${basename(file, ".json")} | ${scenario} | ${exec.medianMs} | ${sftp.medianMs} | ${(exec.medianMs / sftp.medianMs).toFixed(1)}× |`,
    );
  }
}
console.log(["## SSH host file access: SFTP vs per-command", "", ...lines].join("\n"));
