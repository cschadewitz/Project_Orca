/** The app's copy of the Codex pins (first-run preflight, #1167) is the driver's own table. */
import { expect, it } from "vitest";
import { CODEX_VERIFIED_IMAGES } from "../../packages/agents/src/codex-image.ts";
import { CODEX_PINNED_IMAGES } from "../../packages/app/src/main/first-run/codex-pins.ts";

it("the app's Codex pins match the app-server driver's", () => {
  expect(CODEX_PINNED_IMAGES).toEqual(CODEX_VERIFIED_IMAGES);
});
