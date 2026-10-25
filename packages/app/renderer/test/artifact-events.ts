/** A recorded-artifact notification through the same validated stream as the daemon. */
import type { ArtifactView, NotificationMessage } from "@orca/protocol";

export function artifactRecorded(runId: string, artifact: ArtifactView, seq = 100): NotificationMessage {
  const at = artifact.createdAt;
  return {
    kind: "notification",
    method: "event.appended",
    params: {
      subscriptionId: "sub-1",
      runId,
      seq,
      at,
      event: {
        id: `event-${seq}`,
        runId,
        seq,
        at,
        type: "artifact.recorded",
        payload: {
          stepRunId: artifact.producedByStepRunId ?? "step",
          artifact: {
            ...artifact,
            contentHash: "fixture-hash",
            producedBy: { runId, stepRunId: artifact.producedByStepRunId },
          },
        },
      },
    },
  };
}
