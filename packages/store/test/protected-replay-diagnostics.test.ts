/** Synthetic replay failures retain only fixed internal diagnostics, never protected values. */
import { chmod, cp, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { OrcaError } from "@orca/core";
import {
  observePrivateReads,
  protectedRecordInvalid,
  readPrivateJsonBatch,
  writePrivateJson,
} from "../src/protected-file.js";
import { FileExecutionStore } from "@orca/store";

const dirs: string[] = [];
const generic = "protected execution record or key is missing, invalid or unreadable";
const secret = "synthetic-protected-value";
const invalid = "protected execution record is missing or invalid";
const projection = { diagnostics: { protectedState: "unavailable" } };
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "orca-replay-diagnostics-"));
  dirs.push(dir);
  const store = new FileExecutionStore(dir);
  await store.putInputs({
    runId: "run",
    workflowId: "workflow",
    workflowVersion: "1",
    vars: {},
    sensitiveNames: [],
    secrets: [],
  });
  const refs = ["one", "two"].map((ref) => ({ runId: "run", ref, type: "vars.set" }));
  for (const { ref } of refs)
    await store.putPayload(ref, {
      type: "vars.set",
      runId: "run",
      payload: { vars: { secret: "synthetic-protected-value" } },
    });
  return { dir, store, refs, privateDir: join(dir, "private-execution") };
}
it.each([1, 2])("preserves the fixed validator diagnostic for %i record(s)", async (count) => {
  const f = await fixture();
  const refs = f.refs.slice(0, count).map((ref) => ({ ...ref, type: "run.started" }));
  await expect(f.store.getPayloads(refs)).rejects.toMatchObject({
    code: "RUN_STATE",
    message: invalid,
    details: projection,
  });
});

async function failure(work: Promise<unknown>, message: string) {
  const output = vi.fn();
  const error: unknown = await work.then(output).catch((error: unknown) => error);
  expect(output).not.toHaveBeenCalled();
  expect(error).toBeInstanceOf(OrcaError);
  const fault = error as OrcaError;
  expect(fault.toJSON()).toEqual({
    code: "RUN_STATE",
    message,
    ...(message === generic || message === invalid ? { details: projection } : {}),
  });
  expect(fault.cause).toBeUndefined();
  expect(String(error)).not.toContain(secret);
  expect(JSON.stringify(error)).not.toContain(secret);
  expect(fault.stack).not.toContain(secret);
  return fault;
}

it.each([1, 2])(
  "rejects malformed, tampered, swapped and missing payloads without output (%i records)",
  async (count) => {
    for (const kind of ["malformed", "tampered", "swapped", "missing"]) {
      const f = await fixture();
      const target = join(f.privateDir, `${f.refs[count - 1]!.ref}.payload.json`);
      if (kind === "missing") await rm(target);
      if (kind === "malformed") await writeFile(target, secret);
      if (kind === "swapped") {
        const other = count === 1 ? "two" : "one";
        await writeFile(target, await readFile(join(f.privateDir, `${other}.payload.json`)));
      }
      if (kind === "tampered") {
        const envelope = JSON.parse(await readFile(target, "utf8")) as { ciphertext: string };
        const bytes = Buffer.from(envelope.ciphertext, "base64");
        bytes[0] = bytes[0]! ^ 1;
        envelope.ciphertext = bytes.toString("base64");
        await writeFile(target, JSON.stringify(envelope));
      }
      await failure(f.store.getPayloads(f.refs.slice(0, count)), generic);
    }
  },
);

it.each([1, 2])("retains fixed authenticated schema/input/sensitivity refusals (%i records)", async (count) => {
  for (const kind of ["schema", "inputs", "sensitivity"]) {
    const f = await fixture();
    const ref = f.refs[count - 1]!.ref;
    const path = join(f.privateDir, `${ref}.payload.json`);
    await rm(path);
    await writePrivateJson(f.privateDir, `${ref}.payload.json`, {
      runId: "run",
      type: "vars.set",
      payload: kind === "schema" ? [secret] : { vars: { secret } },
      sensitivityRefs: kind === "sensitivity" ? [secret] : [],
    });
    if (kind === "inputs") await rm(join(f.privateDir, "run.inputs.json"));
    await failure(f.store.getPayloads(f.refs.slice(0, count)), invalid);
  }
});

const hostile = [
  () => new Error(secret, { cause: { secret } }),
  () => new OrcaError("RUN_STATE", secret, { secret }, { cause: secret }),
  () => new OrcaError("RUN_STATE", invalid, { secret }),
  () => Object.assign(new OrcaError("RUN_STATE", invalid), { extra: secret }),
  () => ({ code: "RUN_STATE", message: secret, details: { secret } }),
  () => secret,
  () => undefined,
  () =>
    new Proxy(
      {},
      {
        get() {
          throw new Error(secret);
        },
        getPrototypeOf() {
          throw new Error(secret);
        },
      },
    ),
];
it.each([1, 2])(
  "sanitizes unexpected validator failures, including forged errors and hostile objects (%i records)",
  async (count) => {
    const f = await fixture();
    for (const makeError of hostile) {
      vi.spyOn(f.store, "getInputs").mockImplementationOnce(async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- Exercise untrusted callback throws, including primitives.
        throw makeError();
      });
      await failure(f.store.getPayloads(f.refs.slice(0, count)), generic);
    }
  },
);

