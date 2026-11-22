/**
 * The Linux `.deb`'s release notice (#888): non-blocking, in the title bar, and only when a
 * newer release has a package for this machine. The package has no updater, so the notice
 * offers the two things a person needs and nothing more: the release page, and the `apt`
 * command to run once the `.deb` is downloaded. Both are main's strings; this only asks
 * main to open or copy them.
 *
 * Once `apt` has upgraded the package beneath this app, the notice gives way to "Restart to
 * finish update" (#905): main hands the store to the installed version and starts it.
 */
import { useEffect, useState, type JSX } from "react";
import type { LinuxRestartState, LinuxUpdateAction } from "../../../src/linux-update-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { Button, MachineText, Menu, textClass, type MenuItem } from "../ui/index.js";

const ITEMS: readonly MenuItem[] = [
  { id: "open", label: "Open release page" },
  { id: "copy", label: "Copy install command" },
];

function LinuxRestartControl({ state }: { state: LinuxRestartState }): JSX.Element | null {
  const bridge = window.orca.linuxRestart;
  const announce = useAnnounce();
  useEffect(() => {
    if (state.message) announce(state.message);
  }, [state.message, announce]);
  if (!bridge) return null;
  const busy = state.phase === "restarting";
  return (
    <Button
      tone="ghost"
      size="sm"
      data-app-region="no-drag"
      disabled={busy}
      title={state.message ?? `ORCA ${state.installed} is installed. Restart to finish the update.`}
      onClick={() => {
        void bridge.restart().then((result) => {
          if (!result.ok) announce(result.error.message);
        });
      }}
    >
      {busy ? "Preparing restart" : `Restart to finish update to ${state.installed}`}
    </Button>
  );
}

export function LinuxUpdateNotice(): JSX.Element | null {
  const bridge = window.orca.linuxUpdates;
  const [notice, setNotice] = useState(() => bridge?.read() ?? null);
  const [installed, setInstalled] = useState(() => window.orca.linuxRestart?.read() ?? null);
  const announce = useAnnounce();
  useEffect(() => bridge?.subscribe(setNotice), [bridge]);
  useEffect(() => window.orca.linuxRestart?.subscribe(setInstalled), []);
  if (installed) return <LinuxRestartControl state={installed} />;
  if (!bridge || !notice) return null;
  return (
    <span data-app-region="no-drag">
      <Menu
        label={`ORCA ${notice.version} is available`}
        triggerClassName={`orca-btn orca-btn--ghost orca-btn--sm ${textClass("caption")}`}
        items={ITEMS}
        note={
          <>
            You have {notice.current}. Download the package from the release page, then run{" "}
            <MachineText text={notice.installCommand} /> in the folder you saved it to.
          </>
        }
        onChoose={(item) => {
          void bridge.act(item.id as LinuxUpdateAction).then((result) => {
            if (!result.ok) announce(result.error.message);
            else if (item.id === "copy") announce("Install command copied");
          });
        }}
      >
        {`${notice.version} available`}
      </Menu>
    </span>
  );
}
