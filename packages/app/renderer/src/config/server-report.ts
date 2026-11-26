/**
 * What a managed server reports to its Config surface (#1235): the agents installed there, the
 * repositories pushed there. A report belongs to the connection it was read on, its epoch and
 * profile: it is offered only while the connection and the draft's target are still that one,
 * and checked again when the person acts on it. A reply for an earlier connection, even to the
 * same profile, is dropped.
 */
import { useEffect, useState } from "react";
import type { DaemonTargetSnapshot, ProfileResult, RemoteProfilesBridge } from "../../../src/daemon-connection.js";
import { useConfigurationStudio } from "./configuration-studio-context.js";

/** A report, with the connection it was read on. */
interface Report<T> {
  epoch: number;
  profileId: string;
  value: T;
}

/**
 * One server read at a time per profile: the app runs one piece of server work per machine, so
 * a second read waits for the first instead of being refused.
 */
const queues = new Map<string, Promise<void>>();
function queued<T>(profileId: string, read: () => Promise<T>): Promise<T> {
  const previous = queues.get(profileId) ?? Promise.resolve();
  const next = previous.then(read);
  const settled = next.then(
    () => {},
    () => {},
  );
  queues.set(profileId, settled);
  void settled.then(() => {
    if (queues.get(profileId) === settled) queues.delete(profileId);
  });
  return next;
}

function belongs<T>(
  report: Report<T> | undefined,
  now: DaemonTargetSnapshot | undefined,
  targetEpoch: number | undefined,
): report is Report<T> {
  return (
    !!report &&
    !!now?.profile &&
    report.epoch === now.epoch &&
    report.profileId === now.profile.id &&
    report.epoch === targetEpoch
  );
}

/**
 * Read `read` from the profile this window is connected to, again on every new connection. The
 * report and its profile, while they belong to the connection and the draft's target; and
 * `stillCurrent`, to check that again when the person acts.
 */
export function useServerReport<T>(
  pick: (profiles: RemoteProfilesBridge) => ((id: string) => Promise<ProfileResult<T>>) | undefined,
): {
  studio: ReturnType<typeof useConfigurationStudio>;
  profile?: NonNullable<DaemonTargetSnapshot["profile"]>;
  report?: T;
  stillCurrent: () => boolean;
} {
  const studio = useConfigurationStudio();
  const connection = window.orca.daemonConnection;
  const read = connection?.profiles ? pick(connection.profiles) : undefined;
  const [snapshot, setSnapshot] = useState(() => connection?.read());
  const [report, setReport] = useState<Report<T>>();
  const [, setTick] = useState(0);
  useEffect(() => connection?.subscribe(setSnapshot), [connection]);
  useEffect(() => studio?.subscribe(() => setTick((n) => n + 1)), [studio]);
  const epoch = snapshot?.epoch;
  const profileId = snapshot?.profile?.id;
  useEffect(() => {
    setReport(undefined);
    if (epoch === undefined || !profileId || !read) return;
    let live = true;
    void queued(profileId, () => read(profileId)).then((result) => {
      const now = connection?.read();
      if (live && result.ok && now?.epoch === epoch && now.profile?.id === profileId)
        setReport({ epoch, profileId, value: result.value });
    });
    return () => {
      live = false;
    };
  }, [epoch, profileId, connection, read]);
  const shown = studio && belongs(report, snapshot, studio.target.epoch) ? report : undefined;
  return {
    studio,
    ...(shown && snapshot?.profile ? { profile: snapshot.profile, report: shown.value } : {}),
    stillCurrent: () => !!studio && belongs(report, connection?.read(), studio.target.epoch),
  };
}
