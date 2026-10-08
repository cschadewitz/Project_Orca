# Protected replay error contract (issue 409 store slice)

`FileExecutionStore.getPayloads` is the only internal caller of
`readPrivateJsonBatch`. Its callback validates authenticated payload schema,
requested run/type, fresh execution inputs and required sensitivity references
before returning payloads. Single-record replay uses the same validator through
`validatePrivateJson`; absent payload files are rejected before validation. This
path retains its existing single-record reader semantics.

The only deliberate validator diagnostic admitted by these boundaries is
`RUN_STATE: protected execution record is missing or invalid`. The internal,
argument-free `protectedRecordInvalid` factory marks errors by object identity in
a private WeakMap. `execution-store.ts` uses it for its existing `unavailable`
factory, including input/overlay validation reached by the callback. This is the
only necessary source caller change. The new helper names `protectedRecordInvalid`
and `validatePrivateJson` are not exported by the package barrel. However,
`execution-store.ts` exports its existing `unavailable` alias using the fixed
factory, and `index.ts` exports `execution-store`. That existing API remains
available; there is no new public error code or configurable diagnostic.

The boundary reconstructs this fixed error. It never forwards the original
message, stack, properties, details or cause, even if a marked error was mutated.
Matching OrcaError codes/messages, arbitrary exceptions, raw schema/parser exceptions,
malformed envelopes, failed authentication and missing payload files instead use
`RUN_STATE: protected execution record or key is missing, invalid or unreadable`.
The fixed observation-limit diagnostic retains its separate internal identity.
No diagnostic contains record identities, paths, plaintext or protected values.

Batch replay reaches terminal verification after validator success **and refusal**,
provided the observation has not already failed. It compares fresh entry and
terminal key bytes and directory/file identities; a failed terminal check takes
precedence over a deliberate validator diagnostic. Entry/read/decode failures and
already-poisoned observations retain their inherited fail-closed paths, without a
new guarantee of terminal verification on every path. These are boundary
observations, not detection of every transient A -> B -> A change.

Ciphertext authentication, observation poisoning and verification without plaintext
retain their existing behavior. Tests cover zeroization of stable observed entry
and terminal key buffers on success and validator refusal (both deliberate and
unexpected), not universal cleanup on every I/O failure. These inherited limits
are neither newly fixed nor introduced by the diagnostic change. A swallowed
replay refusal still prevents an observation from returning a value or
verification capability. Successful payloads cannot partially resolve when
another record fails; this does not sandbox a trusted internal callback that
itself handles plaintext.

This note covers the protected-store batch replay diagnostics half of issue 409.
Daemon renewal-grant diagnostics and live acceptance remain separate work.
