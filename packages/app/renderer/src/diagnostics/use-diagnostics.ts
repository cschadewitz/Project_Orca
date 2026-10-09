/** Descriptor-only export actions; canonical report bytes never enter this document. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DiagnosticDestination,
  DiagnosticExport,
  DiagnosticResultCode,
  DiagnosticsBridge,
  DiagnosticsResult,
  DiagnosticsStatus,
} from "../../../src/diagnostics-contract.js";
import { DIAGNOSTICS_SCOPE } from "../../../src/diagnostics-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { DIAGNOSTICS_MESSAGES } from "./diagnostics-model.js";

export function useDiagnostics(bridge: DiagnosticsBridge | undefined) {
  const [status, setStatus] = useState<DiagnosticsStatus>();
  const [report, setReport] = useState<DiagnosticExport>();
  const [destination, setDestination] = useState<DiagnosticDestination>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const authoritativeStatus = useRef<DiagnosticsStatus | undefined>(undefined);
  const statusRevision = useRef(0);
  const offFeedback = useRef(false);
  const authority = useRef(0);
  const handle = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const preparing = useRef(false);
  const pending = useRef(0);
  const pushed = useRef(0);
  const announce = useAnnounce();

  const begin = useCallback(() => {
    pending.current++;
    setBusy(true);
  }, []);
  const finish = useCallback(() => {
    pending.current--;
    if (mounted.current) setBusy(pending.current > 0);
  }, []);
  const say = useCallback(
    (code: DiagnosticResultCode) => {
      const text = DIAGNOSTICS_MESSAGES[code];
      offFeedback.current = false;
      setMessage(text);
      announce(text);
    },
    [announce],
  );

  // Cancellation grants no authority and may run while a picker/write is pending.
  const clear = useCallback(() => {
    authority.current++;
    preparing.current = false;
    const old = handle.current;
    handle.current = undefined;
    setReport(undefined);
    setDestination(undefined);
    if (old !== undefined && bridge !== undefined) {
      begin();
      void bridge
        .cancelExport(old)
        .catch(() => {
          if (mounted.current) say("unavailable");
        })
        .finally(finish);
    }
  }, [begin, bridge, finish, say]);

  const receive = useCallback(
    (next: DiagnosticsStatus) => {
      if (!mounted.current || next.revision < statusRevision.current) return false;
      statusRevision.current = next.revision;
      pushed.current++;
      authoritativeStatus.current = next;
      setStatus(next);
      if (next.enabled && offFeedback.current) {
        offFeedback.current = false;
        setMessage(undefined);
      }
      if (
        (handle.current !== undefined && (!next.enabled || next.activeExportHandle !== handle.current)) ||
        (preparing.current &&
          (!next.enabled || next.code === "stale_export" || next.code === "expired" || next.code === "age_uncertain"))
      )
        clear();
      return true;
    },
    [clear],
  );

  useEffect(() => {
    mounted.current = true;
    const initialPush = pushed.current;
    let unsubscribe = () => {};
    if (bridge !== undefined) {
      try {
        unsubscribe = bridge.subscribe(receive);
        void bridge
          .status()
          .then((result) => {
            if (!mounted.current || pushed.current !== initialPush) return;
            if (result.ok) receive(result.value);
            else say(result.code);
          })
          .catch(() => {
            if (mounted.current) say("unavailable");
          });
      } catch {
        say("unavailable");
      }
    }
    return () => {
      mounted.current = false;
      authority.current++;
      unsubscribe();
      const old = handle.current;
      handle.current = undefined;
      if (old !== undefined) void bridge?.cancelExport(old).catch(() => {});
    };
  }, [bridge, receive, say]);

  const runStatus = useCallback(
    async (action: () => Promise<DiagnosticsResult<DiagnosticsStatus>>, turningOff = false) => {
      if (pending.current && !turningOff) return;
      const epoch = authority.current;
      offFeedback.current = false;
      setMessage(undefined);
      begin();
      const reportOffFailure = () => {
        const text =
          authoritativeStatus.current?.enabled === false
            ? "Off for this session; the setting or cleanup could not be completed."
            : "Revocation could not be confirmed. Local diagnostics may remain on.";
        offFeedback.current = true;
        setMessage(text);
        announce(text);
      };
      try {
        const result = await action();
        if (!mounted.current || epoch !== authority.current) return;
        if (result.ok) {
          if (receive(result.value)) say(result.value.code);
        } else if (turningOff) reportOffFailure();
        else say(result.code);
      } catch {
        if (mounted.current && epoch === authority.current) {
          if (turningOff) reportOffFailure();
          else say("unavailable");
        }
      } finally {
        finish();
      }
    },
    [announce, begin, finish, receive, say],
  );

  const cancel = useCallback(() => {
    setMessage(undefined);
    clear();
  }, [clear]);
  useEffect(() => {
    if (report === undefined) return;
    const timer = setTimeout(
      () => {
        cancel();
        say("expired");
      },
      Math.max(0, report.expiresInMs),
    );
    return () => clearTimeout(timer);
  }, [cancel, report, say]);

  const prepare = async (source: "current" | "previous") => {
    if (bridge === undefined || pending.current || handle.current !== undefined) return;
    const epoch = authority.current;
    preparing.current = true;
    setMessage(undefined);
    begin();
    try {
      const result = await bridge.prepareExport(source);
      if (
        !mounted.current ||
        epoch !== authority.current ||
        (result.ok &&
          result.value.statusRevision < statusRevision.current &&
          authoritativeStatus.current?.activeExportHandle !== result.value.handle)
      ) {
        if (result.ok) void bridge.cancelExport(result.value.handle).catch(() => {});
        return;
      }
      if (result.ok) {
        statusRevision.current = Math.max(statusRevision.current, result.value.statusRevision);
        handle.current = result.value.handle;
        setReport(result.value);
        say("export_ready");
      } else say(result.code);
    } catch {
      if (mounted.current && epoch === authority.current) say("unavailable");
    } finally {
      if (epoch === authority.current) preparing.current = false;
      finish();
    }
  };

  const choose = async () => {
    const old = handle.current;
    if (bridge === undefined || old === undefined || pending.current) return;
    const epoch = authority.current;
    setMessage(undefined);
    setDestination(undefined);
    begin();
    try {
      const result = await bridge.chooseDestination(old);
      if (!mounted.current || epoch !== authority.current || handle.current !== old) return;
      if (result.ok) setDestination(result.value);
      else say(result.code);
    } catch {
      if (mounted.current && epoch === authority.current) say("unavailable");
    } finally {
      finish();
    }
  };

  return {
    status,
    report,
    destination,
    busy,
    message,
    prepare,
    choose,
    cancel,
    enable: () => bridge && runStatus(() => bridge.setEnabled(true, DIAGNOSTICS_SCOPE)),
    off: () => {
      clear();
      return bridge && runStatus(() => bridge.setEnabled(false, DIAGNOSTICS_SCOPE), true);
    },
    minutes: (value: number) => bridge && runStatus(() => bridge.setMinutes(value)),
    retryCleanup: () => bridge && runStatus(() => bridge.retryCleanup()),
    discard: () => bridge && runStatus(() => bridge.discardPrevious()),
    acknowledge: () => {
      const operation = status?.unknownOperation;
      return bridge && operation && runStatus(() => bridge.acknowledgeUnknown(operation));
    },
    save: () => {
      const old = handle.current,
        token = destination?.token;
      if (bridge === undefined || old === undefined || token === undefined || pending.current) return;
      // Consume the destination for saved, refused and unknown outcomes alike.
      setDestination(undefined);
      return runStatus(() => bridge.save(old, token));
    },
  };
}
