// The Orrery cutover scripts (tools/rename/*.sh), against stand-ins for gh, curl and az: what each
// would change in a dry run, that a real run changes only what is missing and logs it, that a
// rerun changes nothing, and that rollback.sh undoes the log in reverse.
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPTS = resolve("tools/rename");
const MOCK = resolve("tools/test/fixtures/rename-cutover/mock.mjs");
const CF = "https://cf.invalid/client/v4";
let dir;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rename-cutover-"));
  mkdirSync(join(dir, "bin"));
  for (const tool of ["gh", "curl", "az"]) {
    writeFileSync(join(dir, "bin", tool), `#!/bin/sh\nexec node ${MOCK} ${tool} "$@"\n`);
    chmodSync(join(dir, "bin", tool), 0o755);
  }
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(script, args, world, env = {}) {
  writeFileSync(join(dir, "world.json"), JSON.stringify(world));
  writeFileSync(join(dir, "calls"), "");
  const result = spawnSync("bash", [join(SCRIPTS, script), ...args], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      MOCK_WORLD: join(dir, "world.json"),
      MOCK_CALLS: join(dir, "calls"),
      CUTOVER_LOG: join(dir, "cutover-log.json"),
      CLOUDFLARE_API_BASE: CF,
      CLOUDFLARE_API_TOKEN: "test-token",
      CLOUDFLARE_ACCOUNT_ID: "acct",
      VERIFY_POLL_SECONDS: "0",
      ...env,
    },
  });
  const calls = readFileSync(join(dir, "calls"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const logFile = join(dir, "cutover-log.json");
  const log = existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
  return { ...result, calls, log, writes: calls.filter(isWrite) };
}
const isWrite = (call) =>
  (["gh", "curl"].includes(call[0]) && call.includes("-X") && call[call.indexOf("-X") + 1] !== "GET") ||
  (call[0] === "az" && call.includes("update"));

const SUBJECT = "repo:cschadewitz@7377200/Project_Orca_Infra@901:environment:production";
const preCutover = () => ({
  gh: {
    "GET repos/cschadewitz/Project_Orca": { id: 1, name: "Project_Orca", private: false },
    "GET repos/cschadewitz/Project_Orca_Infra": { id: 2, name: "Project_Orca_Infra", private: true },
    "GET repos/cschadewitz/Orrery": { id: 11, name: "Orrery", private: true },
    "GET repos/cschadewitz/Orrery-Infra": { id: 12, name: "Orrery-Infra", private: true },
  },
  az: {
    "ad app list": "app-123\n",
    "ad app federated-credential list": JSON.stringify([
      {
        id: "cred-9",
        name: "production",
        issuer: "https://token.actions.githubusercontent.com",
        subject: SUBJECT,
        audiences: ["api://AzureADTokenExchange"],
      },
      { id: "cred-8", name: "other", issuer: "x", subject: "repo:someone/else:ref:refs/heads/main", audiences: [] },
    ]),
  },
});
const postCutover = () => ({
  gh: {
    "GET repos/cschadewitz/Project_Orca": { id: 1, name: "Orrery", private: false },
    "GET repos/cschadewitz/Project_Orca_Infra": { id: 2, name: "Orrery-Infra", private: true },
    "GET repos/cschadewitz/Orrery": { id: 1, name: "Orrery", private: false },
    "GET repos/cschadewitz/Orrery-Infra": { id: 2, name: "Orrery-Infra", private: true },
  },
  az: {
    "ad app list": "app-123\n",
    "ad app federated-credential list": JSON.stringify([
      {
        id: "cred-9",
        name: "production",
        issuer: "i",
        subject: SUBJECT.replace("Project_Orca_Infra", "Orrery-Infra"),
        audiences: [],
      },
    ]),
  },
});
const patches = (result) =>
  result.writes
    .filter((c) => c[0] === "gh")
    .map((c) => `${c[c.indexOf("-X") + 2]} ${c.find((a) => a.startsWith("name="))}`);

describe.skipIf(process.platform === "win32")("cutover scripts", () => {
  it("are all executable bash that parses", () => {
    for (const name of ["preflight", "github", "cloudflare", "verify", "rollback", "relink-clones"])
      execFileSync("bash", ["-n", join(SCRIPTS, `${name}.sh`)]);
  });

  describe("github.sh --repos", () => {
    it("in a dry run says what it would rename, in order, and changes nothing", () => {
      const r = run("github.sh", ["--repos", "--dry-run"], preCutover());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.log).toEqual([]);
      const order = [
        "rename the placeholder cschadewitz/Orrery -> cschadewitz/Orrery-placeholder",
        "rename cschadewitz/Project_Orca -> cschadewitz/Orrery",
        "rename the placeholder cschadewitz/Orrery-Infra -> cschadewitz/Orrery-Infra-placeholder",
        "rename cschadewitz/Project_Orca_Infra -> cschadewitz/Orrery-Infra",
      ].map((line) => r.stdout.indexOf(line));
      expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]))).toBe(true);
      // The federated credential is looked up and printed, not changed, without --apply-azure.
      expect(r.stdout).toContain("az ad app federated-credential update --id app-123 --federated-credential-id cred-9");
      expect(r.stdout).toContain("repo:cschadewitz@7377200/Orrery-Infra@901:environment:production");
      expect(r.stdout).toContain("ok    other: repo:someone/else");
    });

    it("renames placeholders first, never deletes, logs each rename, and updates the subject with --apply-azure", () => {
      const r = run("github.sh", ["--repos", "--apply-azure"], preCutover());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(patches(r)).toEqual([
        "repos/cschadewitz/Orrery name=Orrery-placeholder",
        "repos/cschadewitz/Project_Orca name=Orrery",
        "repos/cschadewitz/Orrery-Infra name=Orrery-Infra-placeholder",
        "repos/cschadewitz/Project_Orca_Infra name=Orrery-Infra",
      ]);
      expect(r.calls.some((c) => c.includes("DELETE"))).toBe(false);
      const az = r.writes.find((c) => c[0] === "az");
      expect(az.slice(0, 9)).toEqual([
        "az",
        "ad",
        "app",
        "federated-credential",
        "update",
        "--id",
        "app-123",
        "--federated-credential-id",
        "cred-9",
      ]);
      expect(JSON.parse(az[10]).subject).toBe("repo:cschadewitz@7377200/Orrery-Infra@901:environment:production");
      expect(r.log.map((e) => [e.kind, e.from ?? e.before, e.to ?? e.after])).toEqual([
        ["repo-rename", "Orrery", "Orrery-placeholder"],
        ["repo-rename", "Project_Orca", "Orrery"],
        ["repo-rename", "Orrery-Infra", "Orrery-Infra-placeholder"],
        ["repo-rename", "Project_Orca_Infra", "Orrery-Infra"],
        ["azure-subject", SUBJECT, "repo:cschadewitz@7377200/Orrery-Infra@901:environment:production"],
      ]);
    });

    it("changes nothing when it already ran", () => {
      const r = run("github.sh", ["--repos", "--apply-azure"], postCutover());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.stdout).toContain("already renamed");
    });

    it("refuses to move a public repository that is not the placeholder", () => {
      const world = preCutover();
      world.gh["GET repos/cschadewitz/Orrery"].private = false;
      const r = run("github.sh", ["--repos"], world);
      expect(r.status).not.toBe(0);
      expect(r.writes).toEqual([]);
    });
  });

  describe("github.sh --settings", () => {
    const world = () => {
      const w = postCutover();
      Object.assign(w.gh, {
        "GET repos/cschadewitz/Orrery/topics": { names: ["orca"] },
        "GET repos/cschadewitz/Orrery/environments": { environments: [{ name: "feed-reader" }] },
        "GET repos/cschadewitz/Orrery/actions/variables?per_page=100": {
          variables: [
            { name: "ORCA_FEED_BUCKET", value: "orca-desktop-feed" },
            { name: "ORCA_FEED_PAUSE", value: "false" },
            { name: "ORRERY_FEED_PAUSE", value: "false" },
            { name: "CI_FORCE_HOSTED", value: "false" },
          ],
        },
        "GET repos/cschadewitz/Orrery/environments/feed-reader/variables?per_page=100": {
          variables: [{ name: "ORCA_FEED_URL", value: "https://feed.example" }],
        },
        "GET repos/cschadewitz/Orrery-Infra/environments": { environments: [] },
        "GET repos/cschadewitz/Orrery-Infra/actions/variables?per_page=100": { variables: [] },
      });
      return w;
    };

    it("copies only the missing ORRERY_ variables, never deletes, and sets homepage and topics", () => {
      const r = run("github.sh", ["--settings"], world());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const posts = r.writes.filter((c) => c.includes("POST")).map((c) => [c[4], c[6], c[8]]);
      expect(posts).toEqual([
        ["repos/cschadewitz/Orrery/actions/variables", "name=ORRERY_FEED_BUCKET", "value=orca-desktop-feed"],
        [
          "repos/cschadewitz/Orrery/environments/feed-reader/variables",
          "name=ORRERY_FEED_URL",
          "value=https://feed.example",
        ],
      ]);
      expect(r.calls.some((c) => c.includes("DELETE"))).toBe(false);
      expect(r.writes.find((c) => c.includes("PATCH"))).toContain("homepage=https://docs.orrery-control.dev");
      expect(r.writes.find((c) => c.includes("PUT"))[4]).toBe("repos/cschadewitz/Orrery/topics");
      expect(r.log.map((e) => e.kind)).toEqual([
        "repo-settings",
        "repo-topics",
        "variable-created",
        "variable-created",
      ]);
    });

    it("in a dry run changes nothing", () => {
      const r = run("github.sh", ["--settings", "--dry-run"], world());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.stdout).toContain("would copy Orrery ORCA_FEED_BUCKET -> ORRERY_FEED_BUCKET");
    });

    it("refuses before the repositories are renamed", () => {
      const r = run("github.sh", ["--settings"], preCutover());
      expect(r.status).not.toBe(0);
      expect(r.writes).toEqual([]);
    });
  });

  describe("cloudflare.sh", () => {
    const zones = {
      "GET /zones?name=orrery-control.dev": { success: true, result: [{ id: "zdev", status: "active" }] },
      "GET /zones?name=orrery-control.com": { success: true, result: [{ id: "zcom", status: "active" }] },
    };
    const empty = (path) => ({ [`GET ${path}`]: { success: true, result: [] } });
    const fresh = () => ({
      cf: {
        ...zones,
        ...empty("/zones/zdev/dns_records?name=docs.orrery-control.dev"),
        ...empty("/zones/zcom/dns_records?name=orrery-control.com"),
        ...empty("/zones/zcom/dns_records?name=www.orrery-control.com"),
        ...empty("/accounts/acct/workers/domains?hostname=feed.orrery-control.com"),
        "GET /zones/zcom/rulesets/phases/http_request_dynamic_redirect/entrypoint": {
          success: true,
          result: { rules: [{ id: "r1", ref: "existing", expression: "true", action: "redirect", version: "1" }] },
        },
      },
      gh: {},
    });

    it("in a dry run says each thing it would create and changes nothing", () => {
      const r = run("cloudflare.sh", ["--dry-run"], fresh());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.writes).toEqual([]);
      for (const line of [
        "would create the Pages project orrery-docs",
        "would bind docs.orrery-control.dev to orrery-docs",
        "would create DNS CNAME docs.orrery-control.dev -> orrery-docs.pages.dev",
        "would create DNS A orrery-control.com -> 192.0.2.1",
        "would create DNS A www.orrery-control.com -> 192.0.2.1",
        "would add the redirect rule orrery_cutover_site_to_docs",
        "would attach feed.orrery-control.com to orca-desktop-feed",
      ])
        expect(r.stdout).toContain(line);
    });

    it("creates what is missing, keeps the zone's other redirect rules, and logs each change", () => {
      const r = run("cloudflare.sh", [], fresh());
      expect(r.status, r.stderr + r.stdout).toBe(0);
      const put = r.writes.find((c) => c.some((a) => a.endsWith("/http_request_dynamic_redirect/entrypoint")));
      const rules = JSON.parse(put[put.indexOf("--data") + 1]).rules;
      expect(rules.map((rule) => rule.ref)).toEqual(["existing", "orrery_cutover_site_to_docs"]);
      expect(rules[0].id).toBeUndefined();
      expect(rules[1].action_parameters.from_value).toEqual({
        status_code: 301,
        preserve_query_string: false,
        target_url: { value: "https://docs.orrery-control.dev" },
      });
      const worker = r.writes.find((c) => c.some((a) => a.endsWith("/workers/domains")));
      expect(JSON.parse(worker[worker.indexOf("--data") + 1])).toEqual({
        hostname: "feed.orrery-control.com",
        service: "orca-desktop-feed",
        zone_id: "zcom",
        environment: "production",
      });
      expect(r.log.map((e) => e.kind)).toEqual([
        "cf-pages-project-created",
        "cf-pages-domain-created",
        "cf-dns-created",
        "cf-dns-created",
        "cf-dns-created",
        "cf-redirect-rule-added",
        "cf-worker-domain-created",
      ]);
      // The token goes in a header, never in the log.
      expect(readFileSync(join(dir, "cutover-log.json"), "utf8")).not.toContain("test-token");
    });

    it("changes nothing when everything is there", () => {
      const done = {
        cf: {
          ...zones,
          "GET /accounts/acct/pages/projects/orrery-docs": { success: true, result: {} },
          "GET /accounts/acct/pages/projects/orrery-docs/domains/docs.orrery-control.dev": {
            success: true,
            result: {},
          },
          "GET /zones/zdev/dns_records?name=docs.orrery-control.dev": {
            success: true,
            result: [{ type: "CNAME", content: "orrery-docs.pages.dev" }],
          },
          "GET /zones/zcom/dns_records?name=orrery-control.com": {
            success: true,
            result: [{ type: "A", content: "192.0.2.1" }],
          },
          "GET /zones/zcom/dns_records?name=www.orrery-control.com": {
            success: true,
            result: [{ type: "A", content: "192.0.2.1" }],
          },
          "GET /zones/zcom/rulesets/phases/http_request_dynamic_redirect/entrypoint": {
            success: true,
            result: { rules: [{ ref: "orrery_cutover_site_to_docs" }] },
          },
          "GET /accounts/acct/workers/domains?hostname=feed.orrery-control.com": {
            success: true,
            result: [{ service: "orca-desktop-feed" }],
          },
        },
      };
      const r = run("cloudflare.sh", [], done);
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(r.writes).toEqual([]);
      expect(r.log).toEqual([]);
    });

    it("needs the token", () => {
      const r = run("cloudflare.sh", ["--dry-run"], fresh(), { CLOUDFLARE_API_TOKEN: "" });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain("CLOUDFLARE_API_TOKEN is not set");
    });
  });

  describe("preflight.sh", () => {
    const world = () => ({
      gh: {
        "GET repos/cschadewitz/Project_Orca": { id: 1, permissions: { admin: true } },
        "GET repos/cschadewitz/Project_Orca_Infra": { id: 2, permissions: { admin: true } },
        "GET repos/cschadewitz/Project_Orca/compare/Rename-Migration...main": { ahead_by: 0 },
        "GET repos/cschadewitz/Project_Orca_Infra/compare/Rename-Migration...main": { ahead_by: 0 },
        "GET repos/cschadewitz/Orrery": { private: true },
      },
      cf: {
        "GET /user/tokens/verify": { success: true, result: { status: "active" } },
        "GET /zones?name=orrery-control.dev": { success: true, result: [{ id: "zdev", status: "active" }] },
        "GET /zones?name=orrery-control.com": { success: true, result: [{ id: "zcom", status: "active" }] },
        "GET /zones/zdev/dns_records?per_page=1": { success: true, result: [] },
        "GET /zones/zcom/dns_records?per_page=1": { success: true, result: [] },
        "GET /accounts/acct/pages/projects": { success: true, result: [] },
        "GET /accounts/acct/workers/domains": { success: true, result: [] },
      },
      az: { "ad app list": "app-123\n" },
    });
    const rings = (stable, server = stable) => {
      const file = join(dir, "rings.json");
      writeFileSync(
        file,
        JSON.stringify({ format: 1, rings: { stable: { version: stable } }, server: { stable: { version: server } } }),
      );
      return file;
    };

    it("is ready when every check holds, and makes no change", () => {
      const r = run("preflight.sh", ["--rings", rings("0.8.1")], world());
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain("preflight: ready");
      expect(r.stdout).toContain("ok    stable server offers 0.8.1");
      expect(r.writes).toEqual([]);
    });

    it.each([
      [
        "the bridge is not on stable",
        (w) => w,
        () => ["--rings", rings("0.8.0")],
        "stable desktop offers 0.8.0, not 0.8.1",
      ],
      ["servers lag", (w) => w, () => ["--rings", rings("0.8.1", "0.8.0")], "stable server offers 0.8.0"],
      [
        "main is ahead of Rename-Migration",
        (w) => ((w.gh["GET repos/cschadewitz/Project_Orca_Infra/compare/Rename-Migration...main"].ahead_by = 3), w),
        () => ["--rings", rings("0.8.1")],
        "main is 3 commit(s) ahead",
      ],
      [
        "a zone is pending",
        (w) => ((w.cf["GET /zones?name=orrery-control.com"].result[0].status = "pending"), w),
        () => ["--rings", rings("0.9.0")],
        "orrery-control.com: pending, not Active",
      ],
      [
        "the token cannot read Pages",
        (w) => (delete w.cf["GET /accounts/acct/pages/projects"], w),
        () => ["--rings", rings("0.8.1")],
        "token cannot read Pages",
      ],
    ])("is not ready when %s", (_label, change, args, message) => {
      const r = run("preflight.sh", args(), change(world()));
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(message);
      expect(r.stdout).toContain("preflight: NOT ready");
    });

    it("says how to give it the ring state when it has none", () => {
      const r = run("preflight.sh", [], world(), { FEED_BUCKET: "", AWS_ACCESS_KEY_ID: "" });
      expect(r.stdout).toContain("TODO  no ring state: pass --rings FILE");
    });
  });

  describe("verify.sh", () => {
    it("checks the renamed world without dispatching in a dry run", () => {
      const w = postCutover();
      Object.assign(w.gh, {
        "GET repos/cschadewitz/Orrery-placeholder": { id: 11 },
        "GET repos/cschadewitz/Orrery-Infra-placeholder": { id: 12 },
        "GET repos/cschadewitz/Orrery/topics": { names: ["orrery"] },
        "GET repos/cschadewitz/Orrery/actions/variables?per_page=100": {
          variables: [
            { name: "ORCA_X", value: "1" },
            { name: "ORRERY_X", value: "1" },
          ],
        },
        "GET repos/cschadewitz/Orrery-Infra/actions/variables?per_page=100": { variables: [] },
      });
      w.gh["GET repos/cschadewitz/Orrery"].homepage = "https://docs.orrery-control.dev";
      w.cf = {
        "GET /accounts/acct/pages/projects/orrery-docs/domains/docs.orrery-control.dev": {
          success: true,
          result: { status: "active" },
        },
      };
      w.http = {
        "GET https://docs.orrery-control.dev/": { code: 200 },
        "GET https://orrery-control.com/": { code: 301, location: "https://docs.orrery-control.dev/" },
        "GET https://www.orrery-control.com/": { code: 301, location: "https://docs.orrery-control.dev/" },
        "GET https://feed.orrery-control.com/latest-x64.yml": {
          headers: 'HTTP/2 401\r\nwww-authenticate: Bearer realm="orrery-feed"\r\n\r\n',
        },
      };
      const r = run("verify.sh", ["--dry-run"], w);
      expect(r.status, r.stdout).toBe(0);
      expect(r.stdout).toContain("verify: complete");
      expect(r.stdout).toContain("$ gh workflow run infra.yml --repo cschadewitz/Orrery-Infra --ref main");
      expect(r.calls.some((c) => c[1] === "workflow")).toBe(false);
      delete w.http["GET https://orrery-control.com/"];
      const broken = run("verify.sh", ["--no-infra-dispatch"], w);
      expect(broken.status).toBe(1);
      expect(broken.stdout).toContain("FAIL  orrery-control.com answers 000");
    });
  });

  describe("rollback.sh", () => {
    it("undoes the log newest first, once", () => {
      const forward = run("github.sh", ["--repos", "--apply-azure"], preCutover());
      expect(forward.log).toHaveLength(5);
      const dry = run("rollback.sh", ["--dry-run"], postCutover());
      expect(dry.writes).toEqual([]);
      expect(dry.stdout.indexOf("federated credential cred-9 back")).toBeLessThan(
        dry.stdout.indexOf("rename cschadewitz/Orrery-Infra back to Project_Orca_Infra"),
      );
      const back = run("rollback.sh", [], postCutover());
      expect(back.status, back.stderr + back.stdout).toBe(0);
      expect(patches(back)).toEqual([
        "repos/cschadewitz/Orrery-Infra name=Project_Orca_Infra",
        "repos/cschadewitz/Orrery-Infra-placeholder name=Orrery-Infra",
        "repos/cschadewitz/Orrery name=Project_Orca",
        "repos/cschadewitz/Orrery-placeholder name=Orrery",
      ]);
      const az = back.writes.find((c) => c[0] === "az");
      expect(JSON.parse(az[az.length - 1]).subject).toBe(SUBJECT);
      expect(readFileSync(join(dir, "cutover-log.json"), "utf8").trim()).toBe("");
      expect(readFileSync(join(dir, "cutover-log.json.undone"), "utf8").trim().split("\n")).toHaveLength(5);
      expect(run("rollback.sh", [], postCutover()).writes).toEqual([]);
    });
  });

  describe("relink-clones.sh", () => {
    it("points old remotes at the new names, leaves others, logs it, and rollback puts them back", () => {
      const clone = join(dir, "clone");
      const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
      // The stored URL, as relink-clones.sh reads it (not rewritten by any url.insteadOf).
      const url = (remote) => git("config", "--get", `remote.${remote}.url`);
      execFileSync("git", ["init", "-q", clone]);
      git("remote", "add", "origin", "https://github.com/cschadewitz/Project_Orca.git");
      git("remote", "add", "infra", "git@github.com:cschadewitz/Project_Orca_Infra");
      git("remote", "add", "fork", "https://github.com/someone/Project_Orca_Fork.git");
      const dry = run("relink-clones.sh", ["--dry-run", clone], {});
      expect(dry.stdout).toContain("would point origin at https://github.com/cschadewitz/Orrery.git");
      expect(url("origin")).toBe("https://github.com/cschadewitz/Project_Orca.git");
      const r = run("relink-clones.sh", [clone], {});
      expect(r.status, r.stderr + r.stdout).toBe(0);
      expect(url("origin")).toBe("https://github.com/cschadewitz/Orrery.git");
      expect(url("infra")).toBe("git@github.com:cschadewitz/Orrery-Infra");
      expect(url("fork")).toBe("https://github.com/someone/Project_Orca_Fork.git");
      expect(r.log.map((e) => e.remote)).toEqual(["fork", "infra", "origin"].filter((n) => n !== "fork").sort());
      expect(run("relink-clones.sh", [clone], {}).log).toHaveLength(2);
      run("rollback.sh", [], {});
      expect(url("origin")).toBe("https://github.com/cschadewitz/Project_Orca.git");
      expect(url("infra")).toBe("git@github.com:cschadewitz/Project_Orca_Infra");
    });
  });
});
