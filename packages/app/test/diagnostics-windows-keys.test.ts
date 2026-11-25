/** Synthetic routing contracts. Actual DPAPI/crash proof is a separate bounded native probe. */
import { expect, it, vi } from "vitest";
import { createSafeStorageKeyAdapter } from "../src/main/diagnostics/native-adapter.js";
import { createWindowsDiagnosticsKeyAdapter } from "../src/main/diagnostics/windows-key-adapter.js";

function fixture() {
  const plaintext = Buffer.alloc(32, 17);
  const nativeCiphertext = Buffer.alloc(128, 42);
  const backend = {
    abi: 1,
    platform: "win32",
    keyProtection: 1,
    protectKey: vi.fn(async () => nativeCiphertext),
    unprotectKey: vi.fn(async () => Buffer.from(plaintext)),
  };
  const storage = {
    isAsyncEncryptionAvailable: vi.fn(async () => true),
    encryptStringAsync: vi.fn(async () => Buffer.from("unused")),
    decryptStringAsync: vi.fn(async () => ({ result: plaintext.toString("base64"), shouldReEncrypt: false })),
  };
  const keys = createWindowsDiagnosticsKeyAdapter(backend, createSafeStorageKeyAdapter(storage, "win32"));
  return { plaintext, nativeCiphertext, backend, storage, keys };
}

it("new wrappers use only native current-user protection and wipe the intermediate ciphertext", async () => {
  const { keys, plaintext, nativeCiphertext, backend, storage } = fixture();
  expect(await keys.available()).toBe(true);
  const wrapped = await keys.wrap(plaintext);
  expect(wrapped.subarray(0, 8).toString()).toBe("ORCADP01");
  expect(wrapped.subarray(8)).toEqual(Buffer.alloc(128, 42));
  expect(nativeCiphertext).toEqual(Buffer.alloc(128));
  expect(await keys.unwrap(wrapped)).toEqual(plaintext);
  expect(backend.protectKey).toHaveBeenCalledOnce();
  expect(backend.unprotectKey).toHaveBeenCalledOnce();
  for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
});

it.each([undefined, {}, { abi: 1, platform: "darwin", keyProtection: 1 }, { abi: 1, platform: "win32" }])(
  "missing/incompatible capability refuses new wrapping without consulting legacy authority (%#)",
  async (backend) => {
    const { plaintext, storage } = fixture();
    const keys = createWindowsDiagnosticsKeyAdapter(backend, createSafeStorageKeyAdapter(storage, "win32"));
    expect(await keys.available()).toBe(false);
    await expect(keys.wrap(plaintext)).rejects.toThrow("unavailable");
    await expect(keys.unwrap(Buffer.alloc(128))).rejects.toThrow("unavailable");
    for (const method of Object.values(storage)) expect(method).not.toHaveBeenCalled();
  },
);

it("native decrypt failure is final and never tries legacy decryption", async () => {
  const { keys, plaintext, backend, storage } = fixture();
  const wrapper = await keys.wrap(plaintext);
  backend.unprotectKey.mockRejectedValue(new Error("unavailable"));
  await expect(keys.unwrap(wrapper)).rejects.toThrow("unavailable");
  expect(storage.decryptStringAsync).not.toHaveBeenCalled();
});

// A near miss of the persisted ORCADP01 header, which keeps its name through the rename.
const nextHeader = "ORCADP02"; // rename-keep: a near miss of the kept ORCADP01 header
it.each([nextHeader, "v11xxxxx", "damaged!"])("unknown/tampered wrapper header refuses (%s)", async (header) => {
  const { keys, backend, storage } = fixture();
  await expect(keys.unwrap(Buffer.concat([Buffer.from(header), Buffer.alloc(128)]))).rejects.toThrow("unavailable");
  expect(backend.unprotectKey).not.toHaveBeenCalled();
  expect(storage.decryptStringAsync).not.toHaveBeenCalled();
});

