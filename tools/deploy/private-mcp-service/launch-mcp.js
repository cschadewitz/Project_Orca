#!/usr/bin/env node
/** Guarded stdio launcher. Its own stdout is reserved for the MCP child. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readPrivateFile, validateCredential, validateDiscovery, validateProfile } from "./credential-policy.js";

export function childEnvironment(profile, token) {
  return { LANG: "C", ...profile.childEnvironment, ORCA_MCP_TOKEN: token };
}

export async function probeDiscovery(profile, token, fetcher = fetch) {
  const response = await fetcher(profile.endpoint, {
    method: "POST",
    redirect: "error",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ kind: "request", id: "service-preflight", method: "operator.discover", params: {} }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error("authenticated discovery refused");
  const body = await response.json();
  if (body?.kind !== "response" || body.id !== "service-preflight" || body.ok !== true)
    throw new Error("authenticated discovery invalid");
  return validateDiscovery(profile, body.result);
}

export async function launch(paths, options = {}) {
  const profile = validateProfile(JSON.parse(readPrivateFile(paths.profile)));
  const token = validateCredential(
    profile,
    readPrivateFile(paths.token, 256),
    readPrivateFile(paths.store, 1024 * 1024),
  );
  await probeDiscovery(profile, token, options.fetcher);
  const child = (options.spawn ?? spawn)(
    profile.runtime.node,
    [profile.runtime.cliEntry, "mcp", "--endpoint", profile.endpoint, "--token-env", "ORCA_MCP_TOKEN"],
    { cwd: profile.runtime.workspaceDir, env: childEnvironment(profile, token), stdio: ["inherit", "pipe", "pipe"] },
  );
  child.stdout.pipe(options.stdout ?? process.stdout);
  // The CLI may include caller data in errors. Keep diagnostics generic and on stderr only.
  child.stderr.on("data", () => {});
  const signals = ["SIGINT", "SIGTERM"];
  const handlers = signals.map((signal) => () => {
    if (!child.killed) child.kill(signal);
  });
  for (let i = 0; i < signals.length; i++) process.on(signals[i], handlers[i]);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(signal ? 128 + (signal === "SIGINT" ? 2 : 15) : (code ?? 1)));
    });
  } finally {
    for (let i = 0; i < signals.length; i++) process.off(signals[i], handlers[i]);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  if (args.length !== 6 || args[0] !== "--profile" || args[2] !== "--token-file" || args[4] !== "--credential-store") {
    process.stderr.write("MCP service configuration invalid\n");
    process.exitCode = 64;
  } else {
    launch({ profile: args[1], token: args[3], store: args[5] })
      .then((code) => {
        process.exitCode = code;
      })
      .catch(() => {
        process.stderr.write("MCP service startup refused\n");
        process.exitCode = 1;
      });
  }
}
