/**
 * Bottom bar: daemon version once connected. The mock also shows an event cursor and an
 * active run count, but neither is available yet — the cursor comes with the connection
 * state machine (#163) and the count needs a runs protocol method — so they're left out
 * rather than shown as invented zeros (docs/design/60-implementation.md).
 */
import type { JSX } from "react";

export interface StatusBarProps {
  orcaVersion?: string;
}

export function StatusBar({ orcaVersion }: StatusBarProps): JSX.Element {
  return (
    <div className="orca-statusbar">
      {orcaVersion ? <span>orca-daemon {orcaVersion}</span> : <span className="orca-faint">not connected</span>}
    </div>
  );
}