it.each([1, 2])(
  "reconstructs a marked error rather than forwarding its mutable properties (%i records)",
  async (count) => {
    const f = await fixture();
    const marked = protectedRecordInvalid();
    Object.defineProperties(marked, {
      message: {
        get() {
          throw new Error(secret);
        },
      },
      details: { value: { secret } },
      cause: { value: secret },
      stack: { value: secret },
    });
    vi.spyOn(f.store, "getInputs").mockImplementationOnce(async () => {
      throw marked;
    });
    const returned = await failure(f.store.getPayloads(f.refs.slice(0, count)), invalid);
    expect(returned === marked).toBe(false);
  },
);

it.each([1, 2])("poisons an observation even when a validator refusal is swallowed (%i records)", async (count) => {
  const f = await fixture();
  const returned = vi.fn();
  await failure(
    f.store
      .observe(
        async () => {
          const refs = f.refs.slice(0, count).map((ref) => ({ ...ref, runId: "wrong" }));
          const caught = await failure(f.store.getPayloads(refs), invalid);
          // Mutating the emitted error must not taint the final observation failure.
          caught.message = secret;
          return { secret };
        },
        { maxRecords: 20 },
      )
      .then(returned),
    invalid,
  );
  expect(returned).not.toHaveBeenCalled();
});

it.each([1, 2])("poisons observations for storage and unexpected validator failures (%i records)", async (count) => {
  for (const kind of ["storage", "validator"]) {
    const f = await fixture();
    if (kind === "storage") await writeFile(join(f.privateDir, "one.payload.json"), secret);
    else
      vi.spyOn(f.store, "getInputs").mockImplementationOnce(async () => {
        throw new OrcaError("INTERNAL", secret, { secret });
      });
    await failure(
      f.store.observe(
        async () => {
          await failure(f.store.getPayloads(f.refs.slice(0, count)), generic);
          return { secret };
        },
        { maxRecords: 20 },
      ),
      generic,
    );
  }
});

it("retains the fixed observation limit and prevents a swallowed limit from returning output", async () => {
  const f = await fixture();
  await failure(
    f.store.observe(
      async () => {
        await f.store.getPayloads(f.refs).catch(() => undefined);
        return { secret };
      },
      { maxRecords: 0 },
    ),
    "protected execution observation exceeds record limit",
  );
});

it.each([1, 2])("freshly reads a replaced key on the next replay (%i records)", async (count) => {
  const f = await fixture();
  expect(await f.store.getPayloads(f.refs.slice(0, count))).toHaveLength(count);
  await writeFile(join(f.privateDir, ".execution-key"), Buffer.alloc(32, 17));
  await failure(f.store.getPayloads(f.refs.slice(0, count)), generic);
});

it.each(["key bytes", "key inode", "directory inode", "key missing", "key symlink", "directory mode"])(
  "terminal %s failure overrides a safe validator refusal and releases no output",
  async (kind) => {
    if (process.platform === "win32" && ["key symlink", "directory mode"].includes(kind)) return;
    const f = await fixture();
    const key = join(f.privateDir, ".execution-key");
    await failure(
      readPrivateJsonBatch(f.privateDir, ["one.payload.json", "two.payload.json"], async () => {
        if (kind === "key bytes") await writeFile(key, Buffer.alloc(32, 17));
        if (kind === "key missing") await rm(key);
        if (kind === "key inode") {
          const replacement = join(f.dir, "replacement");
          await writeFile(replacement, await readFile(key), { mode: 0o600 });
          await rename(replacement, key);
        }
        if (kind === "directory inode") {
          const saved = join(f.dir, "saved");
          await rename(f.privateDir, saved);
          await cp(saved, f.privateDir, { recursive: true });
        }
        if (kind === "key symlink") {
          const saved = join(f.dir, "saved-key");
          await rename(key, saved);
          await symlink(saved, key);
        }
        if (kind === "directory mode") await chmod(f.privateDir, 0o755);
        throw protectedRecordInvalid();
      }),
      generic,
    );
  },
);

it("observation verification still checks ciphertext identity without returning plaintext", async () => {
  const f = await fixture();
  const observed = await observePrivateReads(() => f.store.getPayloads(f.refs), { maxRecords: 20 });
  await observed.verifyUnchanged();
  await writeFile(join(f.privateDir, "one.payload.json"), secret);
  await failure(observed.verifyUnchanged(), generic);
});

it.each(["success", "safe refusal", "unexpected refusal"])(
  "zeroes observed entry and terminal key buffers after %s",
  async (kind) => {
    const f = await fixture();
    const fill = vi.spyOn(Buffer.prototype, "fill");
    const work = observePrivateReads(
      () =>
        readPrivateJsonBatch(f.privateDir, ["one.payload.json", "two.payload.json"], async (records) => {
          if (kind === "safe refusal") throw protectedRecordInvalid();
          if (kind === "unexpected refusal") throw new Error(secret);
          return records.length;
        }),
      { maxRecords: 20 },
    );
    if (kind === "success") expect((await work).value).toBe(2);
    else await failure(work, kind === "safe refusal" ? invalid : generic);
    const keys = fill.mock.contexts.filter(
      (buffer, index) => Buffer.isBuffer(buffer) && buffer.length === 32 && fill.mock.calls[index]?.[0] === 0,
    );
    expect(keys).toHaveLength(2);
    for (const key of keys) expect(key).toEqual(Buffer.alloc(32));
  },
);
