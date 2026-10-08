/** #402 delivery-v1 consumer shape and sealed identity checks; declarations are never native trust. */
import { createHash } from "node:crypto";
import { z } from "zod";

export function macContractText(value: string): boolean {
  if (typeof value !== "string" || !value.length || value.length > 1024 || value !== value.trim()) return false;
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (code < 32 || code === 127 || (code >= 0xd800 && code <= 0xdfff)) return false;
  }
  return true;
}
const text = z.string().refine(macContractText);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const semver =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const path = text.refine(
  (value) => !/[\\:]/.test(value) && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
);
const evidencePath = path.refine((value) => value.startsWith("evidence/"));
const version = text.regex(/^[0-9]+(?:\.[0-9]+)*(?:[-+][0-9A-Za-z.-]+)?$/);
const timestamp = text
  .regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|\+00:00)$/)
  .refine((value) => {
    const parsed = new Date(value);
    return (
      parsed.getUTCFullYear() > 0 &&
      Number.isFinite(parsed.getTime()) &&
      parsed.toISOString().slice(0, 19) === value.slice(0, 19)
    );
  });
export const NativeMacIdentitySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    releaseVersion: text.regex(semver),
    bundleId: z.literal("com.schadewitz.orca"),
    platform: z.literal("darwin"),
    arch: z.literal("arm64"),
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
    buildId: text.regex(/^gha:[0-9]+:[0-9]+:mac-arm64$/),
    builtAt: timestamp,
    appVersion: text,
    // Opaque plist strings: D5 version mapping is still an owner decision.
    bundleShortVersion: text,
    bundleVersion: text,
    daemon: z.strictObject({ path: z.literal("daemon/orca-daemon.mjs"), sha256: hash, version: text }),
    protocol: z.strictObject({ major: integer, minor: integer }),
    storeEpoch: text,
    toolchain: z.strictObject({
      electron: version,
      electronBuilder: version,
      node: version,
      pnpm: version,
      xcode: version,
      macos: version,
    }),
  })
  .refine((value) => value.appVersion === value.releaseVersion && value.daemon.version === value.releaseVersion);
const file = z.strictObject({ path, sha256: hash, bytes: integer.refine((value) => value > 0) });
const artifact = file.extend({ format: z.enum(["dmg", "zip"]) });
const notary = z.strictObject({
  submissionId: z.string().regex(/^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/),
  submittedSha256: hash,
  status: z.literal("Accepted"),
  logPath: evidencePath,
});
const staple = z.strictObject({ status: z.literal("passed"), reportPath: evidencePath });
const manifestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.enum(["candidate", "fixture"]),
    identity: NativeMacIdentitySchema,
    identitySha256: hash,
    artifacts: z.array(artifact).length(2),
    minimumMacOS: text.regex(/^[0-9]+(?:\.[0-9]+)*$/),
    signing: z.strictObject({
      teamId: text,
      certificateSha256: hash,
      authority: text.refine((value) => !["adhoc", "ad-hoc", "ad hoc", "-"].includes(value.toLowerCase())),
      hardenedRuntime: z.literal(true),
      verification: z.literal("passed"),
      reportPath: evidencePath,
    }),
    notarization: z.strictObject({ app: notary, dmg: notary }),
    stapling: z.strictObject({ appInDmg: staple, appInZip: staple, dmg: staple }),
    evidence: z.array(file.extend({ path: evidencePath })).max(128),
  })
  .refine((value) => {
    const paths = [
      "native-mac-artifact.json",
      "SHA256SUMS",
      ...value.artifacts.map((record) => record.path),
      ...value.evidence.map((record) => record.path),
    ];
    const evidence = new Set(value.evidence.map((record) => record.path));
    const refs = [
      value.signing.reportPath,
      value.notarization.app.logPath,
      value.notarization.dmg.logPath,
      value.stapling.appInDmg.reportPath,
      value.stapling.appInZip.reportPath,
      value.stapling.dmg.reportPath,
    ];
    return (
      new Set(paths).size === paths.length &&
      new Set(value.artifacts.map((record) => record.format)).size === 2 &&
      value.artifacts.every(
        (record) => record.path === `ORCA-${value.identity.releaseVersion}-mac-arm64.${record.format}`,
      ) &&
      refs.every((ref) => evidence.has(ref))
    );
  });
export type NativeMacManifest = z.infer<typeof manifestSchema>;
export type NativeMacIdentity = z.infer<typeof NativeMacIdentitySchema>;
export const MAC_METADATA_LIMIT = 64 * 1024;
export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Validate token boundaries before JSON.parse, rejecting duplicate/escaped-equivalent keys.
 * No prototype assignment or permissive JSON constants; bounded bytes and nesting. */
function json(bytes: Uint8Array): unknown {
  if (bytes.length > MAC_METADATA_LIMIT) throw new Error("Invalid candidate metadata");
  const source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  let index = 0;
  const white = () => {
    while (/[ \t\r\n]/.test(source[index] ?? "x")) index++;
  };
  const string = (): string => {
    const begin = index++;
    while (index < source.length) {
      if (source[index++] === '"') return JSON.parse(source.slice(begin, index)) as string;
      if (source[index - 1] === "\\") index++;
    }
    throw new Error("Invalid candidate metadata");
  };
  const value = (depth: number): void => {
    if (depth > 32) throw new Error("Invalid candidate metadata");
    white();
    const start = source[index];
    if (start === '"') {
      string();
      return;
    }
    if (start === "{" || start === "[") {
      index++;
      white();
      const end = start === "{" ? "}" : "]";
      const keys = new Set<string>();
      if (source[index] === end) {
        index++;
        return;
      }
      for (;;) {
        if (start === "{") {
          if (source[index] !== '"') throw new Error("Invalid candidate metadata");
          const key = string();
          if (keys.has(key)) throw new Error("Invalid candidate metadata");
          keys.add(key);
          white();
          if (source[index++] !== ":") throw new Error("Invalid candidate metadata");
        }
        value(depth + 1);
        white();
        const separator = source[index++];
        if (separator === end) return;
        if (separator !== ",") throw new Error("Invalid candidate metadata");
        white();
      }
    }
    const literal = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      source.slice(index),
    );
    if (!literal) throw new Error("Invalid candidate metadata");
    // delivery-v1 has only integer JSON numbers, as in the existing Python validator.
    if (/^[0-9-]/.test(literal[0]) && /[.eE]/.test(literal[0])) throw new Error("Invalid candidate metadata");
    index += literal[0].length;
  };
  value(0);
  white();
  if (index !== source.length) throw new Error("Invalid candidate metadata");
  return JSON.parse(source) as unknown;
}
export function readMacManifest(bytes: Uint8Array): NativeMacManifest {
  return manifestSchema.parse(json(bytes));
}
export function matchesSealedMacIdentity(manifest: NativeMacManifest, bytes: Uint8Array): boolean {
  if (sha256(bytes) !== manifest.identitySha256) return false;
  try {
    return JSON.stringify(NativeMacIdentitySchema.parse(json(bytes))) === JSON.stringify(manifest.identity);
  } catch {
    return false;
  }
}
export function freezeMacMetadata<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const nested of Object.values(value)) freezeMacMetadata(nested);
    Object.freeze(value);
  }
  return value;
}
