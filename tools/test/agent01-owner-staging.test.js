/** Keep checked-in owner staging bytes tied to the renderer and exercise its private-file safeguards. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { renderAgent01 } from "../deploy/private-mcp-service/render-agent01.js";

it("owner review artifacts retain the exact merged rendering and hashes", () => {
  const base = "docs/preparation/private-mcp-access/agent01-owner-staging";
  const manifest = JSON.parse(readFileSync(`${base}/rendered-sha256.json`, "utf8"));
  expect(manifest.sourceCommit).toBe("1199f7e4705d904f3f5dfda32a2644d0b8346e01");
  for (const [name, digest] of Object.entries(manifest.sha256)) {
    const bytes = readFileSync(`${base}/${name}`, "utf8").replace(/\r\n/g, "\n");
    expect(bytes).toBe(renderAgent01(name));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(digest);
  }
});

it("owner stager passes synthetic safety checks without executing its host entrypoint", () => {
  expect(() =>
    execFileSync(process.platform === "win32" ? "python" : "python3", ["-B", "tools/deploy/test_agent01_staging.py"], {
      stdio: "pipe",
    }),
  ).not.toThrow();
});
