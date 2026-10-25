/**
 * The artifact panel's data: `artifacts.list` for the versions, `artifacts.get` for the
 * body, and one more `get` when a comparison is open.
 *
 * The split between the two methods is the daemon's and it is the reason there are two
 * hooks here. `list` answers metadata only — a run with forty artifacts must not ship
 * megabytes to draw a version list — so the panel's version strip, the step's chips and a
 * consumed-by lookup all come from one cheap call. `get` is one artifact at a time, and it
 * is the only call that can answer with a body it has decided not to send: a binary or
 * oversized blob comes back as `omitted` with the reason *in words*, which is what the
 * panel shows where the body would have been. That is not an error and is not rendered as
 * one — the artifact exists, and saying what it is is more use than a retry button.
 *
 * Neither hook polls. The metadata list follows relevant `artifact.recorded` events on
 * the shared notification stream. Bodies remain immutable: a new version updates the
 * choices, never the version or comparison the person has selected, nor bodies in hand.
 */
import { useEffect, useState } from "react";
import type { ArtifactOmitted, ArtifactView, ProtocolError } from "@orca/protocol";
import { useNotifications } from "../notifications-context.js";

export interface ArtifactsListState {
  loading: boolean;
  artifacts: readonly ArtifactView[];
  error?: ProtocolError;
}

/** A stable empty page, so a consumer's `useMemo` is not invalidated before data lands. */
const NONE: readonly ArtifactView[] = [];

export interface ArtifactsListQuery {
  runId?: string;
  name?: string;
  producedByStepRunId?: string;
}

/**
 * Read once and refresh on matching recorded artifacts. Subscribe before reading so an
 * event during the initial snapshot is not lost. At most one request is in flight, with
 * one dirty bit for a burst: an invalidated answer is discarded and followed by one fresh
 * read. Keep the held metadata visible while refreshing. Query fields are dependencies
 * rather than the inline object, so rendering does not cause another read.
 */
export function useArtifactsList(query: ArtifactsListQuery): ArtifactsListState {
  const { runId, name, producedByStepRunId } = query;
  const stream = useNotifications();
  const [state, setState] = useState<ArtifactsListState>({ loading: true, artifacts: NONE });

  useEffect(() => {
    let live = true;
    let reading = false;
    let dirty = false;
    setState({ loading: true, artifacts: NONE });
    const read = (): void => {
      reading = true;
      dirty = false;
      void window.orca.artifacts
        .list({
          ...(runId === undefined ? {} : { runId }),
          ...(name === undefined ? {} : { name }),
          ...(producedByStepRunId === undefined ? {} : { producedByStepRunId }),
        })
        .then((answer) => {
          if (!live) return;
          reading = false;
          if (dirty) {
            read();
            return;
          }
          setState((current) =>
            answer.ok
              ? { loading: false, artifacts: answer.result.artifacts }
              : { loading: false, artifacts: current.artifacts, error: answer.error },
          );
        });
    };
    const off = stream.on(
      "event.appended",
      ({ event }) => {
        if (event.type !== "artifact.recorded") return;
        const artifact = event.payload.artifact;
        if (name !== undefined && artifact.name !== name) return;
        if (producedByStepRunId !== undefined && artifact.producedBy.stepRunId !== producedByStepRunId) return;
        dirty = true;
        if (!reading) read();
      },
      { runId },
    );
    if (!reading) read();
    return () => {
      live = false;
      off();
    };
  }, [stream, runId, name, producedByStepRunId]);

  return state;
}

export interface ArtifactBody {
  loading: boolean;
  artifact?: ArtifactView;
  /** The body, verbatim. Present exactly when `omitted` is absent. */
  text?: string;
  /** Present exactly when `text` is absent: the body exists and is not being shown. */
  omitted?: ArtifactOmitted;
  error?: ProtocolError;
}

const EMPTY: ArtifactBody = { loading: false };

/**
 * One artifact's body, by the address a deep link carries. `version` of `undefined` means
 * "do not ask", which is what the comparison half of the panel passes when nothing is being
 * compared — a hook that is conditionally *not called* is not an option, and a request
 * nobody wanted is worse than a branch here.
 */
export function useArtifactBody(runId: string, name: string, version: number | undefined): ArtifactBody {
  const [state, setState] = useState<ArtifactBody>(EMPTY);

  useEffect(() => {
    if (version === undefined) {
      setState(EMPTY);
      return;
    }
    let live = true;
    setState({ loading: true });
    void window.orca.artifacts.get({ runId, name, version }).then((answer) => {
      if (!live) return;
      if (!answer.ok) {
        setState({ loading: false, error: answer.error });
        return;
      }
      const { artifact, text, omitted } = answer.result;
      setState({
        loading: false,
        artifact,
        ...(text === undefined ? {} : { text }),
        ...(omitted === undefined ? {} : { omitted }),
      });
    });
    return () => {
      live = false;
    };
  }, [runId, name, version]);

  return state;
}
