/** Explicit local consent, main-owned export and separate picker/Save controls. */
import { type JSX } from "react";
import type { DiagnosticsBridge } from "../../../src/diagnostics-contract.js";
import { Button, ConfigField, Menu, Text, counted } from "../ui/index.js";
import { DIAGNOSTICS_MESSAGES, EARLIER_EXPORT_WARNING, SAVE_WARNING } from "./diagnostics-model.js";
import { useDiagnostics } from "./use-diagnostics.js";
import "./diagnostics.css";

/** Local main-owned settings do not depend on daemon connection or execution writability. */
export function DiagnosticsSection({ bridge: supplied }: { bridge?: DiagnosticsBridge }): JSX.Element {
  const bridge = supplied ?? (window.orca as typeof window.orca & { diagnostics?: DiagnosticsBridge })?.diagnostics;
  const state = useDiagnostics(bridge);
  const status = state.status;
  const enabled = status?.enabled === true;
  const available =
    enabled &&
    status !== undefined &&
    status.productionEnabled &&
    !status.cleanupPending &&
    (status.code === "ready" ||
      status.code === "capacity_limited" ||
      status.code === "saved" ||
      status.code === "refused" ||
      status.code === "acknowledged_unknown");
  const unknown = status?.code === "unknown_blocked" || status?.code === "unknown_ready";
  const disabledReason = state.busy ? "A diagnostics action is pending." : "Local diagnostics are unavailable.";

  return (
    <section className="orca-diagnostics orca-config__section" aria-label="Local diagnostics">
      <Text style="heading" as="h2">
        Local diagnostics
      </Text>
      <Text style="caption" as="p">
        ORCA keeps limited diagnostic metadata locally, encrypted on disk. The lookback defaults to five minutes and can
        be set from one to fifteen minutes. Size limits can leave less history. After an app crash, one previous session
        may be available for up to 24 hours during the same operating-system boot. Recovery after an operating-system
        restart, power loss or unverifiable age is unavailable. This setting stays on across app restarts until you turn
        it off. ORCA does not upload this data. Exporting requires an explicit choice of report, destination and Save.
      </Text>
      <Text style="caption" as="p">
        Checkpoints are attempted about every five seconds. A crash can lose more than five seconds when writes are
        delayed or fail. The saved report includes the actual omissions and coverage; configured lookback does not
        guarantee that much retained history.
      </Text>

      {bridge === undefined ? (
        <Text style="caption" as="p">
          Local diagnostics are unavailable in this build. Ordinary app work can continue.
        </Text>
      ) : status === undefined ? (
        <Text style="caption" as="p">
          Reading the local diagnostics setting. Collection is not enabled by opening this screen.
        </Text>
      ) : (
        <>
          <Text style="label-strong" as="p">
            Local diagnostics: {enabled ? "On" : "Off"}
          </Text>
          {!status.productionEnabled && (
            <Text style="caption" as="p">
              Production capture is unavailable until the separate independent review and native acceptance pass. An
              enabled setting records your choice; this build does not collect production diagnostics.
            </Text>
          )}
          <div className="orca-diagnostics__actions">
            {enabled ? (
              <Button tone="danger" onClick={() => void state.off()}>
                Delete all and turn off
              </Button>
            ) : (
              <>
                <Button disabled={state.busy} disabledReason={disabledReason} onClick={() => void state.off()}>
                  Keep off
                </Button>
                <Button
                  disabled={state.busy || status.cleanupPending}
                  disabledReason={
                    status.cleanupPending ? "Owned cleanup must finish before enabling again." : disabledReason
                  }
                  onClick={() => void state.enable()}
                >
                  Enable local diagnostics
                </Button>
              </>
            )}
          </div>
          <Text style="caption" as="p">
            Turning this off stops collection and removes ORCA&apos;s retained diagnostic history, unsaved prepared
            reports and diagnostics key material after safe cleanup. Files you already saved are unchanged. Unresolved
            work remains visible until writers have ceased and owned cleanup is verified.
          </Text>
          <ConfigField
            label="Diagnostic lookback"
            path="diagnostics.minutes"
            help="One to fifteen minutes; five minutes by default. Limits may retain less history."
          >
            {(control) => (
              <Menu
                label={`Diagnostic lookback: ${counted(status.minutes, "minute")}`}
                triggerClassName="orca-input"
                triggerProps={control}
                items={Array.from({ length: 15 }, (_, i) => ({
                  id: String(i + 1),
                  label: `${i + 1} ${i === 0 ? "minute" : "minutes"}`,
                }))}
                onChoose={(item) => {
                  if (!state.busy) void state.minutes(Number(item.id));
                }}
              >
                {counted(status.minutes, "minute")}
              </Menu>
            )}
          </ConfigField>
          <Text style="caption" as="p">
            {DIAGNOSTICS_MESSAGES[status.code]}
          </Text>
          {status.lastSaveOutcome === "saved" && status.saveAdmittedBeforeRevocation && (
            <Text style="caption" as="p">
              Save was admitted before revocation and completed. The exported file remains unchanged.
            </Text>
          )}
          {status.lastSaveOutcome === "unknown" && (
            <Text style="caption" as="p">
              The earlier Save outcome is unknown. ORCA cannot claim that nothing was saved.
            </Text>
          )}
          {status.checkpointAgeMs !== undefined && (
            <Text style="caption" as="p">
              Latest completed checkpoint age: {counted(Math.ceil(status.checkpointAgeMs / 1000), "second")}.
            </Text>
          )}
          {status.enabled && status.checkpointAgeMs === undefined && (
            <Text style="caption" as="p">
              Latest completed checkpoint age: unknown.
            </Text>
          )}
          {status.cleanupPending && (
            <>
              <Text style="caption" as="p">
                Cleanup is pending. A private plaintext export temporary may remain until safe removal succeeds.
                Deletion is not forensic erasure of storage, snapshots or backups.
              </Text>
              <Button disabled={state.busy} disabledReason={disabledReason} onClick={() => void state.retryCleanup()}>
                Retry cleanup
              </Button>
            </>
          )}
          {unknown && (
            <>
              <Text style="caption" as="p">
                {EARLIER_EXPORT_WARNING}
              </Text>
              <div className="orca-diagnostics__actions">
                <Button
                  disabled={status.code !== "unknown_ready" || state.busy}
                  disabledReason={
                    status.code === "unknown_blocked"
                      ? "Old writers or owned cleanup remain unresolved."
                      : disabledReason
                  }
                  onClick={() => void state.acknowledge()}
                >
                  Acknowledge and save again
                </Button>
                <Text style="caption">This action does not save a file.</Text>
              </div>
            </>
          )}
          {status.acknowledgedUnknown && (
            <Text style="caption" as="p">
              Only the latest acknowledged unknown outcome is detailed.{" "}
              {status.olderUnknowns
                ? "Older unknown exports may also exist."
                : "This is not a complete export history."}
            </Text>
          )}
          {state.report === undefined && (
            <div className="orca-diagnostics__actions">
              <Button
                disabled={!available || state.busy || unknown}
                disabledReason={
                  unknown ? "Acknowledge the earlier unknown outcome after safe cleanup first." : disabledReason
                }
                onClick={() => void state.prepare("current")}
              >
                Export current diagnostics
              </Button>
              {status.previous && (
                <>
                  <Button
                    disabled={!available || state.busy || unknown}
                    disabledReason={disabledReason}
                    onClick={() => void state.prepare("previous")}
                  >
                    Export previous session
                  </Button>
                  <Button disabled={state.busy} disabledReason={disabledReason} onClick={() => void state.discard()}>
                    Discard previous session
                  </Button>
                  <Text style="caption">
                    Discard removes the previous session. Current capture continues when enabled and available.
                  </Text>
                </>
              )}
            </div>
          )}
        </>
      )}

      {state.message !== undefined && (
        <Text style="caption" as="p">
          {state.message}
        </Text>
      )}
      {state.report !== undefined && (
        <section className="orca-diagnostics__export" aria-label="Diagnostic export">
          <Text style="heading" as="h3">
            Save {state.report.source === "previous" ? "previous-session" : "current-session"} diagnostics
          </Text>
          <Text style="caption" as="p">
            ORCA has prepared a fixed report with omissions and coverage information. Report contents are available in
            the saved file. It contains {counted(state.report.byteLength, "UTF-8 byte")}. It expires within{" "}
            {counted(Math.ceil(state.report.expiresInMs / 1000), "second")} and may become unavailable sooner if its
            source expires or changes. New events do not change these bytes.
          </Text>
          {state.report.tailLossPossible && (
            <Text style="caption" as="p">
              Checkpoint tail loss is possible. Events after the last completed checkpoint may be missing.
            </Text>
          )}
          <div className="orca-diagnostics__actions">
            <Button onClick={state.cancel}>Cancel export</Button>
            <Button
              disabled={state.busy || unknown}
              disabledReason={disabledReason}
              onClick={() => void state.choose()}
            >
              {state.destination === undefined ? "Choose destination" : "Choose another destination"}
            </Button>
          </div>
          <Text style="caption" as="p">
            A destination must be on the same filesystem as ORCA&apos;s private staging slot and use a currently
            nonexistent filename. Unsupported locations and existing files are refused unchanged. Selecting a location
            does not save. Only the separate Save action creates the private plaintext temporary.
          </Text>
          {state.destination !== undefined && (
            <>
              <Text style="mono-id" as="p">
                Destination: {state.destination.displayPath}
              </Text>
              <Text style="caption" as="p">
                {SAVE_WARNING}
              </Text>
              {status?.acknowledgedUnknown && (
                <Text style="caption" as="p">
                  {EARLIER_EXPORT_WARNING}
                </Text>
              )}
              <Button
                tone="primary"
                disabled={state.busy || unknown}
                disabledReason={disabledReason}
                onClick={() => void state.save()}
              >
                Save report
              </Button>
            </>
          )}
        </section>
      )}
    </section>
  );
}
