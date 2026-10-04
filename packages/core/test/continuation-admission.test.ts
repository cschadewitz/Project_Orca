import { describe, expectTypeOf, it } from "vitest";
import type { RetryAuthority, RetryOptions, RetryResult } from "../src/model/admission-retry.js";
import type {
  ContinuationCommand,
  ContinuationReceipt,
  ContinuationService,
} from "../src/model/continuation-admission.js";

describe("frozen continuation consumer contract", () => {
  it("keeps retry identity separate from the bounded command and receipt", () => {
    expectTypeOf<keyof ContinuationCommand>().toEqualTypeOf<"runId" | "expectedBoundary" | "decision">();
    expectTypeOf<NonNullable<ContinuationCommand["decision"]>>().toEqualTypeOf<{
      requestId: string;
      optionId: string;
      note?: string;
    }>();
    expectTypeOf<ContinuationReceipt["state"]>().toEqualTypeOf<"prepared" | "accepted" | "blocked" | "settled">();
    expectTypeOf<ContinuationReceipt["blockedReason"]>().toEqualTypeOf<
      "authority-unavailable" | "leased" | "unsafe-boundary" | "generation-unavailable" | undefined
    >();
  });
  it("preserves admission, authorized inspection and reconciliation signatures", () => {
    expectTypeOf<ContinuationService["admit"]>().toEqualTypeOf<
      (
        command: ContinuationCommand,
        retry: RetryOptions,
        authority: RetryAuthority<ContinuationCommand>,
      ) => Promise<RetryResult<ContinuationReceipt>>
    >();
    expectTypeOf<ContinuationService["inspect"]>().toEqualTypeOf<(id: string) => Promise<ContinuationReceipt>>();
    expectTypeOf<ContinuationService["reconcile"]>().toEqualTypeOf<
      (id: string, authority: RetryAuthority<ContinuationCommand>) => Promise<ContinuationReceipt>
    >();
  });
});
