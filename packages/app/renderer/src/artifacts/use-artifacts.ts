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
 * Neither hook polls and neither subscribes. An artifact is immutable once recorded — a
 * new version is a new version, not an edit — so there is nothing for a notification to
 * change about a body already in hand. A *new* version arrives as a fresh `list` when the
 * panel is opened again on that name, which is the moment a person can act on it.
 */
import { useEffect, useState } from "react";
import type { ArtifactOmitted, ArtifactView, ProtocolError } from "@orca/protocol";

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
 * One `artifacts.list`, re-read when the query changes and never otherwise. The query is
 * destructured into the effect's dependencies rather than passed as an object, so a caller
 * writing `{ runId, name }` inline does not re-read on every render.
 */
export function useArtifactsList(query: ArtifactsListQuery): ArtifactsListState {
  const { runId, name, producedByStepRunId } = query;
  const [state, setState] = useState<ArtifactsListState>({ loading: true, artifacts: NONE });

  useEffect(() => {
    let live = true;
    setState({ loading: true, artifacts: NONE });
    void window.orca.artifacts
      .list({
        ...(runId === undefined ? {} : { runId }),
        ...(name === undefined ? {} : { name }),
        ...(producedByStepRunId === undefined ? {} : { producedByStepRunId }),
      })
      .then((answer) => {
        if (!live) return;
        setState(
          answer.ok
            ? { loading: false, artifacts: answer.result.artifacts }
            : { loading: false, artifacts: NONE, error: answer.error },
        );
      });
    return () => {
      live = false;
    };
  }, [runId, name, producedByStepRunId]);

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
