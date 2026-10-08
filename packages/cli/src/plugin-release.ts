/** Verify installed closed-bundle plugin identities against an independently pinned release attestation. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  pluginRestorationRefusal,
  type PluginRestorationIdentity,
  type PluginRestorationIdentityVerifier,
} from "@orca/engine";

/** Trusted composition supplies the pin independently of the installed manifest/plugin/config. */
export interface InstalledPluginRelease {
  root: string;
  manifestPath: string;
  manifestSha256: string;
}

export interface PluginReleaseManifest {
  contractVersion: 1;
  runtime: { node: string; platform: string; arch: string };
  plugins: {
    spec: string;
    id: string;
    schemaVersion: number;
    /** Publisher attests all JavaScript/dependencies are included; only declared Node builtins remain external. */
    closure: "closed-node-esm-bundle-v1";
    path: string;
    sha256: string;
    externalImports: string[];
  }[];
}

type Entry = { spec: string; url: string; digest: string };
export interface VerifiedPluginRelease {
  /** Identities are detached and frozen; never borrowed from plugin declarations. */
  identityFor(spec: string): Readonly<PluginRestorationIdentity> | undefined;
  verify: PluginRestorationIdentityVerifier;
}

const sha256Pattern = /^[a-f0-9]{64}$/;
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => pluginRestorationRefusal("identity_unverified");

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw refuse();
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== keys.length || keys.some((key) => !Object.hasOwn(record, key))) throw refuse();
  return record;
}

function text(value: unknown, maximum = 200): string {
  if (typeof value !== "string" || !value.length || value.length > maximum) throw refuse();
  return value;
}

function manifest(raw: unknown): PluginReleaseManifest {
  const value = object(raw, ["contractVersion", "runtime", "plugins"]);
  if (value.contractVersion !== 1) throw refuse();
  const runtime = object(value.runtime, ["node", "platform", "arch"]);
  if (!Array.isArray(value.plugins) || !value.plugins.length || value.plugins.length > 64) throw refuse();
  const ids = new Set<string>();
  const specs = new Set<string>();
  const paths = new Set<string>();
  const plugins = value.plugins.map((rawPlugin) => {
    const plugin = object(rawPlugin, ["spec", "id", "schemaVersion", "closure", "path", "sha256", "externalImports"]);
    const spec = text(plugin.spec, 4096);
    const id = text(plugin.id);
    const path = text(plugin.path, 4096);
    const sha256 = text(plugin.sha256);
    if (
      !sha256Pattern.test(sha256) ||
      !Number.isSafeInteger(plugin.schemaVersion) ||
      (plugin.schemaVersion as number) < 1 ||
      plugin.closure !== "closed-node-esm-bundle-v1" ||
      !path.endsWith(".mjs") ||
      ids.has(id) ||
      specs.has(spec) ||
      paths.has(path) ||
      !Array.isArray(plugin.externalImports) ||
      plugin.externalImports.length > 128
    )
      throw refuse();
    ids.add(id);
    specs.add(spec);
    paths.add(path);
    const externalImports = plugin.externalImports.map((item: unknown) => text(item));
    if (
      externalImports.some((item) => !item.startsWith("node:") || !isBuiltin(item)) ||
      new Set(externalImports).size !== externalImports.length
    )
      throw refuse();
    return {
      spec,
      id,
      schemaVersion: plugin.schemaVersion as number,
      closure: "closed-node-esm-bundle-v1" as const,
      path,
      sha256,
      externalImports: externalImports.sort(),
    };
  });
  return {
    contractVersion: 1,
    runtime: { node: text(runtime.node), platform: text(runtime.platform), arch: text(runtime.arch) },
    plugins,
  };
}

/** Require concrete contained paths; moving pointers, traversal and symlink aliases cannot name evidence. */
async function containedPath(root: string, path: string): Promise<string> {
  if (isAbsolute(path) || path.includes("\\") || path.split("/").some((part) => !part || part === "." || part === ".."))
    throw refuse();
  const absolute = resolve(root, path);
  const inside = relative(root, absolute);
  if (inside.startsWith("..") || isAbsolute(inside) || (await realpath(absolute)) !== absolute) throw refuse();
  return absolute;
}

