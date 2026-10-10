/** Node-only participating-writer fence. No renderer export or legacy-writer authority. */
import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createServer, type Server } from "node:net";
import { z } from "zod";
import { assertFenceVolume, fenceBoot, fenceDirectory, fenceHash, FenceDirectorySchema } from "./first-run-fence.js";

const GUARD = ".orca-update-window.json";
const SLOTS = 8;
const uuid = z.uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const AnchorSchema = z.strictObject({
  version: z.literal(1),
  id: uuid,
  root: FenceDirectorySchema,
  control: FenceDirectorySchema,
});
export const UpdateWindowStateSchema = z.strictObject({
  version: z.literal(1),
  id: uuid,
  roots: z.array(FenceDirectorySchema).min(1).max(32),
  phase: z.enum([
    "open",
    "draining",
    "deferring",
    "stopping",
    "closed",
    "migrating",
    "validating",
    "restoring",
    "restored",
    "validated",
  ]),
  attempt: uuid.nullable(),
  candidate: digest.nullable(),
  launchHash: digest.nullable(),
});
export type UpdateWindowState = z.infer<typeof UpdateWindowStateSchema>;
/** Darwin must supply the packaged native F_FULLFSYNC descriptor adapter. */
export interface UpdateWindowDurability {
  fileSync(fd: number): void;
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const unavailable = () => new Error("Protected update window unavailable");

function read(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      before.mode & 0o077 ||
      before.size > 16384
    )
      throw unavailable();
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    const entry = lstatSync(path);
    if (
      bytes.length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      entry.dev !== before.dev ||
      entry.ino !== before.ino
    )
      throw unavailable();
    return JSON.parse(bytes.toString("utf8"));
  } finally {
    closeSync(fd);
  }
}
function syncDirectory(path: string) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
/** Intent temp survives lost acknowledgement. It is never automatically removed/retried. */
function write(path: string, value: unknown, replace = false, durability?: UpdateWindowDurability) {
  if (process.platform === "darwin" && !durability) throw unavailable();
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  if (bytes.length > 16384) throw unavailable();
  const destination = replace ? path + ".tmp" : path;
  const fd = openSync(
    destination,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, bytes);
    if (durability) durability.fileSync(fd);
    else fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
  if (replace) {
    renameSync(destination, path);
    syncDirectory(dirname(path));
  }
}
function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function state(control: string, requireEnrollment = true): UpdateWindowState {
  if (exists(join(control, "window.json.tmp"))) throw unavailable();
  const result = UpdateWindowStateSchema.parse(read(join(control, "window.json")));
  if (requireEnrollment) {
    const expected = { version: 1, id: result.id, roots: result.roots, control: fenceDirectory(control) };
    if (!same(read(join(control, "enrolled.json")), expected)) throw unavailable();
  }
  return result;
}
function anchor(root: string) {
  const result = AnchorSchema.parse(read(join(root, GUARD)));
  if (!same(result.root, fenceDirectory(root)) || !same(result.control, fenceDirectory(result.control.path)))
    throw unavailable();
  const current = state(result.control.path);
  if (current.id !== result.id || !current.roots.some((r) => same(r, result.root))) throw unavailable();
  return { anchor: result, state: current };
}

/** Validate every retained enrollment against its live directory and immutable anchor. */
export function inspectUpdateWindowRoots(control: string): UpdateWindowState {
  const current = state(control),
    identity = fenceDirectory(control);
  for (const root of current.roots)
    if (!same(anchor(root.path).anchor, { version: 1, id: current.id, root, control: identity })) throw unavailable();
  return structuredClone(current);
}

/** New admissions require the durable window to remain open. */
export function updateAdmissionOpen(root: string): boolean {
  try {
    return anchor(root).state.phase === "open";
  } catch {
    return false;
  }
}
/** A held lifetime writer may finish existing work until the final stop boundary.
 * This is not permission to acquire ownership or start a new run. */
