/** Bounded read-only observation of explicitly supplied owned roots; no backup, restore or writer fence. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import {
  RECOVERY_LIMITS,
  RecoveryRootSchema,
  RecoveryManifestSchema,
  pathCollisionKey,
  safeRecoveryPath,
  type RecoveryLimits,
  type RecoveryManifest,
  type RecoveryReason,
  type RecoveryRoot,
} from "./recovery-manifest.js";

const OwnedRootSchema = RecoveryRootSchema.omit({ entries: true, access: true, observedIdentity: true }).extend({
  path: z.string().min(1).max(4096),
});
const PlanSchema = RecoveryManifestSchema.pick({ candidateRef: true, references: true, external: true }).extend({
  roots: z.array(OwnedRootSchema).min(1).max(RECOVERY_LIMITS.maxRoots),
});
export type RecoveryInventoryPlan = z.infer<typeof PlanSchema>;
export type RecoveryInventoryResult =
  { ok: true; manifest: RecoveryManifest } | { ok: false; reasons: RecoveryReason[] };
class Refusal extends Error {
  constructor(readonly reason: RecoveryReason) {
    super(reason);
  }
}
const refuse = (reason: RecoveryReason): never => {
  throw new Refusal(reason);
};
const signature = (info: BigIntStats) =>
  `${info.dev}:${info.ino}:${info.mode}:${info.uid}:${info.gid}:${info.nlink}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
const access = (info: BigIntStats): RecoveryRoot["access"] => ({
  mode: Number(info.mode & 0o7777n),
  uid: Number(info.uid),
  gid: Number(info.gid),
  acl: process.platform === "win32" ? "unverified" : "posix-mode",
});
const covers = (base: string, path: string) => path === base || path.startsWith(`${base}/`);
const containsRoot = (base: string, path: string) => {
  const part = relative(base, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};

/** Budgets can only lower fixed hard ceilings. No callbacks, discovery or authority inputs. */
export async function inventoryRecoveryRoots(
  input: RecoveryInventoryPlan,
  requestedLimits: Partial<RecoveryLimits> = {},
): Promise<RecoveryInventoryResult> {
  let plan: RecoveryInventoryPlan;
  try {
    const parsed = PlanSchema.safeParse(input);
    if (!parsed.success) return { ok: false, reasons: ["ROOT_INVALID"] };
    plan = parsed.data;
  } catch {
    return { ok: false, reasons: ["ROOT_INVALID"] };
  }
  const limits: RecoveryLimits = { ...RECOVERY_LIMITS };
  for (const [key, value] of Object.entries(requestedLimits)) {
    if (!(key in limits) || !Number.isSafeInteger(value) || value < 0 || value > limits[key as keyof RecoveryLimits])
      return { ok: false, reasons: ["RESOURCE_LIMIT"] };
    limits[key as keyof RecoveryLimits] = value;
  }
  if (
    plan.roots.length > limits.maxRoots ||
    plan.references.length > limits.maxReferences ||
    plan.roots.some((root) => root.components.length > limits.maxComponents)
  )
    return { ok: false, reasons: ["RESOURCE_LIMIT"] };
  const names = new Set<string>();
  for (const root of plan.roots) {
    if (!isAbsolute(root.path) || resolve(root.path) !== root.path || root.path === resolve("/"))
      return { ok: false, reasons: ["ROOT_INVALID"] };
    if (names.has(root.id)) return { ok: false, reasons: ["ROOT_OVERLAP"] };
    names.add(root.id);
    if (
      root.role === "configuration" &&
      root.components.some(
        (component) =>
          component.id === "credentials" &&
          component.state !== "external-unverified" &&
          component.state !== "not-applicable" &&
          component.state !== "absent",
      )
    )
      return { ok: false, reasons: ["ROOT_INVALID"] };
  }
  for (const [index, root] of plan.roots.entries()) {
    for (const other of plan.roots.slice(index + 1)) {
      if (
        containsRoot(root.path, other.path) ||
        containsRoot(other.path, root.path) ||
        covers(pathCollisionKey(root.path), pathCollisionKey(other.path)) ||
        covers(pathCollisionKey(other.path), pathCollisionKey(root.path))
      )
        return { ok: false, reasons: ["ROOT_OVERLAP"] };
    }
  }
  const reasons = new Set<RecoveryReason>();
  const roots: RecoveryRoot[] = [];
  const observed = new Map<string, string>();
  let enumeration: RecoveryManifest["enumeration"] = "incomplete";
  let entryCount = 0,
    totalBytes = 0;
  const checkAccess = (info: BigIntStats) => {
    if (process.platform === "win32") reasons.add("ACL_UNVERIFIED");
    else if ((info.mode & 0o077n) !== 0n || Number(info.uid) !== process.getuid?.()) reasons.add("ACCESS_UNSAFE");
  };
  const remember = (path: string, info: BigIntStats) => {
    const previous = observed.get(path);
    if (previous !== undefined && previous !== signature(info)) refuse("OBSERVATION_CHANGED");
    observed.set(path, signature(info));
  };
  try {
    for (const supplied of plan.roots) {
      const rootInfo = await lstat(supplied.path, { bigint: true });
      if (rootInfo.isSymbolicLink()) refuse("SYMLINK_REFUSED");
      if (!rootInfo.isDirectory()) refuse("ROOT_INVALID");
      if ((await realpath(supplied.path)) !== supplied.path) refuse("SYMLINK_REFUSED");
      remember(supplied.path, rootInfo);
      checkAccess(rootInfo);
      const root: RecoveryRoot = {
        id: supplied.id,
        role: supplied.role,
        components: supplied.components,
        entries: [],
        access: access(rootInfo),
        ...(supplied.expectedIdentity ? { expectedIdentity: supplied.expectedIdentity } : {}),
      };
      roots.push(root);
      const folded = new Set<string>();
      const excluded = supplied.components
        .filter((component) => component.state === "external-unverified")
        .flatMap((component) => component.paths);
      const credentialPaths =
        supplied.role === "configuration"
          ? [
              "auth",
              ...supplied.components
                .filter((component) => component.id === "credentials")
                .flatMap((component) => component.paths),
            ]
          : [];
      // Inspect every owned entry, including hidden keys and previously unclassified files.
      const walk = async (directory: string, parent: string, depth: number): Promise<void> => {
        if (depth > limits.maxDepth) refuse("RESOURCE_LIMIT");
        const before = await lstat(directory, { bigint: true });
        if (!before.isDirectory()) refuse(before.isSymbolicLink() ? "SYMLINK_REFUSED" : "SPECIAL_FILE_REFUSED");
        remember(directory, before);
        if ((await realpath(directory)) !== directory) refuse("SYMLINK_REFUSED");
        const stream = await opendir(directory);
        for await (const child of stream) {
          const path = parent ? `${parent}/${child.name}` : child.name;
          if (!safeRecoveryPath(path) || path.length > limits.maxPathLength) refuse("PATH_UNSAFE");
          if (folded.has(pathCollisionKey(path))) refuse("PATH_COLLISION");
          folded.add(pathCollisionKey(path));
          if (++entryCount > limits.maxEntries) refuse("RESOURCE_LIMIT");
          if (excluded.some((base) => covers(base, path))) continue;
          // A mistaken absence declaration must never turn credential storage into an owned read.
          if (credentialPaths.some((base) => covers(base, path))) refuse("COMPONENT_MISSING");
          const absolute = join(directory, child.name);
          const info = await lstat(absolute, { bigint: true });
          if (info.isSymbolicLink()) refuse("SYMLINK_REFUSED");
          if (!info.isFile() && !info.isDirectory()) refuse("SPECIAL_FILE_REFUSED");
          remember(absolute, info);
          checkAccess(info);
          const entry = {
            path,
            size: info.isFile() ? Number(info.size) : 0,
            candidateRef: plan.candidateRef,
            identity: { device: String(info.dev), inode: String(info.ino) },
            access: access(info),
          };
          if (info.isDirectory()) {
            root.entries.push({ ...entry, kind: "directory" });
            await walk(absolute, path, depth + 1);
          } else {
            if (info.size > BigInt(limits.maxFileBytes) || info.size > BigInt(limits.maxTotalBytes - totalBytes))
              refuse("RESOURCE_LIMIT");
            // Reject changed ancestors before opening, and final-component symlinks in the open itself.
            if (
              signature(await lstat(directory, { bigint: true })) !== signature(before) ||
              (await realpath(directory)) !== directory
            )
              refuse("OBSERVATION_CHANGED");
            const file = await open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | constants.O_NONBLOCK);
            let digest: string;
            const identityBytes: Buffer[] = [];
            try {
              const opened = await file.stat({ bigint: true });
              if (!opened.isFile() || signature(opened) !== signature(info)) refuse("OBSERVATION_CHANGED");
              const hash = createHash("sha256"),
                buffer = Buffer.alloc(64 * 1024);
              let readBytes = 0;
              while (true) {
                const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
                if (!bytesRead) break;
                readBytes += bytesRead;
                totalBytes += bytesRead;
                if (
                  readBytes > limits.maxFileBytes ||
                  totalBytes > limits.maxTotalBytes ||
                  BigInt(readBytes) > info.size
                )
                  refuse("RESOURCE_LIMIT");
                hash.update(buffer.subarray(0, bytesRead));
                if (path === "workspace-identity/id") {
                  if (readBytes > 128) refuse("IDENTITY_MISMATCH");
                  identityBytes.push(Buffer.from(buffer.subarray(0, bytesRead)));
                }
              }
              if (BigInt(readBytes) !== info.size || signature(await file.stat({ bigint: true })) !== signature(info))
                refuse("OBSERVATION_CHANGED");
              digest = hash.digest("hex");
            } finally {
              await file.close();
            }
            if (signature(await lstat(absolute, { bigint: true })) !== signature(info)) refuse("OBSERVATION_CHANGED");
            root.entries.push({ ...entry, kind: "file", sha256: digest });
            if (path === "workspace-identity/id") {
              const id = Buffer.concat(identityBytes).toString("utf8").trim();
              if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))
                reasons.add("IDENTITY_MISMATCH");
              else root.observedIdentity = id;
            }
          }
        }
        if (signature(await lstat(directory, { bigint: true })) !== signature(before)) refuse("OBSERVATION_CHANGED");
      };
      await walk(supplied.path, "", 0);
      root.entries.sort((a, b) => a.path.localeCompare(b.path));
      if (root.role === "store") {
        if (
          !root.entries.some((entry) => entry.path === ".workspace-identified" && entry.kind === "file") ||
          !root.observedIdentity
        )
          reasons.add("IDENTITY_MISSING");
        if (root.expectedIdentity !== root.observedIdentity) reasons.add("IDENTITY_MISMATCH");
      }
    }
    for (const [path, before] of observed)
      if (signature(await lstat(path, { bigint: true })) !== before) refuse("OBSERVATION_CHANGED");
    enumeration = "complete";
  } catch (error) {
    reasons.add(error instanceof Refusal ? error.reason : "READ_FAILED");
  }
  if (!roots.length) return { ok: false, reasons: [...reasons] };
  const manifest: RecoveryManifest = {
    version: 1,
    candidateRef: plan.candidateRef,
    roots,
    references: plan.references,
    external: plan.external,
    enumeration,
    observation: [...reasons].some((reason) => reason !== "ACL_UNVERIFIED") ? "failed" : "unchanged",
    reasons: [...reasons],
  };
  // A partial observation cannot silently omit a supplied root.
  if (roots.length !== plan.roots.length)
    return { ok: false, reasons: [...new Set<RecoveryReason>([...reasons, "COMPONENT_MISSING"])] };
  if (Buffer.byteLength(JSON.stringify(manifest)) > limits.maxManifestBytes)
    return { ok: false, reasons: ["RESOURCE_LIMIT"] };
  return { ok: true, manifest };
}
