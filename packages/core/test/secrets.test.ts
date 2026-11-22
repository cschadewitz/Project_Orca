/** Secret references (#336): schema, static checks and value redaction. */
import { describe, expect, it } from "vitest";
import {
  literalEnv,
  parseOrcaConfig,
  redactSecretValues,
  secretRefs,
  secretSource,
  SecretsConfigSchema,
} from "../src/index.js";

const base = {
  hosts: [
    { id: "local", type: "local" },
    { id: "build-box", type: "ssh", host: "build.example" },
  ],
  secrets: {
    "github-token": { host: "local", provider: "env", name: "GITHUB_TOKEN" },
    "db-password": { host: "build-box", provider: "file", path: "/etc/orca/db-password" },
  },
};
const agent = (env: object, extra: object = {}) => ({ id: "claude", command: "claude", env, ...extra });
const issues = (raw: object) => {
  try {
    parseOrcaConfig(raw);
    return [];
  } catch (error) {
    return (error as { issues: { path: (string | number)[]; message: string }[] }).issues.map(
      (e) => `${e.path.join(".")}: ${e.message}`,
    );
  }
};

describe("secret definitions", () => {
  it("accepts env and file sources bound to a host, and keeps only metadata", () => {
    const config = parseOrcaConfig({ ...base, agents: [agent({ GITHUB_TOKEN: { secret: "github-token" } })] });
    expect(config.secrets?.["db-password"]).toEqual({
      host: "build-box",
      provider: "file",
      path: "/etc/orca/db-password",
    });
    expect(config.agents[0]!.env).toEqual({ GITHUB_TOKEN: { secret: "github-token" } });
    expect(secretSource(config.secrets!["github-token"]!)).toEqual({ provider: "env", name: "GITHUB_TOKEN" });
    expect(secretSource(config.secrets!["db-password"]!)).toEqual({ provider: "file", path: "/etc/orca/db-password" });
  });

  it.each([
    ["a value in the definition", { host: "local", provider: "env", name: "X", value: "hunter2" }],
    ["a relative file path", { host: "local", provider: "file", path: "secrets/token" }],
    ["a file path on an env source", { host: "local", provider: "env", name: "X", path: "/x" }],
    ["an unknown provider", { host: "local", provider: "vault", name: "X" }],
    ["no host", { provider: "env", name: "X" }],
    ["a variable name that is not one", { host: "local", provider: "env", name: "X Y" }],
  ])("refuses %s", (_name, def) => {
    expect(SecretsConfigSchema.safeParse({ token: def }).success).toBe(false);
  });

  it("accepts a Windows absolute path and refuses an id with spaces", () => {
    expect(SecretsConfigSchema.safeParse({ t: { host: "local", provider: "file", path: "C:\\orca\\t" } }).success).toBe(
      true,
    );
    expect(SecretsConfigSchema.safeParse({ "my token": { host: "local", provider: "env", name: "X" } }).success).toBe(
      false,
    );
  });

  it("refuses a reference with anything beside the id", () => {
    expect(issues({ ...base, agents: [agent({ T: { secret: "github-token", value: "x" } })] })).not.toEqual([]);
  });
});

describe("static reference checks", () => {
  it("names an undefined secret, an unconfigured host and a reference bound to another host", () => {
    const found = issues({
      ...base,
      secrets: { ...base.secrets, orphan: { host: "gone", provider: "env", name: "X" } },
      agents: [
        agent(
          { A: { secret: "nope" }, B: { secret: "db-password" } },
          { mcpServers: [{ name: "gh", command: "gh-mcp", env: { T: { secret: "db-password" } } }] },
        ),
      ],
      capabilities: { mcpServers: { db: { command: "db-mcp", env: { P: { secret: "missing" } } } } },
    });
    expect(found).toEqual(
      expect.arrayContaining([
        "secrets.orphan.host: secret 'orphan' is bound to host 'gone', which is not configured",
        "agents[0].env.A: no secret 'nope' is defined in secrets",
        expect.stringMatching(
          /^agents\[0\]\.env\.B: secret 'db-password' is bound to host 'build-box', but this agent runs on 'local'/,
        ),
        expect.stringMatching(/^agents\[0\]\.mcpServers\[0\]\.env\.T: .*only ever read on its own host/),
        "capabilities.mcpServers.db.env.P: no secret 'missing' is defined in secrets",
      ]),
    );
  });

  it("accepts a reference on the agent's own host, including in a catalog server", () => {
    expect(
      issues({
        ...base,
        agents: [agent({ T: { secret: "db-password" } }, { hostId: "build-box" })],
        capabilities: { mcpServers: { gh: { command: "gh-mcp", env: { T: { secret: "github-token" } } } } },
      }),
    ).toEqual([]);
  });

  it("splits an env map into references and literals", () => {
    const env = { A: "1", B: { secret: "b" } };
    expect(secretRefs(env)).toEqual([{ name: "B", ref: { secret: "b" } }]);
    expect(literalEnv(env)).toEqual({ A: "1" });
  });
});

describe("redactSecretValues", () => {
  it("replaces every occurrence in strings and keys, longest value first", () => {
    const out = redactSecretValues(
      { message: "token abc123 and abc", nested: [{ abc123: "x" }], n: 5, d: new Date(0) },
      ["abc", "abc123", ""],
    );
    expect(out).toMatchObject({
      message: "token [REDACTED] and [REDACTED]",
      nested: [{ "[REDACTED]": "x" }],
      n: 5,
    });
    expect(out.d).toBeInstanceOf(Date);
    expect(redactSecretValues("same", [])).toBe("same");
  });
});