export function updateExistingWorkAllowed(root: string): boolean {
  try {
    return ["open", "draining", "deferring"].includes(anchor(root).state.phase);
  } catch {
    return false;
  }
}
function port(root: z.infer<typeof FenceDirectorySchema>, slot: number) {
  // Include kernel domain: an unsupported/shared volume is refused, never given an alternate lock.
  return (
    20000 +
    (Number.parseInt(
      fenceHash(JSON.stringify(["orca-update-window-v1", fenceBoot().kernelDomain, root])).slice(0, 8),
      16,
    ) %
      5000) *
      SLOTS +
    slot
  );
}
async function hold(root: z.infer<typeof FenceDirectorySchema>, slot: number): Promise<Server> {
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.end();
  });
  server.maxConnections = 1;
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: port(root, slot), exclusive: true, reusePort: false }, () => {
      server.removeListener("error", reject);
      done();
    });
  });
  server.on("error", () => {});
  server.unref();
  return server;
}
const close = (server: Server) => new Promise<void>((done) => server.close(() => done()));
export interface UpdateWriterLease {
  readonly root: string;
  check(): boolean;
  close(): Promise<void>;
}

/** Acquire before bootstrap/migration/auth/store writes, then check DURABLE admission.
 * Existing holders may finish naturally during drain. The kernel retains their slot until
 * process exit or explicit clean writer shutdown, even if the app/supervisor crashes. */
export async function enterUpdateWriter(
  root: string,
  launch?: { attempt: string; token: string },
): Promise<UpdateWriterLease | undefined> {
  if (!exists(join(root, GUARD))) return undefined; // Unenrolled is never update-owner proof.
  assertFenceVolume(root);
  const initial = anchor(root);
  let server: Server | undefined;
  for (let slot = 0; slot < SLOTS; slot++) {
    try {
      server = await hold(initial.anchor.root, slot);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE") throw error;
    }
  }
  if (!server) throw unavailable();
  let closed = false;
  try {
    const current = anchor(root);
    const replacement =
      launch &&
      current.state.attempt === launch.attempt &&
      current.state.launchHash === fenceHash(launch.token) &&
      ["migrating", "validating"].includes(current.state.phase);
    if (!same(current.anchor, initial.anchor) || (current.state.phase !== "open" && !replacement)) throw unavailable();
    const attempt = current.state.attempt;
    return {
      root,
      check() {
        if (closed || !server.listening) return false;
        try {
          const now = anchor(root);
          return (
            same(now.anchor, initial.anchor) &&
            (replacement
              ? now.state.attempt === attempt && ["migrating", "validating"].includes(now.state.phase)
              : true)
          );
        } catch {
          return false;
        }
      },
      async close() {
        if (!closed) {
          closed = true;
          await close(server);
        }
      },
    };
  } catch (error) {
    await close(server);
    throw error;
  }
}

/** Also inspect ancestors: a store/config alias cannot bypass an enrolled parent. */
export async function enterConfiguredUpdateWriters(
  paths: readonly string[],
  launch?: { attempt: string; token: string },
): Promise<UpdateWriterLease[]> {
  const roots = configuredUpdateWriterRoots(paths);
  const leases: UpdateWriterLease[] = [];
  try {
    for (const root of roots) {
      const lease = await enterUpdateWriter(root, launch);
      if (!lease) throw unavailable();
      leases.push(lease);
    }
    return leases;
  } catch (error) {
    for (const lease of leases) await lease.close();
    throw error;
  }
}
export function configuredUpdateWriterRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const input of paths) {
    let path = resolve(input);
    for (let depth = 0; depth < 256; depth++) {
      if (exists(join(path, GUARD))) roots.add(path);
      const parent = dirname(path);
      if (parent === path) break;
      path = parent;
    }
  }
  return [...roots].sort();
}

/** Provision only under explicit pre-producer, participating-launch-set ownership.
 * window.json is durable BEFORE anchors. Interrupted enrollment can only be completed for
 * the exact recorded set; a lost control namespace behind any surviving anchor refuses. */
