/** Run ci.yml's actual `pick runner` step: it may log validated runner counts, never the health body. */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

const { parse } = createRequire(new URL("../../packages/cli/package.json", import.meta.url))("yaml");
const workflow = parse(readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"));
const pick = workflow.jobs.runner.steps.find(({ id }) => id === "pick");

const run = (body) => {
  const scratch = mkdtempSync(join(tmpdir(), "orca-ci-picker-"));
  try {
    // A stand-in curl that answers with the given body, so the step runs unchanged.
    const curl = join(scratch, "curl");
    writeFileSync(curl, `#!/usr/bin/env bash\nprintf '%s' "$FAKE_BODY"\n`);
    chmodSync(curl, 0o755);
    const output = join(scratch, "output");
    writeFileSync(output, "");
    const log = execFileSync("bash", ["-c", pick.run], {
      env: {
        ...process.env,
        PATH: `${scratch}:${process.env.PATH}`,
        FAKE_BODY: JSON.stringify(body),
        HEALTH_URL: "https://health.invalid/status",
        HEAD_REPO: "cschadewitz/Project_Orca",
        THIS_REPO: "cschadewitz/Project_Orca",
        FORCE_HOSTED: "",
        GITHUB_OUTPUT: output,
      },
      stdio: ["ignore", "pipe", "pipe"],
    }).toString();
    return { log, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
};

it.skipIf(process.platform === "win32").each([
  ["total only", { Project_Orca: 3, host: "runner-7.lan.internal", url: "http://10.0.0.5:8080/admin" }],
  [
    "per host",
    { Project_Orca: 4, machines: { m1: 2, m2: 2, "build-box.lan.internal": 9 }, debug: "token=SECRET-VALUE" },
  ],
])("logs counts but no other field of a %s response", (_label, body) => {
  const { log, output } = run(body);
  for (const leaked of ["lan.internal", "10.0.0.5", "admin", "SECRET-VALUE", "health.invalid", "debug"])
    expect(log).not.toContain(leaked);
  expect(log).toMatch(/idle (in total: \d+|per host: m1=\d+ m2=\d+)/);
  expect(output).toContain("labels=");
});

it.skipIf(process.platform === "win32").each([
  [0, "ubuntu-24.04"],
  [1, "tyler"],
  [3, "tyler"],
])("with %i idle runners in total, picks %s", (idle, expected) => {
  const { output } = run({ Project_Orca: idle });
  const labels = output.match(/^labels=(.*)$/m)[1];
  expect(labels).toContain(expected);
  expect(output).toMatch(new RegExp(`^shards=\\[\\{"shard":1,"total":1,"labels":\\[[^\\]]*"${expected}"`, "m"));
});
