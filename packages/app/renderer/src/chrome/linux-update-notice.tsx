/**
 * The Linux `.deb`'s release notice (#888): non-blocking, in the title bar, and only when a
 * newer release has a package for this machine. The package has no updater, so the notice
 * offers the two things a person needs and nothing more: the release page, and the `apt`
 * command to run once the `.deb` is downloaded. Both are main's strings; this only asks
 * main to open or copy them.
 */
import { useEffect, useState, type JSX } from "react";
import type { LinuxUpdateAction } from "../../../src/linux-update-contract.js";
import { useAnnounce } from "../a11y/announce-context.js";
import { MachineText, Menu, textClass, type MenuItem } from "../ui/index.js";

const ITEMS: readonly MenuItem[] = [
  { id: "open", label: "Open release page" },
  { id: "copy", label: "Copy install command" },
];

export function LinuxUpdateNotice(): JSX.Element | null {
  const bridge = window.orca.linuxUpdates;
  const [notice, setNotice] = useState(() => bridge?.read() ?? null);
  const announce = useAnnounce();
  useEffect(() => bridge?.subscribe(setNotice), [bridge]);
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
