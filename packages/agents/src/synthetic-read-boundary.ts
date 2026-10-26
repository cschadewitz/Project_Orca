/** Inactive #703 fixture at AgentHost.fs. Never registered with ACP or exported by the package. */
import type { AgentHost } from "./host.js";

/** Exact ACP read parameters: null, omitted and numeric values retain their representation. */
export interface SyntheticTextRead {
  readonly path: string;
  readonly line?: number | null;
  readonly limit?: number | null;
}

declare const capturedRead: unique symbol;
export interface CapturedSyntheticRead {
  readonly [capturedRead]: true;
}

/**
 * Inject only a disposable synthetic host. String paths provide no physical confinement,
 * conditional read, stable handle or symlink/rename race guarantee on a real filesystem.
 */
export class SyntheticReadBoundary {
  private readonly reads = new WeakMap<CapturedSyntheticRead, Readonly<SyntheticTextRead>>();

  constructor(private readonly host: Pick<AgentHost, "fs">) {}

  /** Synchronous capture before policy or any other await. Caller metadata is not a capability. */
  capture(parameters: SyntheticTextRead): CapturedSyntheticRead {
    const retained = Object.freeze(structuredClone(parameters));
    const handle = Object.freeze({}) as CapturedSyntheticRead;
    this.reads.set(handle, retained);
    return handle;
  }

  inspect(handle: CapturedSyntheticRead): Readonly<SyntheticTextRead> {
    const parameters = this.reads.get(handle);
    if (!parameters) throw new Error("Unknown synthetic read capture");
    return parameters;
  }

  /** Synthetic executor capability only; this helper itself provides no policy or one-use check. */
  async read(handle: CapturedSyntheticRead): Promise<string> {
    const { path, line, limit } = this.inspect(handle);
    const content = await this.host.fs.readFile(path);
    // Mirrors the existing ACP callback, including reading the whole file before slicing.
    if (line === undefined || line === null) return content;
    const start = Math.max(0, line - 1);
    return content
      .split("\n")
      .slice(start, limit !== undefined && limit !== null ? start + limit : undefined)
      .join("\n");
  }
}
