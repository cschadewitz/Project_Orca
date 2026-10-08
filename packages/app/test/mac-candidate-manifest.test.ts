/** delivery-v1 consumers reuse #402 fixture bytes; parsing declarations never verifies a native candidate. */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MAC_METADATA_LIMIT,
  freezeMacMetadata,
  matchesSealedMacIdentity,
  readMacManifest,
  sha256,
} from "../src/main/mac-candidate-manifest.js";
const fixture = new URL("../../../tools/deploy/tests/native-mac/fixtures/valid/", import.meta.url);
const bytes = readFileSync(new URL("delivery/native-mac-artifact.json", fixture));
const identity = readFileSync(new URL("ORCA.app/Contents/Resources/orca-build.json", fixture));

describe("#402 manifest shape and sealed identity", () => {
  it("reads the unchanged fixture and preserves opaque plist strings and the real stub daemon hash", () => {
    const manifest = readMacManifest(bytes);
    expect(manifest.kind).toBe("fixture");
    expect(manifest.identity.bundleVersion).toBe("0007.02");
    expect(matchesSealedMacIdentity(manifest, identity)).toBe(true);
    expect(sha256(readFileSync(new URL("ORCA.app/Contents/Resources/daemon/orca-daemon.mjs.txt", fixture)))).toBe(
      manifest.identity.daemon.sha256,
    );
    expect(matchesSealedMacIdentity(manifest, Buffer.concat([identity, Buffer.from(" ")]))).toBe(false);
  });
  it("requires sealed bytes to match both their declared digest and the external identity", () => {
    const manifest = readMacManifest(bytes);
    manifest.identitySha256 = sha256(Buffer.from("{}"));
    expect(matchesSealedMacIdentity(manifest, Buffer.from("{}"))).toBe(false);
    manifest.identitySha256 = sha256(identity);
    manifest.identity.buildId = "gha:1:1:mac-arm64";
    expect(matchesSealedMacIdentity(manifest, identity)).toBe(false);
  });
  it.each([
    '{"schemaVersion":1,"schemaVersion":1}',
    '{"schemaVersion":1,"schema\\u0056ersion":1}',
    '{"outer":{"x":1,"\\u0078":2}}',
    '{"schemaVersion":NaN}',
    '{"schemaVersion":Infinity}',
    '{"schemaVersion":1,}',
    '{"schemaVersion":01}',
    '{"schemaVersion":1.0}',
    '{"schemaVersion":1e0}',
    "[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[[null]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]]",
  ])("rejects hostile JSON before permissive parsing: %s", (value) => {
    expect(() => readMacManifest(Buffer.from(value))).toThrow();
  });
  it("rejects invalid UTF-8, BOM and oversized metadata", () => {
    for (const input of [
      Buffer.from([0xff]),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.alloc(MAC_METADATA_LIMIT + 1),
    ])
      expect(() => readMacManifest(input)).toThrow();
  });
  it.each([
    (value: ReturnType<typeof readMacManifest>) => {
      value.artifacts[0]!.path = "../candidate.dmg";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.artifacts[0]!.bytes = 0;
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.artifacts[0]!.format = "zip";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.evidence[0]!.path = "evidence/../escape";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.evidence[0]!.path = value.evidence[1]!.path;
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.signing.reportPath = "evidence/missing.txt";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.signing.authority = "ad-hoc";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.identity.builtAt = "2000-02-31T00:00:00Z";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.identity.appVersion = "other";
    },
    (value: ReturnType<typeof readMacManifest>) => {
      Object.assign(value.identity, { unexpected: true });
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.identity.protocol.major = Number.MAX_SAFE_INTEGER + 1;
    },
    (value: ReturnType<typeof readMacManifest>) => {
      value.identity.storeEpoch = "\ud800";
    },
  ])("refuses contract violations without relaxing #402", (mutate) => {
    const value = readMacManifest(bytes);
    mutate(value);
    expect(() => readMacManifest(Buffer.from(JSON.stringify(value)))).toThrow();
  });
  it("freezes nested candidate records without prototype assignment", () => {
    const value = freezeMacMetadata(readMacManifest(bytes));
    expect(() => {
      value.artifacts[0]!.bytes = 1;
    }).toThrow();
    expect(() => {
      value.identity.protocol.minor = 0;
    }).toThrow();
    expect(() => readMacManifest(Buffer.from('{"__proto__":{"polluted":true}}'))).toThrow();
    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
