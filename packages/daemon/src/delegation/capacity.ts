/**
 * What this daemon knows of each remote daemon's session cap (#884), for the engine's slot
 * queue (`Orchestrator.remoteSessionCap`).
 *
 * A remote's cap is its own `limits.maxAgentSessions`, as its `hello` reports it
 * (`sessionSlots.maxAgentSessions`) at each delegated session open: absent is unlimited, and so
 * is a remote too old to report slots. Until a remote has answered once since this daemon
 * started, its cap is taken to be 1, so the first session learns the real one and a fan-out
 * never opens more sessions than the remote allows before anybody knows the limit.
 *
 * This only keeps one daemon from queuing past a remote's cap on its own side, where the wait
 * shows on the step. The remote enforces its cap itself, which is what bounds several
 * parents sharing it.
 */
export class RemoteCapacity {
  /** A remote's cap once learned: a number, or null for unlimited. */
  private readonly known = new Map<string, number | null>();
  private listener: () => void = () => undefined;

  /** Called whenever a learned cap changes, so the slot queue can look again. */
  onChange(listener: () => void): void {
    this.listener = listener;
  }

  cap(remoteId: string): number | undefined {
    const known = this.known.get(remoteId);
    if (known === undefined) return 1;
    return known ?? undefined;
  }

  /** What a remote's `hello` said: its daemon-wide cap, or undefined for none. */
  learn(remoteId: string, maxAgentSessions: number | undefined): void {
    const value = maxAgentSessions ?? null;
    if (this.known.get(remoteId) === value) return;
    this.known.set(remoteId, value);
    this.listener();
  }
}
