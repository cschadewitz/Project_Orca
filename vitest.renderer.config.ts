/**
 * The renderer's coverage on its own (`pnpm run test:coverage:renderer`): the counts the full
 * `test:coverage` run reports for `packages/app/renderer/src`, in a fraction of the time, and
 * held to the renderer's ratchet from vitest.config.ts alone. The full run stays the authority
 * for every threshold; this is the quick check while working on the renderer.
 *
 * The renderer's own tests are not the whole of it. A few tests elsewhere execute renderer
 * source too - the app's Node-side tests of appearance, connection and notifications, the
 * daemon's studio and template-authoring integration tests, the design token lint - and
 * leaving them out reads branches about a point and a half low. A new test outside
 * `renderer/test` that imports renderer source belongs in this list as well.
 */
import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

const RENDERER = "**/packages/app/renderer/src/**";
const { test } = base;
const coverage = test?.coverage;
type GlobThresholds = Record<string, { statements: number; branches: number; functions: number; lines: number }>;
const renderer =
  coverage?.provider === "v8" ? (coverage.thresholds as GlobThresholds | undefined)?.[RENDERER] : undefined;
if (!coverage || !renderer) throw new Error(`vitest.config.ts no longer has v8 coverage with a ${RENDERER} threshold`);

export default defineConfig({
  ...base,
  test: {
    ...test,
    include: [
      "packages/app/renderer/test/**/*.test.{ts,tsx}",
      "packages/app/test/appearance.test.ts",
      "packages/app/test/connection.test.ts",
      "packages/app/test/notifications.test.ts",
      "packages/daemon/test/configuration-studio-integration.test.ts",
      "packages/daemon/test/template-authoring-integration.test.ts",
      "packages/design/test/token-lint.test.ts",
    ],
    coverage: {
      ...coverage,
      enabled: true,
      include: ["packages/app/renderer/src/**/*.{ts,tsx}"],
      reportsDirectory: "coverage/renderer",
      // Only the renderer's own entry: the whole-report numbers are not this report's to judge.
      thresholds: { [RENDERER]: renderer },
    },
  },
});