async function visitFile(path: string, limit: number, consume: (chunk: Uint8Array) => void): Promise<void> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > limit) throw refuse();
    // Stream at most the initial size+1 bytes. A complete composition never needs 64 full bundles in memory.
    const bytes = Buffer.alloc(Math.min(info.size + 1, 64 * 1024));
    let length = 0;
    while (length <= info.size) {
      const { bytesRead } = await file.read(bytes, 0, Math.min(bytes.length, info.size + 1 - length), null);
      if (!bytesRead) break;
      consume(bytes.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length !== info.size || (await file.stat()).size !== info.size) throw refuse();
  } finally {
    await file.close();
  }
}

async function readBounded(path: string, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  await visitFile(path, limit, (chunk) => chunks.push(Buffer.from(chunk)));
  return Buffer.concat(chunks);
}

async function hashBundle(path: string): Promise<string> {
  const digest = createHash("sha256");
  await visitFile(path, 64 * 1024 * 1024, (chunk) => digest.update(chunk));
  return digest.digest("hex");
}

/**
 * The independently trusted pin attests the producer's complete-bundle claim. This function
 * checks that exact evidence, runtime and installed bytes; it does not discover arbitrary
 * JavaScript import closures or elevate a self-generated local manifest into authority.
 */
export async function loadInstalledPluginRelease(
  reference: InstalledPluginRelease,
  entries: readonly Entry[],
): Promise<VerifiedPluginRelease> {
  try {
    const root = resolve(reference.root);
    const pin = reference.manifestSha256;
    const manifestRelativePath = reference.manifestPath;
    if (!isAbsolute(reference.root) || !sha256Pattern.test(pin) || (await realpath(root)) !== root) throw refuse();
    const manifestPath = await containedPath(root, manifestRelativePath);
    const bytes = await readBounded(manifestPath, 128 * 1024);
    if (hash(bytes) !== pin) throw refuse();
    const evidence = manifest(JSON.parse(bytes.toString("utf8")) as unknown);
    if (
      evidence.runtime.node !== process.versions.node ||
      evidence.runtime.platform !== process.platform ||
      evidence.runtime.arch !== process.arch ||
      evidence.plugins.length !== entries.length
    )
      throw refuse();
    const installed = await Promise.all(
      evidence.plugins.map(async (plugin, index) => {
        const path = await containedPath(root, plugin.path);
        const entry = entries[index];
        if (
          !entry ||
          entry.spec !== plugin.spec ||
          entry.url !== pathToFileURL(path).href ||
          entry.digest !== plugin.sha256 ||
          (await hashBundle(path)) !== plugin.sha256
        )
          throw refuse();
        const identity = Object.freeze({
          id: plugin.id,
          schemaVersion: plugin.schemaVersion,
          codeVersion: `sha256:${plugin.sha256}`,
          dependencyIdentity: `sha256:${hash(
            JSON.stringify({
              closure: plugin.closure,
              bundleSha256: plugin.sha256,
              externalImports: plugin.externalImports,
              runtime: evidence.runtime,
            }),
          )}`,
        });
        return { path, spec: plugin.spec, digest: plugin.sha256, identity };
      }),
    );
    const checkInstalled = async () => {
      if (
        (await realpath(root)) !== root ||
        (await containedPath(root, manifestRelativePath)) !== manifestPath ||
        hash(await readBounded(manifestPath, 128 * 1024)) !== pin
      )
        return false;
      for (const plugin of installed) {
        if ((await realpath(plugin.path)) !== plugin.path || (await hashBundle(plugin.path)) !== plugin.digest)
          return false;
      }
      return true;
    };
    return Object.freeze({
      identityFor: (spec: string) => installed.find((plugin) => plugin.spec === spec)?.identity,
      verify: async (candidate: Parameters<PluginRestorationIdentityVerifier>[0]) => {
        try {
          const plugin = installed.find((item) => item.spec === candidate.spec);
          if (
            !plugin ||
            candidate.entry.url !== pathToFileURL(plugin.path).href ||
            candidate.entry.digest !== plugin.digest ||
            candidate.identity.id !== plugin.identity.id ||
            candidate.identity.schemaVersion !== plugin.identity.schemaVersion ||
            candidate.identity.codeVersion !== plugin.identity.codeVersion ||
            candidate.identity.dependencyIdentity !== plugin.identity.dependencyIdentity
          )
            return false;
          return await checkInstalled();
        } catch {
          return false;
        }
      },
    });
  } catch {
    throw refuse();
  }
}