export async function provisionUpdateWindow(
  control: string,
  roots: readonly string[],
  durability?: UpdateWindowDurability,
): Promise<void> {
  if (
    !isAbsolute(control) ||
    resolve(control) !== control ||
    !roots.length ||
    roots.length > 32 ||
    new Set(roots).size !== roots.length
  )
    throw unavailable();
  const identity = fenceDirectory(control);
  const bindings = roots
    .map((root) => {
      assertFenceVolume(root);
      return fenceDirectory(root);
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  if (
    bindings.some(
      (r) =>
        r.path === control ||
        control.startsWith(r.path + "/") ||
        r.path.startsWith(control + "/") ||
        bindings.some((other) => other !== r && r.path.startsWith(other.path + "/")),
    )
  )
    throw unavailable();
  const handles: Server[] = [];
  try {
    for (const root of bindings) for (let slot = 0; slot < SLOTS; slot++) handles.push(await hold(root, slot));
    let current: UpdateWindowState;
    if (exists(join(control, "window.json"))) {
      current = state(control, exists(join(control, "enrolled.json")));
      if (current.phase !== "open" || !same(current.roots, bindings)) throw unavailable();
    } else {
      if (bindings.some((r) => exists(join(r.path, GUARD)))) throw unavailable();
      current = {
        version: 1,
        id: randomUUID(),
        roots: bindings,
        phase: "open",
        attempt: null,
        candidate: null,
        launchHash: null,
      };
      write(join(control, "window.json"), current, false, durability);
    }
    for (const root of bindings) {
      const value = { version: 1, id: current.id, root, control: identity };
      if (exists(join(control, "enrolled.json")) && !exists(join(root.path, GUARD))) throw unavailable();
      if (exists(join(root.path, GUARD))) {
        if (!same(read(join(root.path, GUARD)), value)) throw unavailable();
      } else write(join(root.path, GUARD), value, false, durability);
    }
    const enrollment = { version: 1, id: current.id, roots: bindings, control: identity };
    if (exists(join(control, "enrolled.json"))) {
      if (!same(read(join(control, "enrolled.json")), enrollment)) throw unavailable();
    } else write(join(control, "enrolled.json"), enrollment, false, durability);
  } finally {
    for (const handle of handles) await close(handle);
  }
}

/** Extend an OPEN managed namespace before starting a producer for its new roots.
 * Existing root identities/anchors never change. Enrollment owns every new root slot
 * and a control mutex. A torn publication closes admission rather than repairing it.
 * This excludes participating producers, not arbitrary filesystem writers. */
export async function enrollUpdateWindowRoots(
  control: string,
  requested: readonly string[],
  durability?: UpdateWindowDurability,
): Promise<UpdateWindowState> {
  if (!isAbsolute(control) || resolve(control) !== control || !requested.length || requested.length > 32)
    throw unavailable();
  const identity = fenceDirectory(control);
  const mutex = await hold(identity, 0);
  const held: Server[] = [];
  try {
    const current = state(control);
    if (current.phase !== "open" || current.attempt !== null) throw unavailable();
    for (const root of current.roots)
      if (!same(anchor(root.path).anchor, { version: 1, id: current.id, root, control: identity })) throw unavailable();
    const paths = [...new Set(requested)];
    if (paths.some((path) => !isAbsolute(path) || resolve(path) !== path)) throw unavailable();
    // A parent root covers its configured store descendants. Existing enrolled roots
    // cannot be replaced by a broader parent or transplanted to another namespace.
    const additions = paths
      .filter(
        (path) =>
          !current.roots.some((root) => path === root.path || path.startsWith(root.path + "/")) &&
          !paths.some((other) => path !== other && path.startsWith(other + "/")),
      )
      .map((path) => {
        assertFenceVolume(path);
        return fenceDirectory(path);
      });
    const roots = [...current.roots, ...additions].sort((a, b) => a.path.localeCompare(b.path));
    if (
      roots.length > 32 ||
      roots.some(
        (root) =>
          root.path === control ||
          root.path.startsWith(control + "/") ||
          control.startsWith(root.path + "/") ||
          roots.some((other) => other !== root && root.path.startsWith(other.path + "/")),
      )
    )
      throw unavailable();
    if (!additions.length) return current;
    for (const root of additions) {
      if (exists(join(root.path, GUARD))) throw unavailable();
      for (let slot = 0; slot < SLOTS; slot++) held.push(await hold(root, slot));
    }
    if (
      !same(state(control), current) ||
      !same(fenceDirectory(control), identity) ||
      additions.some((root) => !same(fenceDirectory(root.path), root))
    )
      throw unavailable();
    const next = UpdateWindowStateSchema.parse({ ...current, roots });
    // Until the final enrollment publication, ordinary readers refuse the mismatch.
    write(join(control, "window.json"), next, true, durability);
    for (const root of additions)
      write(join(root.path, GUARD), { version: 1, id: current.id, root, control: identity }, false, durability);
    write(join(control, "enrolled.json"), { version: 1, id: current.id, roots, control: identity }, true, durability);
    return inspectUpdateWindowRoots(control);
  } finally {
    for (const slot of held) await close(slot);
    await close(mutex);
  }
}

/** Exclusive capture after closure/drain. Crash releases sockets, NEVER the durable closure.
 * No admission release API exists until validation or a full restored pair has succeeded. */
export class ClosedUpdateWindow {
  private handles: Server[] = [];
  private current: UpdateWindowState;
  private failed = false;
  private migration = false;
  private acquiring = false;
  private approvedAttempt: string | undefined;
  private readonly pending = new Set<Promise<unknown>>();
  /** Seal immediately while keeping lifetime slots until all dispatched writes settle. */
  seal(): void {
    this.failed = true;
  }
  track<T>(work: () => Promise<T>): Promise<T> {
    if (!this.check()) return Promise.reject(unavailable());
    const operation = Promise.resolve().then(work);
    this.pending.add(operation);
    void operation.then(
      () => this.pending.delete(operation),
      () => this.pending.delete(operation),
    );
    return operation;
  }
  constructor(
    private readonly control: string,
    private readonly durability?: UpdateWindowDurability,
  ) {
    this.current = state(control);
  }
  get snapshot(): Readonly<UpdateWindowState> {
    return structuredClone(this.current);
  }
  check(): boolean {
    try {
      return (
        !this.failed &&
        this.handles.length === this.current.roots.length * SLOTS &&
        this.handles.every((h) => h.listening) &&
        same(state(this.control), this.current) &&
        this.current.roots.every((r) => same(anchor(r.path).anchor.root, r))
      );
    } catch {
      return false;
    }
  }
  migrationHeld(): boolean {
    try {
      return (
        this.migration &&
        !this.failed &&
        !this.acquiring &&
        this.handles.length === this.current.roots.length * (SLOTS - 1) &&
        this.handles.every((handle) => handle.listening) &&
        same(state(this.control), this.current) &&
        this.current.roots.every((root) => same(anchor(root.path).anchor.root, root))
      );
    } catch {
      return false;
    }
  }
  private commit(next: UpdateWindowState) {
    if (this.failed || !same(state(this.control), this.current)) throw unavailable();
    try {
      write(join(this.control, "window.json"), UpdateWindowStateSchema.parse(next), true, this.durability);
      this.current = next;
    } catch (error) {
      this.failed = true;
      throw error;
    }
  }
  closeAdmission(candidate: string, attempt = randomUUID()): void {
    if (this.current.phase !== "open") throw unavailable();
    digest.parse(candidate);
    uuid.parse(attempt);
    this.commit({ ...this.current, phase: "draining", attempt, candidate });
    this.approvedAttempt = attempt;
  }
  beginStop(): void {
    if (this.current.phase !== "draining" || this.failed) throw unavailable();
    this.commit({ ...this.current, phase: "stopping" });
  }
  beginDefer(candidate: string, attempt: string): boolean {
    if (
      this.current.phase !== "draining" ||
      this.approvedAttempt !== attempt ||
      this.current.attempt !== attempt ||
      this.current.candidate !== candidate ||
      this.handles.length ||
      this.acquiring ||
      this.pending.size
    )
      return false;
    this.commit({ ...this.current, phase: "deferring" });
    return true;
  }
  finishDefer(candidate: string, attempt: string): boolean {
    if (
      this.current.phase !== "deferring" ||
      this.approvedAttempt !== attempt ||
      this.current.attempt !== attempt ||
      this.current.candidate !== candidate ||
      this.handles.length ||
      this.acquiring ||
      this.pending.size
    )
      return false;
    this.commit({ ...this.current, phase: "open", attempt: null, candidate: null, launchHash: null });
    this.approvedAttempt = undefined;
    return true;
  }
  /** Busy callers retain draining; they may retry capture after existing writers finish. */
  async capture(): Promise<boolean> {
    if (this.current.phase === "open" || this.failed || this.handles.length || this.acquiring) throw unavailable();
    this.acquiring = true;
    try {
      for (const root of this.current.roots)
        for (let slot = 0; slot < SLOTS; slot++) this.handles.push(await hold(root, slot));
      if (!this.check()) throw unavailable();
      if (["draining", "stopping"].includes(this.current.phase)) this.commit({ ...this.current, phase: "closed" });
      return true;
    } catch (error) {
      await this.detach();
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
      throw error;
    } finally {
      this.acquiring = false;
    }
  }
  setPhase(phase: "validating" | "restoring" | "restored" | "validated") {
    if (!this.check()) throw unavailable();
    const allowed = {
      validating: ["closed", "migrating"],
      restoring: ["closed", "migrating", "validating", "restoring"],
      restored: ["restoring"],
      validated: ["validating"],
    };
    if (!allowed[phase].includes(this.current.phase)) throw unavailable();
    this.commit({ ...this.current, phase, launchHash: null });
  }
  /** Release exactly one slot per root only after the one-use migration capability is
   * durable. Ordinary writers still refuse. The supervisor cannot copy/restore/open until
   * the independently owned child has exited and every slot is reacquired. */
  async beginMigration(): Promise<{ attempt: string; token: string }> {
    if (!this.check() || this.current.phase !== "closed" || !this.current.attempt) throw unavailable();
    const token = randomUUID();
    this.commit({ ...this.current, phase: "migrating", launchHash: fenceHash(token) });
    this.migration = true;
    const released = this.handles.splice(0);
    for (let i = 0; i < released.length; i++) {
      if (i % SLOTS === 0) await close(released[i]!);
      else this.handles.push(released[i]!);
    }
    return { attempt: this.current.attempt, token };
  }
  /** No timeout/PID inference: a surviving child retains its kernel slot. After a
   * supervisor crash, fresh capture obtains ALL slots before inspecting failed migration. */
  async endMigration(): Promise<boolean> {
    if (!this.migration || this.current.phase !== "migrating" || this.acquiring) throw unavailable();
    this.acquiring = true;
    const reacquired: Server[] = [];
    try {
      for (const root of this.current.roots) reacquired.push(await hold(root, 0));
      this.handles.push(...reacquired);
      this.migration = false;
      if (!this.check()) throw unavailable();
      this.commit({ ...this.current, phase: "validating", launchHash: null });
      return true;
    } catch (error) {
      for (const handle of reacquired) {
        const index = this.handles.indexOf(handle);
        if (index >= 0) this.handles.splice(index, 1);
        await close(handle);
      }
      if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
      throw error;
    } finally {
      this.acquiring = false;
    }
  }
  reopen(): void {
    if (!this.check() || !["validated", "restored"].includes(this.current.phase)) throw unavailable();
    this.commit({ ...this.current, phase: "open", attempt: null, candidate: null, launchHash: null });
  }
  async detach(): Promise<void> {
    if (this.pending.size) {
      this.seal();
      await Promise.allSettled([...this.pending]);
    }
    const handles = this.handles.splice(0);
    for (const handle of handles) await close(handle);
  }
}

export { enterClosedFirstRunInspection } from "./closed-first-run-inspection.js";
