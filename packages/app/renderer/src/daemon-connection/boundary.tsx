/** Retain old drafts after an unsolicited identity change; never activate them on a new target. */
import { useEffect, useLayoutEffect, useRef, useState, type JSX, type ReactNode } from "react";
import type { DaemonConnectionBridge } from "../../../src/daemon-connection.js";
import { hasUpdateDrafts } from "../update-drafts.js";
import { Button, Text } from "../ui/index.js";
import { ConnectionDialog } from "./dialog.js";

export function ConnectionBoundary({
  bridge,
  children,
}: {
  bridge: DaemonConnectionBridge;
  children: ReactNode;
}): JSX.Element {
  const [target, setTarget] = useState(() => bridge.read());
  const [active, setActive] = useState(target.epoch);
  const [open, setOpen] = useState(false);
  const [replace, setReplace] = useState(false);
  const old = useRef<HTMLDivElement>(null);
  const notice = useRef<HTMLDivElement>(null);
  const changed = target.epoch !== active;
  useEffect(() => {
    const off = bridge.subscribe(setTarget);
    const show = bridge.onShow(() => setOpen(true));
    setTarget(bridge.read());
    return () => {
      off();
      show();
    };
  }, [bridge]);
  // First unmount the old tree. Activate only in the next commit, after effect cleanup.
  useLayoutEffect(() => {
    if (changed && !hasUpdateDrafts()) setReplace(true);
  }, [changed, target.epoch]);
  useEffect(() => {
    if (!replace) return;
    bridge.activate(target.epoch);
    setActive(target.epoch);
    setReplace(false);
  }, [replace, bridge, target.epoch]);
  useLayoutEffect(() => {
    if (old.current) old.current.inert = changed;
  }, [changed]);
  useEffect(() => {
    if (changed && !replace) notice.current?.focus();
  }, [changed, replace]);
  return (
    <>
      {!replace && (
        <div ref={old} key={active} className="orca-connection-root">
          {children}
        </div>
      )}
      {changed && !replace && (
        <div className="orca-dialog-layer">
          <div
            ref={notice}
            tabIndex={-1}
            className="orca-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="Daemon changed"
          >
            <Text style="body" as="p">
              The daemon changed or restarted. Pending edits still belong to the previous connection and cannot be sent
              to this one.
            </Text>
            <Button onClick={() => setReplace(true)}>Discard pending edits and load this daemon</Button>
          </div>
        </div>
      )}
      {open && <ConnectionDialog bridge={bridge} target={target} close={() => setOpen(false)} />}
    </>
  );
}
