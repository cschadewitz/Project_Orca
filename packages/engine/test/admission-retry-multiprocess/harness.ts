import { fork, type ChildProcess } from "node:child_process";
import { afterAll } from "vitest";
import { compileRetryWorker } from "./compiled-worker.js";
import type { RetryResult, DirectAdmissionResult } from "../../../core/src/model/admission-retry.js";
import type { SubmissionResult } from "@orca/core";
import type { AdmissionKind, Boundary } from "./fixture.js";

export type Result = RetryResult<DirectAdmissionResult | SubmissionResult>;
interface Messages {
  ready: { operations: string[]; runs: string[]; starts: number };
  claim: undefined;
  claimed: { fresh: boolean; operationId: string };
  contender: undefined;
  locking: undefined;
  boundary: { name: Boundary };
  result: { result: Result; starts: number };
}
interface Message {
  type: string;
  pid: number;
  data: unknown;
}

let compiled: ReturnType<typeof compileRetryWorker> | undefined;
afterAll(() => compiled?.dispose());

export class Worker {
  readonly child: ChildProcess;
  readonly closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly messages: Message[] = [];
  private readonly listeners = new Set<() => void>();
  private failure: Error | undefined;
  private ended = false;
  private stderr = "";

  constructor(dir: string, kind: AdmissionKind, stopAt: Boundary | "none" = "none", mode = "normal") {
    compiled ??= compileRetryWorker();
    compiled.verify();
    this.child = fork(compiled.entry, [dir, kind, stopAt, mode], {
      execArgv: [],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    this.child.stderr!.on("data", (data: Buffer) => {
      this.stderr += data.toString();
    });
    this.child.on("message", (message: Message) => {
      this.messages.push(message);
      if (message.type === "error") this.failure = new Error(JSON.stringify(message.data));
      this.notify();
    });
    this.child.on("error", (error) => {
      this.failure = error;
      this.notify();
    });
    this.closed = new Promise((resolve) => {
      this.child.on("close", (code, signal) => {
        this.ended = true;
        this.notify();
        resolve({ code, signal });
      });
    });
  }
  private notify() {
    for (const listener of this.listeners) listener();
  }
  wait<K extends keyof Messages>(type: K): Promise<Messages[K]> {
    return new Promise((resolve, reject) => {
      // Deadline only bounds a broken barrier; it never orders the tested race.
      const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${type}`)), 15_000);
      const finish = (error?: Error, data?: unknown) => {
        clearTimeout(timeout);
        this.listeners.delete(check);
        if (error) reject(new Error(`${error.message}\nchild stderr: ${this.stderr}`));
        else resolve(data as Messages[K]);
      };
      const check = () => {
        const index = this.messages.findIndex((message) => message.type === type);
        if (index >= 0) finish(undefined, this.messages.splice(index, 1)[0]!.data);
        else if (this.failure) finish(this.failure);
        else if (this.ended) finish(new Error(`Child exited before ${type}`));
      };
      this.listeners.add(check);
      check();
    });
  }
  release(name: string) {
    this.child.send({ release: name }, (error) => {
      if (error) {
        this.failure = error;
        this.notify();
      }
    });
  }
  async kill() {
    if (!this.ended) this.child.kill("SIGKILL");
    return this.closed;
  }
}
