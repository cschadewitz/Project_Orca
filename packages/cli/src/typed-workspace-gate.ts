/** Managed Linux composition only. No CLI/RPC/config/env path constructs this owner.
 * The stable launcher must supply real lifetime exclusion and an accepted image.
 * Parsed marker bytes alone never establish either fact. */
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  bindInactiveTypedSidecarOwner,
  createInactiveTypedSidecarStore,
  parseTypedCompatibilityMarkerBytes,
  type TypedCompatibilityMarker,
  type TypedSidecarOwnerPorts,
} from "@orca/agents";
import { OrcaError } from "@orca/core";

/** Remains empty until the complete installed path has independent qualification. */
export const ACCEPTED_MANAGED_TYPED_BUILDS: readonly string[] = Object.freeze([]);
/** Parent passes this provider's result into daemon composition. No wire-visible
 * owner, marker, path or construction parameters are part of the contract. */
export type ManagedTypedStoreAvailability =
  | { readonly available: false; readonly reason: "trusted-linux-owner-unavailable" }
  | {
      readonly available: true;
      readonly contract: "orca-typed-sidecar-v1";
      readonly store: ReturnType<typeof createInactiveTypedSidecarStore>;
    };
export type ManagedTypedStoreProvider = () => Promise<ManagedTypedStoreAvailability>;
/** Default daemon registration can consume this without gaining an owner factory. */
export const unavailableManagedTypedStore: ManagedTypedStoreProvider = () =>
  Promise.resolve({ available: false, reason: "trusted-linux-owner-unavailable" });

