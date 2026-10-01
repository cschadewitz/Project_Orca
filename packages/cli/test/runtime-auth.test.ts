/** Real token-mode CLI startup, local credential lifecycle and authenticated client migration. */
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openAuthDirectory, readLocalToken, bootstrapLocalOwner } from "@orca/daemon";
import { HELLO_METHOD, PROTOCOL_VERSION } from "@orca/protocol";
import { commands, type CommandContext } from "../src/commands/index.js";
import { daemonCall, localTokenFile } from "../src/daemon-client.js";
import * as bootstrapModule from "../src/bootstrap.js";
import { main } from "../src/main.js";

const dirs: string[] = [];
beforeEach(() => {
  vi.stubEnv("ORCA_DAEMON_TOKEN", undefined);
  vi.stubEnv("ORCA_DAEMON_TOKEN_FILE", undefined);
  vi.stubEnv("ORCA_DAEMON_URL", undefined);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

function ctx(cwd: string, positionals: string[] = [], flags: CommandContext["flags"] = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    cwd,
    positionals,
    flags,
    lines,
    errors,
    out: (line: string) => void lines.push(line),
    err: (line: string) => void errors.push(line),
  };
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-runtime-auth-"));
  dirs.push(dir);
  await writeFile(join(dir, "orca.config.yaml"), "workflows: []\ntemplates: []\n");
  return dir;
}

async function serving(
  dir: string,
  flags: CommandContext["flags"],
  check: (url: string, context: ReturnType<typeof ctx>) => Promise<void>,
) {
  const context = ctx(dir, [], { port: "0", ...flags });
  let resolveReady!: (url: string) => void;
  const ready = new Promise<string>((resolve) => {
    resolveReady = resolve;
  });
  context.out = (line) => {
    context.lines.push(line);
    if (line.startsWith("authentication:")) resolveReady(context.lines[0]!.match(/listening on (\S+)/)![1]!);
  };
  const run = commands.serve!.run(context);
  const url = await Promise.race([
    ready,
    run.then(() => {
      throw new Error("daemon ended before readiness");
    }),
  ]);
  try {
    await check(url, context);
  } finally {
    process.emit("SIGTERM");
    await run;
  }
}

const hello = { client: "cli-test", protocol: PROTOCOL_VERSION };

describe("CLI auth lifecycle", () => {
  it("issues scoped credentials, lists metadata only, rotates and revokes", async () => {
    const dir = await fixture();
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const issue = ctx(dir, ["issue", "build-bot"], {
      "expires-at": expiresAt,
      json: true,
      "workflow-scope": ["build"],
      label: "bot",
    });
    expect(await commands.auth!.run(issue)).toBe(0);
    const created = JSON.parse(issue.lines[0]!) as { token: string; credential: { id: string } };
    const auth = openAuthDirectory(join(dir, "auth"));
    expect(auth.credentials.authenticate(created.token)).toMatchObject({
      ok: true,
      principal: { scope: { workflows: ["build"], runs: "owned" } },
    });
    const list = ctx(dir, ["list"], { json: true });
    await commands.auth!.run(list);
    expect(list.lines.join("\n")).not.toContain(created.token);
    expect(list.lines.join("\n")).not.toContain("secretSha256");
    const rotate = ctx(dir, ["rotate", created.credential.id], { json: true });
    await commands.auth!.run(rotate);
    const rotated = JSON.parse(rotate.lines[0]!) as { token: string; credential: { id: string; expiresAt: string } };
    expect(rotated.credential.expiresAt).toBe(expiresAt);
    expect(auth.credentials.authenticate(created.token).ok).toBe(false);
    expect(auth.credentials.authenticate(rotated.token).ok).toBe(true);
    const revoke = ctx(dir, ["revoke", rotated.credential.id]);
    await commands.auth!.run(revoke);
    expect(revoke.lines.join("\n")).not.toContain(rotated.token);
    expect(auth.credentials.authenticate(rotated.token).ok).toBe(false);
  });

  it("leaves bootstrap rotation to atomic daemon startup", async () => {
    const dir = await fixture();
    const auth = openAuthDirectory(join(dir, "auth"));
    const { credentialId } = await bootstrapLocalOwner(auth);
    const before = readLocalToken(auth.tokenFile);
    const rotate = ctx(dir, ["rotate", credentialId], { json: true });
    await expect(commands.auth!.run(rotate)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
      message: "restart orca serve to rotate its local bootstrap credential",
    });
    expect(readLocalToken(auth.tokenFile)).toBe(before);
    expect(auth.credentials.authenticate(before!).ok).toBe(true);
    expect(rotate.lines).toEqual([]);
  });

  it("rejects invalid administration options without disclosing credential-like arguments", async () => {
    const dir = await fixture();
    for (const [positionals, flags] of [
      [["issue"], {}],
      [["issue", "bot"], { preset: "admin" }],
      [["issue", "bot"], { "runs-scope": "some" }],
      [["issue", "bot"], { "workflow-scope": ["*"] }],
      [["issue", "bot"], { "expires-at": "yesterday" }],
      [["rotate", "sensitive-token-value"], {}],
      [["unknown"], {}],
      [["list", "extra"], {}],
    ] as [string[], CommandContext["flags"]][]) {
      await expect(commands.auth!.run(ctx(dir, positionals, flags))).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    }
    expect(openAuthDirectory(join(dir, "auth")).credentials.list()).toEqual([]);
  });
});

