/** Discover the same synthetic contract assertions through the normal Vitest tooling lane. */
import { test } from "vitest";
import { defineContractTests } from "../../docs/preparation/trusted-prepared-roots/contract.test.mjs";

defineContractTests(test);
