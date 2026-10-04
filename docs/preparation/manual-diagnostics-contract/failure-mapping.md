# Safe outcomes and support behavior

These are proposed diagnostic enums, **not new RPC/error codes or implemented hooks**.
Translate only an explicit allowlisted typed observation at its owner. Never classify by
searching error text, stdout/stderr, stack traces, paths, arbitrary `.code` objects or
untrusted RPC data. Unknown reasons do not authorize inspecting more sources.

Every phase additionally permits code `unknown`; phase `unknown` permits only `unknown`.
The following table lists every non-unknown code in [schema-v1.json](schema-v1.json).

| Phase | Exact code | Required observation / current source boundary |
| --- | --- | --- |
| `startup` | `startup_spawn_failed` | Owned child spawn callback reports failure, without copying exception. A future typed projection is required; current `DaemonStartError` text cannot distinguish this safely |
| `startup` | `startup_exited_before_handshake` | Owned child exit observed before an accepted handshake, without exit output, signal, PID or raw status |
| `startup` | `startup_handshake_timeout` | Startup owner's typed deadline expiration, not a guessed timeout from text |
| `connection` | `connection_unavailable` | Connection owner reports disconnected before first successful connection; does not assert DNS/network cause |
| `connection` | `connection_lost` | Connection owner observed a live connection leave live; must not reconstruct transport history from logs |
| `connection` | `protocol_mismatch` | Current verified handshake's compatibility verdict, not a transport failure |
| `connection` | `authentication_required` | Existing recognized `AUTH_REQUIRED` observation only |
| `connection` | `authentication_invalid` | Existing recognized `AUTH_INVALID` observation only; never token values or a guessed expiry cause |
| `connection` | `authorization_denied` | Existing recognized `AUTH_FORBIDDEN` observation only; no principal/resource identifiers |
| `admission` | `admission_uncertain` | Client owner explicitly knows the outcome of an already initiated admission is uncertain after lost response; never assume rejected/accepted from transport failure alone |
| `admission` | `admission_recoverable_failure` | Authorized admission service's `recoverable-failure` category; omit receipt IDs, Request/workflow data and recovery payload |
| `resume` | `resume_failed` | An already authorized, user-initiated resume failed; records only failure, not cause or safe-to-retry judgment |
| `protected_state` | `protected_state_unavailable` | Protected-state owner explicitly reports unavailable material through a safe projection. Current generic `RUN_STATE` alone is insufficient to identify protected-state failure |
| `lifecycle` | `app_started` | App lifecycle observer, after diagnostic consent; no startup argv or launch history |
| `lifecycle` | `app_stopping` | Current app lifecycle observer while consent remains valid; no shutdown-delaying flush |
| `lifecycle` | `sleep_observed` | Existing OS lifecycle notification after consent; not a gap inferred from wall time |
| `lifecycle` | `wake_observed` | Existing OS lifecycle notification; uncertain elapsed time expires retention first |
| `run` | `run_failed` | Authorized typed terminal run outcome only; no status payload, name, step error, agent output or artifact |

Source anchors at the [recorded baseline](README.md):
[daemon-process.ts](../../../packages/app/src/main/daemon-process.ts),
[connection-state.ts](../../../packages/app/src/main/connection-state.ts),
[auth.ts](../../../packages/app/src/client/auth.ts),
[request admission](../../request-submission.md),
[orchestrator.ts](../../../packages/engine/src/orchestrator.ts), and
[protected-file.ts](../../../packages/store/src/protected-file.ts).
None exposes the diagnostic projection specified here today. Future runtime work must
review exact hook ownership and authorization under #416; this slice adds no API.

## Missing and ambiguous observations

Without handshake evidence `true`, daemon version/protocol, `versions.storeFormat` and
`snapshot.protectedState` remain `unknown`; `evidence.protectedStateObservation` cannot
be `true`, and authentication cannot be `accepted`. A handshake alone establishes no
store fact and authorizes no additional read. The app can still create a one-shot preview
from known local metadata and an
unknown startup outcome. [startup-unknown.json](fixtures/valid/startup-unknown.json)
intentionally demonstrates this baseline limitation. The other failure fixtures assume
future explicit typed observations and are **synthetic design inputs**, not source or
packaged proof that those projections already exist.

`RUN_STATE` also describes foreign/missing admissions, associations and other unavailable
state. Export `resume_failed` only when the resume operation outcome is actually observed;
leave `protectedState` unknown unless the protected-state owner supplies its own fact.
No unqualified code is enough to claim corruption, a missing key, safe replay or data loss.

Denied/expired daemon authorization yields only locally known connection/auth information;
it does not permit reading the store directly, querying extra RPCs or broadening grants.
Known local facts remain usable with explicit one-shot consent when offline. Metadata
unavailable from existing sources remains unknown pending a reviewed safe projection.

## Support stop conditions and user copy

| Situation | Proposed in-app guidance |
| --- | --- |
| Pre-handshake startup or connection problem | “ORCA could not establish a connection. The cause may be unknown. You can preview the available diagnostic metadata and choose whether to save it.” |
| Uncertain admission | “ORCA cannot confirm whether this request was accepted. Do not submit it again to gather diagnostics. Contact Casey before taking recovery action.” |
| Failed resume | “The resume attempt failed. Diagnostics will not try again or change this run. Contact Casey before retrying.” |
| Protected state unavailable | “Required protected state is unavailable. The cause is unknown. Do not delete, replace or repair the store or keys. Contact Casey.” |
| Diagnostic preparation failure | “The diagnostic file could not be prepared safely. Nothing was exported. Your work was not changed.” |

Saving a file is optional; the tester separately chooses if and where to share it. No
contact button sends automatically, opens an upload, fills an email or copies private
metadata. If no safe preview is possible, report only that fact to Casey using a separate
user-chosen channel. Do not request raw logs, stores, key files or screenshots as fallback.

Support acceptance must show that diagnostics never repairs stores, reconciles/resubmits
possibly committed work, answers gates, starts/resumes/restarts agents, cancels work or
updates software. Diagnostic consent grants none of those actions. Recovery belongs to
its separately authorized flow; uncertain-admission/protected-state fixtures stop there.