describe("token-mode serve", () => {
  it("defaults to authentication, prints only the path, and accepts CLI local-token calls", async () => {
    const dir = await fixture();
    await serving(dir, {}, async (url, context) => {
      const tokenFile = join(dir, "auth", "local-client.token");
      const token = readLocalToken(tokenFile)!;
      expect(token).toMatch(/^orca1\./);
      expect(context.lines).toContain(`authentication: token; local token file: ${tokenFile}`);
      expect(context.lines.join("\n")).not.toContain(token);
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, "auth"))).mode & 0o777).toBe(0o700);
      expect(await readFile(join(dir, "auth", ".gitignore"), "utf8")).toBe("*\n");
      const unauthenticated = await fetch(`${url}/rpc`, {
        method: "POST",
        body: JSON.stringify({ kind: "request", id: 1, method: HELLO_METHOD, params: hello }),
      });
      expect(unauthenticated.status).toBe(401);
      expect(await daemonCall(context, url, HELLO_METHOD, hello)).toMatchObject({
        methods: expect.arrayContaining(["workflows.validateInputs"]),
      });
      const agents = ctx(dir, [], { port: new URL(url).port });
      expect(await commands.agents!.run(agents)).toBe(0);
    });
  });

  it("keeps read-only behavior with authenticated preflight discovery", async () => {
    const dir = await fixture();
    await serving(dir, { "read-only": true }, async (url, context) => {
      const response = (await daemonCall(context, url, HELLO_METHOD, hello)) as {
        methods: string[];
        capabilities: string[];
      };
      expect(response.methods).toContain("workflows.validateInputs");
      expect(response.methods).not.toContain("runs.start");
      expect(response.capabilities).not.toContain("runs.control");
    });
  });

  it("permits unauthenticated access only through explicit loopback compatibility", async () => {
    const dir = await fixture();
    await serving(dir, { "unauthenticated-loopback": true }, async (url, context) => {
      expect(readLocalToken(join(dir, "auth", "local-client.token"))).toBeUndefined();
      expect(await daemonCall(context, url, HELLO_METHOD, hello)).toBeDefined();
      expect(context.lines.join("\n")).toContain("explicit unauthenticated loopback");
    });
    await expect(
      commands.serve!.run(ctx(dir, [], { port: "0", host: "0.0.0.0", "unauthenticated-loopback": true })),
    ).rejects.toThrow("loopback-only");
  });

  it("does not fall back when a restricted principal's hello omits agents.ping", async () => {
    const dir = await fixture();
    await serving(dir, {}, async (url) => {
      const auth = openAuthDirectory(join(dir, "auth"));
      const viewer = await auth.credentials.issue({ principal: "observer", preset: "viewer" });
      vi.stubEnv("ORCA_DAEMON_TOKEN", viewer.token);
      await expect(commands.ping!.run(ctx(dir, ["never-spawn"], { port: new URL(url).port }))).rejects.toMatchObject({
        code: "NOT_SUPPORTED",
        message: "the daemon does not offer agents.ping to this client",
      });
    });
  });

  it("does not fall back to local ping when the daemon rejects authentication", async () => {
    const dir = await fixture();
    await serving(dir, {}, async (url) => {
      vi.stubEnv("ORCA_DAEMON_TOKEN", "orca1.aaaaaaaaaaaa." + "b".repeat(43));
      await expect(commands.ping!.run(ctx(dir, ["never-spawn"], { port: new URL(url).port }))).rejects.toMatchObject({
        code: "AUTH_INVALID",
      });
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const errors: string[] = [];
      vi.spyOn(process.stderr, "write").mockImplementation((text) => (errors.push(String(text)), true));
      expect(await main(["ping", "never-spawn", "--cwd", dir, "--port", new URL(url).port])).toBe(1);
      expect(errors.join("\n")).toContain("error [AUTH_INVALID]");
      expect(errors.join("\n")).not.toContain(process.env.ORCA_DAEMON_TOKEN);
    });
  });
});

