// Dependency-free, deterministic checks for the synthetic shipping policy.
/* global require -- Copied into a standalone CommonJS repository, outside ORCA's ESM package. */
/* eslint-disable @typescript-eslint/no-require-imports -- The standalone fixture needs no package manifest. */
const assert = require("node:assert/strict");
const { shippingCents } = require("./shipping.js");

const cases = [
  ["zero subtotal", 0, 499],
  ["below threshold", 4999, 499],
  ["exact threshold", 5000, 0],
  ["above threshold", 5001, 0],
  ["large subtotal", 10000, 0],
];
let failed = 0;
for (const [name, subtotal, expected] of cases) {
  const actual = shippingCents(subtotal);
  try {
    assert.equal(actual, expected);
    process.stdout.write(`PASS ${name}\n`);
  } catch {
    failed++;
    process.stdout.write(`FAIL ${name}: expected ${expected}, got ${actual}\n`);
  }
}
process.stdout.write(`${cases.length - failed} passed; ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
