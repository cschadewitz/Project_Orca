// Calculate a synthetic shipping fee from a nonnegative integer subtotal in cents.
/* global exports -- Copied into a standalone CommonJS repository, outside ORCA's ESM package. */
exports.shippingCents = function shippingCents(subtotalCents) {
  return subtotalCents > 5000 ? 0 : 499;
};
