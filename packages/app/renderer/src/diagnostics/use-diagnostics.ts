/** Bounded renderer references and authority fencing for asynchronous diagnostic actions. */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  DiagnosticDestination,
  DiagnosticPreview,
  DiagnosticResultCode,
  DiagnosticsBridge,
  DiagnosticsResult,
  DiagnosticsStatus,
} from "../../../src/diagnostics-contract.js";
import { DIAGNOSTICS_SCOPE } from "../../../src/diagnostics-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { DIAGNOSTICS_MESSAGES } from "./diagnostics-model.js";

/** One view owns one exact report reference. Late replies cannot restore disposed content. */
export function useDiagnostics(bridge: DiagnosticsBridge | undefined) {
  const [status, setStatus] = useState<DiagnosticsStatus>();
  const [preview, setPreview] = useState<DiagnosticPreview>();
  const [destination, setDestination] = useState<DiagnosticDestination>();
  const [disposal, setDisposal] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  const [sessionOff, setSessionOff] = useState(false);
  const authority = useRef(0);
  const handle = useRef<string | undefined>(undefined);
  const disposalHandle = useRef<string | undefined>(undefined);
  const mounted = useRef(false);
  const preparing = useRef(false);
  const pushed = useRef(0);
  const announce = useAnnounce();

  const say = useCallback(
    (code: DiagnosticResultCode) => {
      const text = DIAGNOSTICS_MESSAGES[code];
      setMessage(text);
      announce(text);
    },
    [announce],
  );

  const clear = useCallback(() => {
    authority.current += 1;
    preparing.current = false;
    const old = handle.current;
    handle.current = undefined;
    setPreview(undefined);
    setDestination(undefined);
    if (old !== undefined) {
      disposalHandle.current = old;
      setDisposal(old);
    }
    setBusy(disposalHandle.current !== undefined);
  }, []);

  const receive = useCallback(
    (next: DiagnosticsStatus) => {
      if (!mounted.current) return;
      pushed.current += 1;
      setStatus(next);
      if (
        (handle.current !== undefined && (!next.enabled || next.activePreviewHandle !== handle.current)) ||
        (preparing.current && (!next.enabled || next.code === "stale_preview" || next.code === "expired"))
      )
        clear();
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
      authority.current += 1;
      unsubscribe();
      const old = handle.current ?? disposalHandle.current;
      handle.current = undefined;
      if (old !== undefined) void bridge?.closePreview(old).catch(() => {});
    };
  }, [bridge, receive, say]);

  // Effect cleanup/commit removes the old text before main receives disposal acknowledgement.
  useEffect(() => {
    if (disposal === undefined || bridge === undefined) return;
    void bridge
      .closePreview(disposal)
      .then((result) => {
        if (mounted.current && result.ok) receive(result.value);
      })
      .catch(() => {
        if (mounted.current) say("unavailable");
      })
      .finally(() => {
        if (!mounted.current || disposalHandle.current !== disposal) return;
        disposalHandle.current = undefined;
        setDisposal(undefined);
        setBusy(false);
      });
  }, [bridge, disposal, receive, say]);

  const runStatus = useCallback(
    async (action: () => Promise<DiagnosticsResult<DiagnosticsStatus>>, turningOff = false, enabling = false) => {
      const epoch = authority.current;
      // Feedback belongs to the explicit action that produced it, not its successor.
      setMessage(undefined);
      setBusy(true);
      try {
        const result = await action();
        if (!mounted.current || epoch !== authority.current) return;
        if (result.ok) {
          receive(result.value);
          say(result.value.code);
          if (enabling && result.value.enabled) setSessionOff(false);
        } else if (turningOff) {
          const text = "Off for this session; the setting or cleanup could not be completed.";
          setMessage(text);
          announce(text);
        } else say(result.code);
      } catch {
        if (mounted.current && epoch === authority.current) {
          if (turningOff) {
            const text = "Off for this session; the setting or cleanup could not be completed.";
            setMessage(text);
            announce(text);
          } else say("unavailable");
        }
      } finally {
        if (mounted.current && epoch === authority.current) setBusy(disposalHandle.current !== undefined);
      }
    },
    [announce, receive, say],
  );

  const close = useCallback(() => {
    setMessage(undefined);
    clear();
  }, [clear]);

  useEffect(() => {
    if (preview === undefined) return;
    const timer = setTimeout(
      () => {
        close();
        say("expired");
      },
      Math.max(0, preview.expiresInMs),
    );
    return () => clearTimeout(timer);
  }, [close, preview, say]);

  const prepare = async (source: "current" | "previous") => {
    if (bridge === undefined || busy || handle.current !== undefined || disposalHandle.current !== undefined) return;
    const epoch = authority.current;
    preparing.current = true;
    setMessage(undefined);
    setBusy(true);
    try {
      const result = await bridge.preparePreview(source);
      if (!mounted.current || epoch !== authority.current) {
        if (result.ok) void bridge.closePreview(result.value.handle).catch(() => {});
        return;
      }
      if (result.ok) {
        handle.current = result.value.handle;
        setPreview(result.value);
        setMessage(undefined);
      } else say(result.code);
    } catch {
      if (mounted.current && epoch === authority.current) say("unavailable");
    } finally {
      if (mounted.current && epoch === authority.current) {
        preparing.current = false;
        setBusy(false);
      }
    }
  };

  const choose = async () => {
    const old = handle.current;
    if (bridge === undefined || old === undefined || busy) return;
    const epoch = authority.current;
    setMessage(undefined);
    setDestination(undefined);
    setBusy(true);
    try {
      const result = await bridge.chooseDestination(old);
      if (!mounted.current || epoch !== authority.current || handle.current !== old) return;
      if (result.ok) setDestination(result.value);
      else say(result.code);
    } catch {
      if (mounted.current && epoch === authority.current) say("unavailable");
    } finally {
      if (mounted.current && epoch === authority.current) setBusy(false);
    }
  };

  return {
    status,
    preview,
    destination,
    busy,
    message,
    sessionOff,
    prepare,
    choose,
    close,
    enable: () => bridge && runStatus(() => bridge.setEnabled(true, DIAGNOSTICS_SCOPE), false, true),
    off: () => {
      setSessionOff(true);
      clear();
      return bridge && runStatus(() => bridge.setEnabled(false, DIAGNOSTICS_SCOPE), true);
    },
    minutes: (value: number) => bridge && runStatus(() => bridge.setMinutes(value)),
    retryCleanup: () => bridge && runStatus(() => bridge.retryCleanup()),
    discard: () => {
      if (preview?.source === "previous") clear();
      return bridge && runStatus(() => bridge.discardPrevious());
    },
    acknowledge: () => {
      const operation = status?.unknownOperation;
      clear();
      return bridge && operation && runStatus(() => bridge.acknowledgeUnknown(operation));
    },
    save: () => {
      const old = handle.current;
      const token = destination?.token;
      if (bridge === undefined || old === undefined || token === undefined || busy) return;
      return runStatus(() => bridge.save(old, token));
    },
  };
}