describe("CLI credential transport", () => {
  it.each(["hello", "agents.ping"])(
    "does not follow an HTTP 302 or fall back locally when %s redirects",
    async (redirectedMethod) => {
      const dir = await fixture();
      const bootstrap = vi.spyOn(bootstrapModule, "bootstrap");
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(request.url ?? "");
        let body = "";
        request.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        request.on("end", () => {
          const { method } = JSON.parse(body) as { method: string };
          if (method === redirectedMethod) {
            response.writeHead(302, { location: "/login?token=never-disclose" });
            response.end("Login required");
          } else {
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({ kind: "response", id: 1, ok: true, result: { methods: ["hello", "agents.ping"] } }),
            );
          }
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind TCP");
      try {
        await expect(
          commands.ping!.run(ctx(dir, ["never-spawn"], { port: String(address.port) })),
        ).rejects.toMatchObject({
          code: "NOT_SUPPORTED",
          message: "daemon redirected the RPC request; refusing to follow it or run locally",
          details: { status: 302 },
        });
        expect(bootstrap).not.toHaveBeenCalled();
        expect(requests).toEqual(redirectedMethod === "hello" ? ["/rpc"] : ["/rpc", "/rpc"]);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
  );

  it("prefers the environment token, accepts an explicit file, and never auto-sends a local token remotely", async () => {
    const dir = await fixture();
    const auth = openAuthDirectory(join(dir, "auth"));
    await bootstrapLocalOwner(auth);
    const other = await auth.credentials.issue({ principal: "external", preset: "viewer" });
    const requests: RequestInit[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        requests.push(init);
        return new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result: {} }));
      }),
    );
    try {
      await daemonCall(ctx(dir), "https://daemon.example", HELLO_METHOD, hello);
      expect(requests.at(-1)!.headers).not.toHaveProperty("authorization");
      vi.stubEnv("ORCA_DAEMON_TOKEN", other.token);
      await daemonCall(ctx(dir), "https://daemon.example", HELLO_METHOD, hello);
      expect(requests.at(-1)!.headers).toHaveProperty("authorization", `Bearer ${other.token}`);
      expect(requests.at(-1)!.redirect).toBe("manual");
      vi.stubEnv("ORCA_DAEMON_TOKEN", undefined);
      vi.stubEnv("ORCA_DAEMON_TOKEN_FILE", auth.tokenFile);
      expect(await localTokenFile(ctx(dir))).toBe(auth.tokenFile);
      await daemonCall(ctx(dir), "https://daemon.example", HELLO_METHOD, hello);
      expect(requests.at(-1)!.headers).toHaveProperty("authorization", `Bearer ${readLocalToken(auth.tokenFile)}`);
      await expect(daemonCall(ctx(dir), "http://daemon.example", HELLO_METHOD, hello)).rejects.toThrow(
        "requires HTTPS",
      );
      await expect(daemonCall(ctx(dir), "https://daemon.example/?token=secret", HELLO_METHOD, hello)).rejects.toThrow(
        "without credentials",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed environment/file tokens and URL credentials without issuing a request", async () => {
    const dir = await fixture();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    try {
      vi.stubEnv("ORCA_DAEMON_TOKEN", "secret-invalid-value");
      await expect(daemonCall(ctx(dir), "http://127.0.0.1:6722", HELLO_METHOD, hello)).rejects.toMatchObject({
        code: "AUTH_INVALID",
        message: "ORCA_DAEMON_TOKEN is not a valid token",
      });
      vi.stubEnv("ORCA_DAEMON_TOKEN", undefined);
      vi.stubEnv("ORCA_DAEMON_TOKEN_FILE", join(dir, "missing.token"));
      await expect(daemonCall(ctx(dir), "http://127.0.0.1:6722", HELLO_METHOD, hello)).rejects.toMatchObject({
        code: "AUTH_INVALID",
      });
      await expect(
        daemonCall(ctx(dir), "http://user:secret@localhost:6722", HELLO_METHOD, hello),
      ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not retry explicit environment credentials or silently accept proxy denials", async () => {
    const dir = await fixture();
    const auth = openAuthDirectory(join(dir, "auth"));
    const issued = await auth.credentials.issue({ principal: "bot", preset: "client" });
    vi.stubEnv("ORCA_DAEMON_TOKEN", issued.token);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            kind: "response",
            id: 0,
            ok: false,
            error: { code: "AUTH_INVALID", message: "invalid credentials" },
          }),
          { status: 401 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await expect(daemonCall(ctx(dir), "http://127.0.0.1:6722", HELLO_METHOD, hello)).rejects.toMatchObject({
        code: "AUTH_INVALID",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      fetchMock.mockImplementation(async () => new Response("Forbidden", { status: 403 }));
      await expect(daemonCall(ctx(dir), "http://127.0.0.1:6722", HELLO_METHOD, hello)).rejects.toMatchObject({
        code: "AUTH_FORBIDDEN",
      });
      fetchMock.mockImplementation(async () => new Response("Unauthorized", { status: 401 }));
      await expect(daemonCall(ctx(dir), "http://127.0.0.1:6722", HELLO_METHOD, hello)).rejects.toMatchObject({
        code: "AUTH_INVALID",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("re-reads a rotated local token once on AUTH_INVALID", async () => {
    const dir = await fixture();
    const auth = openAuthDirectory(join(dir, "auth"));
    await bootstrapLocalOwner(auth);
    const tokens: string[] = [];
    const fetchMock = vi.fn(async (_url: unknown, init: RequestInit) => {
      tokens.push((init.headers as Record<string, string>).authorization!);
      if (tokens.length === 1) {
        await bootstrapLocalOwner(auth);
        return new Response(
          JSON.stringify({
            kind: "response",
            id: 0,
            ok: false,
            error: { code: "AUTH_INVALID", message: "invalid credentials" },
          }),
          { status: 401 },
        );
      }
      return new Response(JSON.stringify({ kind: "response", id: 1, ok: true, result: {} }));
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      expect(await daemonCall(ctx(dir), "http://127.0.0.1:6722", HELLO_METHOD, hello)).toEqual({});
      expect(tokens).toHaveLength(2);
      expect(tokens[0]).not.toBe(tokens[1]);
      expect(tokens[1]).toBe(`Bearer ${readLocalToken(auth.tokenFile)}`);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
