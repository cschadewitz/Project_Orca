/** Current endpoint and precedence source displayed in Config. */
import { useEffect, useState, type JSX } from "react";
import type { DaemonConnectionBridge } from "../../../src/daemon-connection.js";
import { Button, Text } from "../ui/index.js";
export function ConnectionSource({ bridge }: { bridge: DaemonConnectionBridge }): JSX.Element {
  const [target, setTarget] = useState(() => bridge.read());
  useEffect(() => bridge.subscribe(setTarget), [bridge]);
  return (
    <div className="orca-banner">
      <Text style="caption">
        Daemon: {target.profile ? `${target.profile.name} (ssh ${target.profile.destination})` : target.url} · Source:{" "}
        {target.source}
      </Text>
      <Button size="sm" onClick={() => bridge.show()}>
        Connect to a daemon…
      </Button>
    </div>
  );
}