it("preserved v10 wrappers retain their existing Electron authority without rewrapping or replacing bytes", async () => {
  const { keys, plaintext, backend, storage } = fixture();
  const wrapper = Buffer.concat([Buffer.from("v10"), Buffer.alloc(128, 21)]);
  const before = Buffer.from(wrapper);
  expect(await keys.unwrap(wrapper)).toEqual(plaintext);
  expect(wrapper).toEqual(before);
  expect(storage.decryptStringAsync).toHaveBeenCalledWith(wrapper);
  expect(storage.encryptStringAsync).not.toHaveBeenCalled();
  expect(backend.protectKey).not.toHaveBeenCalled();
  expect(backend.unprotectKey).not.toHaveBeenCalled();
});

it("preserved v10 diagnostic envelopes retain their complete authenticated metadata and key", async () => {
  const { keys, backend, storage } = fixture();
  const envelope = Buffer.from(
    JSON.stringify({
      version: 1,
      purpose: "control",
      epoch: "existing",
      keyId: "existing",
      sessionId: "",
      key: Buffer.alloc(32, 1).toString("base64"),
    }),
  );
  expect(envelope.length).toBeGreaterThan(32);
  storage.decryptStringAsync.mockResolvedValue({ result: envelope.toString("base64"), shouldReEncrypt: false });
  const wrapper = Buffer.concat([Buffer.from("v10"), Buffer.alloc(128, 21)]),
    before = Buffer.from(wrapper);
  expect(await keys.unwrap(wrapper)).toEqual(envelope);
  expect(wrapper).toEqual(before);
  expect(backend.protectKey).not.toHaveBeenCalled();
  expect(backend.unprotectKey).not.toHaveBeenCalled();
  expect(storage.encryptStringAsync).not.toHaveBeenCalled();
});

it.each(["lost", "rotation"])("preserved legacy %s authority remains refused", async (refusal) => {
  const { keys, plaintext, backend, storage } = fixture();
  if (refusal === "lost") storage.decryptStringAsync.mockRejectedValue(new Error("unavailable"));
  else storage.decryptStringAsync.mockResolvedValue({ result: plaintext.toString("base64"), shouldReEncrypt: true });
  await expect(keys.unwrap(Buffer.concat([Buffer.from("v10"), Buffer.alloc(128)]))).rejects.toThrow("unavailable");
  expect(backend.protectKey).not.toHaveBeenCalled();
  expect(backend.unprotectKey).not.toHaveBeenCalled();
});

it.each([0, 2049])("out-of-contract diagnostic envelopes refuse before native wrapping (%i)", async (length) => {
  const { keys, backend } = fixture();
  await expect(keys.wrap(Buffer.alloc(length))).rejects.toThrow("unavailable");
  expect(backend.protectKey).not.toHaveBeenCalled();
});

it.each([1, 31, 33, 2048])("the bounded opaque plaintext contract includes %i-byte envelopes", async (length) => {
  const { keys, backend } = fixture(),
    plaintext = Buffer.alloc(length, 17);
  backend.unprotectKey.mockResolvedValue(Buffer.from(plaintext));
  const wrapper = await keys.wrap(plaintext);
  expect(backend.protectKey).toHaveBeenCalledWith(plaintext);
  expect(await keys.unwrap(wrapper)).toEqual(plaintext);
});

it("refuses and wipes invalid native plaintext length", async () => {
  const { keys, plaintext, backend } = fixture();
  const wrapper = await keys.wrap(plaintext);
  const invalid = Buffer.alloc(2049, 5);
  backend.unprotectKey.mockResolvedValue(invalid);
  await expect(keys.unwrap(wrapper)).rejects.toThrow("unavailable");
  expect(invalid).toEqual(Buffer.alloc(2049));
});

it("capability inspection does not invoke getters", async () => {
  const { storage } = fixture();
  const getter = vi.fn(() => 1);
  const keys = createWindowsDiagnosticsKeyAdapter(
    Object.defineProperty({}, "abi", { get: getter }),
    createSafeStorageKeyAdapter(storage, "win32"),
  );
  expect(await keys.available()).toBe(false);
  expect(getter).not.toHaveBeenCalled();
});
