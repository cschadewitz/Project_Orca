/** Explicit Windows target planning and fail-closed sequential native staging. */
import { expect, it } from "vitest";
import { requestedWindowsArchitectures, stageNativeAddons } from "../packaged-windows/stage-native-addons.js";

it("stages each explicit target once and verifies Windows source/architecture before proceeding", () => {
  const config = {
    win: {
      target: [
        { target: "nsis", arch: ["x64", "arm64"] },
        { target: "zip", arch: ["x64"] },
      ],
    },
  };
  const operations = [];
  const architectures = stageNativeAddons(
    config,
    "local-verified-headers",
    (...args) => operations.push(["build", ...args]),
    (...args) => operations.push(["verify", ...args]),
  );
  expect(architectures).toEqual(["arm64", "x64"]);
  expect(operations.map(([kind]) => kind)).toEqual(["build", "verify", "build", "verify"]);
  expect(operations[0][2].slice(0, 3)).toEqual([
    "packages/app/scripts/diagnostics-native-package.js",
    "--arch",
    "arm64",
  ]);
  expect(operations[0][3]).toMatchObject({ windowsHide: true, timeout: 360000, maxBuffer: 16384 });
  expect(operations[1][2]).toBe("arm64");
  expect(operations[1][4]).toBe("win32");
});

it.each([{}, { win: { target: [] } }, { win: { target: ["nsis"] } }, { win: { target: [{ arch: ["ia32"] }] } }])(
  "refuses implicit or unsupported targets before building",
  (config) => {
    expect(() => requestedWindowsArchitectures(config)).toThrow();
    expect(() =>
      stageNativeAddons(config, "headers", () => {
        throw new Error("must not build");
      }),
    ).toThrow(/architecture/);
  },
);

it("does not continue after the first build or post-build verification fails", () => {
  const config = { win: { target: [{ arch: ["x64", "arm64"] }] } };
  let builds = 0;
  expect(() =>
    stageNativeAddons(config, "headers", () => {
      builds++;
      throw new Error("build unavailable");
    }),
  ).toThrow("build unavailable");
  expect(builds).toBe(1);
  builds = 0;
  expect(() =>
    stageNativeAddons(
      config,
      "headers",
      () => {
        builds++;
      },
      () => {
        throw new Error("stale");
      },
    ),
  ).toThrow("stale");
  expect(builds).toBe(1);
});