function fail(reason: string): never {
  throw new OrcaError(
    "CONFIG_INVALID",
    `Typed workspace compatibility unavailable: ${reason}. Keep enrollment and recovery evidence intact.`,
  );
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const inside = (parent: string, child: string) => child === parent || child.startsWith(parent + sep);
type Identity = { readonly path: string; readonly device: number; readonly inode: number };
export type ManagedRootRole = "config" | "sidecar" | "store";
export interface ManagedRootInput {
  readonly role: ManagedRootRole;
  readonly path: string;
}
export interface ManagedRootBinding {
  readonly control: Identity;
  readonly releases: Identity;
  readonly workspaceIdentity: Identity & { readonly digest: string; readonly directory: Identity };
  readonly roles: readonly {
    readonly role: ManagedRootRole;
    readonly path: string;
    readonly directory: Identity;
    readonly target: string;
  }[];
  readonly targets: readonly Identity[];
  readonly rootBindingRef: string;
}

function canonical(path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path) fail("noncanonical root");
  for (let cursor = path; ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) fail("root alias");
    if (dirname(cursor) === cursor) break;
  }
  if (realpathSync(path) !== path) fail("root alias");
  return path;
}
function directory(path: string): Identity {
  canonical(path);
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) fail("directory ownership");
  return Object.freeze({ path, device: stat.dev, inode: stat.ino });
}
/** Bounded, no-follow metadata read. Revalidate path identity after reading the handle. */
function metadata(path: string): Buffer {
  canonical(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o077) !== 0 ||
      before.size > 64 * 1024
    )
      fail("metadata ownership or size");
    const buffer = Buffer.alloc(64 * 1024 + 1);
    let length = 0;
    for (;;) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      length += count;
      if (count === 0 || length === buffer.length) break;
    }
    const bytes = buffer.subarray(0, length);
    const after = fstatSync(fd),
      named = lstatSync(path);
    if (
      bytes.length > 64 * 1024 ||
      before.dev !== named.dev ||
      before.ino !== named.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      named.isSymbolicLink()
    )
      fail("metadata changed");
    return bytes;
  } finally {
    closeSync(fd);
  }
}
function present(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Retains logical roles while collapsing identical/descendant physical targets. */
export function resolveManagedRootBinding(
  inputs: readonly ManagedRootInput[],
  controlPath: string,
  releaseDirectory: string,
): ManagedRootBinding {
  if (process.platform !== "linux") fail("unsupported platform");
  const paths = new Map<ManagedRootRole, string>();
  for (const { role, path } of inputs) {
    if (!["config", "sidecar", "store"].includes(role) || (paths.has(role) && paths.get(role) !== path))
      fail("conflicting role");
    paths.set(role, path);
  }
  if (paths.size !== 3) fail("missing role");
  const config = paths.get("config")!,
    sidecar = paths.get("sidecar")!,
    store = paths.get("store")!;
  // First path deliberately fixes the sidecar name; it cannot be redirected by a caller.
  if (sidecar !== join(config, "orca.permissions.json")) fail("unsupported sidecar layout");
  const control = directory(controlPath);
  const releases = directory(releaseDirectory);
  const directories = [directory(config), directory(dirname(sidecar)), directory(store)];
  if (present(sidecar)) metadata(sidecar);
  const unique = [...new Map(directories.map((d) => [d.path, d])).values()].sort(
    (a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  const targets = unique.filter((d, index) => !unique.slice(0, index).some((p) => inside(p.path, d.path)));
  if (targets.some((d) => inside(d.path, control.path) || inside(control.path, d.path)))
    fail("control overlaps restore target");
  if ([control, ...targets].some((d) => inside(releases.path, d.path) || inside(d.path, releases.path)))
    fail("control or workspace overlaps selected releases");
  const idPath = join(store, "workspace-identity", "id"),
    idDirectory = directory(dirname(idPath));
  const idBytes = metadata(idPath),
    idStat = lstatSync(idPath);
  const workspaceIdentity = Object.freeze({
    path: idPath,
    device: idStat.dev,
    inode: idStat.ino,
    digest: hash(idBytes.toString("hex")),
    directory: idDirectory,
  });
  const roles = (["config", "sidecar", "store"] as const).map((role, index) =>
    Object.freeze({
      role,
      path: paths.get(role)!,
      directory: directories[index]!,
      target: targets.find((p) => inside(p.path, directories[index]!.path))!.path,
    }),
  );
  const value = { control, releases, workspaceIdentity, roles, targets };
  return Object.freeze({
    ...value,
    roles: Object.freeze(roles),
    targets: Object.freeze(targets),
    rootBindingRef: hash(JSON.stringify(value)),
  });
}
function assertBinding(binding: ManagedRootBinding): undefined {
  if (
    !isDeepStrictEqual(resolveManagedRootBinding(binding.roles, binding.control.path, binding.releases.path), binding)
  )
    fail("original root identity changed");
  return undefined;
}
function durableNew(path: string, bytes: string): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export interface ManagedLifetimeOwner {
  /** Real shared launch ownership or exclusive enrollment ownership, not PID/age/idle. */
  readonly mode: "runtime" | "enrollment";
  assertCurrent(this: void): undefined;
}
/** Trusted implementation ports, deliberately absent from command options and exports.
 * No default proof exists. Installing a bridge and accepting builds is separate work. */
export interface ManagedTypedOwnerPorts {
  readonly binding: ManagedRootBinding;
  readonly lifetime: ManagedLifetimeOwner;
  /** Exact image verification under retained ownership, never semver/hello/manifest trust. */
  assertBuildCurrent(this: void): undefined;
  readonly qualify: TypedSidecarOwnerPorts["qualify"];
  /** Test fault boundary; no production constructor uses it. */
  readonly afterEnrollmentCommit?: () => void;
}

/** Internal trusted composition. Provisioned legacy evidence is required even on first
 * inspection. Startup never provisions/repairs it or infers legacy from v1/absent bytes.
 * The external immutable owner inventory binds this exact control/root/workspace set. */
export function createManagedTypedWorkspace(ports: ManagedTypedOwnerPorts) {
  const binding = structuredClone(ports.binding);
  const lifetimeMode = ports.lifetime.mode,
    assertLifetime = ports.lifetime.assertCurrent,
    build = ports.assertBuildCurrent,
    qualify = ports.qualify;
  const afterCommit = ports.afterEnrollmentCommit;
  const control = binding.control.path;
  const sidecar = binding.roles.find((r) => r.role === "sidecar")!.path;
  const storeDir = binding.roles.find((r) => r.role === "store")!.path;
  const identityPath = join(storeDir, "workspace-identity", "id");
  const originalIdentity = metadata(identityPath).toString("utf8");
  const identityStat = lstatSync(identityPath);
  const identityDirectory = directory(dirname(identityPath));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\n$/i.test(originalIdentity))
    fail("workspace identity");
  const workspaceRef = hash(originalIdentity);
  const legacy = join(control, "never-typed"),
    intent = join(control, "intent.json"),
    enrolled = join(control, "enrolled.json");
  const legacyBytes = `${workspaceRef}\n${binding.rootBindingRef}\n`;
  let uncertain = false;
  function assertCurrent(): undefined {
    if (uncertain) fail("uncertain enrollment; explicit inspection required");
    if (assertLifetime() !== undefined || build() !== undefined) fail("asynchronous ownership assertion");
    assertBinding(binding);
    const currentIdentity = lstatSync(identityPath);
    if (
      metadata(identityPath).toString("utf8") !== originalIdentity ||
      identityStat.ino !== currentIdentity.ino ||
      identityStat.dev !== currentIdentity.dev ||
      !isDeepStrictEqual(directory(dirname(identityPath)), identityDirectory)
    )
      fail("original workspace identity changed");
    return undefined;
  }
  const expectedRefs = {
    version: 1 as const,
    workspaceRef,
    sidecarRef: hash(sidecar),
    format: "orca-permissions-v2" as const,
    minimumWriterContract: "orca-typed-sidecar-v1" as const,
    rootBindingRef: binding.rootBindingRef,
  };
  function markerAt(path: string): TypedCompatibilityMarker {
    const marker = parseTypedCompatibilityMarkerBytes(metadata(path));
    for (const key of Object.keys(expectedRefs) as (keyof typeof expectedRefs)[])
      if (marker[key] !== expectedRefs[key]) fail("enrollment binding mismatch");
    return marker;
  }
  function inspect():
    { state: "never-typed" } | { state: "enrollment-pending" | "enrolled"; marker: TypedCompatibilityMarker } {
    assertCurrent();
    if (!present(intent)) {
      if (present(enrolled) || metadata(legacy).toString("utf8") !== legacyBytes) fail("missing enrollment intent");
      return { state: "never-typed" };
    }
    const pending = markerAt(intent);
    if (pending.state !== "enrollment-pending" || present(legacy)) fail("mixed enrollment state");
    if (!present(enrolled)) return { state: "enrollment-pending", marker: pending };
    const confirmed = markerAt(enrolled);
    if (!isDeepStrictEqual(confirmed, { ...pending, state: "enrolled" })) fail("enrollment confirmation mismatch");
    assertCurrent();
    return { state: "enrolled", marker: confirmed };
  }
  function boundStore(marker: TypedCompatibilityMarker) {
    const retained = structuredClone(marker);
    const assertMarker = (): undefined => {
      const current = inspect();
      if (current.state === "never-typed" || !isDeepStrictEqual(current.marker, retained)) fail("enrollment changed");
      return undefined;
    };
    const owner = bindInactiveTypedSidecarOwner({
      file: sidecar,
      marker: retained,
      qualify,
      checkCompatibility: () => {
        assertMarker();
        return Promise.resolve(structuredClone(retained));
      },
      assertCompatibilityCurrent: (candidate) => {
        if (!isDeepStrictEqual(candidate, retained)) fail("owner marker changed");
        return assertMarker();
      },
    });
    return createInactiveTypedSidecarStore(owner);
  }
  async function openStore() {
    const state = inspect();
    if (state.state !== "enrolled") fail("enrollment incomplete");
    const store = boundStore(state.marker);
    await store.read();
    if (!isDeepStrictEqual(inspect(), state)) fail("enrollment changed during inspection");
    return store;
  }
  const currentStore: ManagedTypedStoreProvider = async () => {
    try {
      return { available: true, contract: "orca-typed-sidecar-v1", store: await openStore() };
    } catch {
      return { available: false, reason: "trusted-linux-owner-unavailable" };
    }
  };
  return Object.freeze({
    inspect,
    currentStore,
    /** Only trusted exclusive composition may call this. Failure never retries or erases intent. */
    async enrollFresh() {
      if (lifetimeMode !== "enrollment" || inspect().state !== "never-typed")
        fail("fresh exclusive enrollment required");
      if (present(sidecar)) fail("fresh absent sidecar required");
      const marker: TypedCompatibilityMarker = {
        ...expectedRefs,
        enrollmentRef: randomUUID(),
        state: "enrollment-pending",
      };
      try {
        assertCurrent();
        // Removal before intent makes every interrupted edge closed, including lost intent.
        unlinkSync(legacy);
        syncDirectory(control);
        durableNew(intent, JSON.stringify(marker));
        const initialized = await boundStore(marker).initializeFresh();
        assertCurrent();
        durableNew(enrolled, JSON.stringify({ ...marker, state: "enrolled" }));
        afterCommit?.();
        const confirmed = inspect();
        if (confirmed.state !== "enrolled") fail("enrollment not confirmed");
        const store = boundStore(confirmed.marker);
        const read = await store.read();
        assertCurrent();
        if (read.revision !== initialized.revision) fail("initial policy changed");
        return store;
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    openStore,
    /** Dispatch in the same stack as the final synchronous retained-owner assertion. */
    async dispatch<T>(
      action: "launch" | "update" | "rollback" | "retarget" | "reset" | "legacy-write",
      dispatch: () => T,
    ): Promise<T> {
      const state = inspect();
      if (state.state !== "never-typed") {
        if (state.state !== "enrolled" || action !== "launch") fail("managed operation refused for enrolled workspace");
        await boundStore(state.marker).read();
      }
      if (!isDeepStrictEqual(inspect(), state)) fail("enrollment changed before dispatch");
      return dispatch();
    },
  });
}

/** Pre-producer refusal locator, never an ownership/enablement receipt. An unsupported
 * managed path carrying this evidence cannot fall through to stores, auth or plugins. */
export function assertNoUnownedTypedWorkspace(paths: readonly string[]): void {
  for (const path of paths) {
    for (let cursor = resolve(path); ; cursor = dirname(cursor)) {
      if (present(join(cursor, ".orca-typed-workspace"))) fail("trusted Linux inspection bridge required");
      if (dirname(cursor) === cursor) break;
    }
  }
}
