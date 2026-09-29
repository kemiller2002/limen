// An optional host adapter: runs any Limen engine in a dedicated worker, off
// the main thread (kemiller2002/limen#41, LCP-035).
//
// The kernel stays on the main thread with the DOM and never knows the engine
// moved: this is an EngineTransport like any other. What crosses to the
// worker is the same serialized BrowserToEngine / EngineToBrowser JSON an
// in-process transport would carry, as a string; no DOM object, no function,
// no shared memory. Replies are untrusted until the generated contract
// decoder accepts them. Nothing here knows the guest language: the worker's
// own composition root (worker-engine.ts) decides which engine runs.
//
// Faults are explicit. A worker that fails to start, throws, cannot be
// messaged, stops answering, or is terminated rejects every dispatch in
// flight and every later one with a WorkerFault whose name says which, and is
// terminated itself, because an engine whose state is unknown must not keep
// running. The kernel reports the failed dispatch; the fallback host
// (src/hosts/fallback.ts) turns it into an error id and a restart, which is a
// new worker.

import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport } from "../protocol.js";
import { decodeEngineResponse } from "./dotnet-wasm-transport.js";

// The parts of a Worker used here, so a test can supply its own.
export type WorkerLike = EventTarget & {
  postMessage(message: unknown): void;
  terminate(): void;
};

export type WorkerFaultName =
  | "WorkerStartFailed"
  | "WorkerCrashed"
  | "WorkerMessageError"
  | "WorkerEngineFailed"
  | "WorkerTimeout"
  | "WorkerTerminated";

export class WorkerFault extends Error {
  constructor(name: WorkerFaultName, detail: string) {
    super(detail);
    this.name = name;
  }
}

export type WorkerTransportOptions = {
  // () => new Worker(new URL("./worker.js", import.meta.url), { type: "module" })
  readonly createWorker: () => WorkerLike;
  // How long the worker may take to load its engine. Default 60 s.
  readonly startTimeoutMs?: number;
  // How long one dispatch may take before the worker is presumed hung and
  // terminated. Default 30 s.
  readonly dispatchTimeoutMs?: number;
};

export type WorkerTransportStatus = "idle" | "starting" | "running" | "faulted" | "terminated";

type Waiting = { readonly resolve: (json: string) => void; readonly reject: (error: WorkerFault) => void; readonly timer: ReturnType<typeof setTimeout> };

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

export class WorkerTransport implements EngineTransport {
  readonly #options: WorkerTransportOptions;
  #worker: WorkerLike | null = null;
  #status: WorkerTransportStatus = "idle";
  #fault: WorkerFault | null = null;
  #next = 0;
  // Keyed by dispatch id; 0 is the start handshake.
  readonly #waiting = new Map<number, Waiting>();

  constructor(options: WorkerTransportOptions) {
    this.#options = options;
  }

  get status(): WorkerTransportStatus {
    return this.#status;
  }

  async start(): Promise<void> {
    if (this.#status !== "idle") throw new Error(`WorkerTransport.start() called while ${this.#status}.`);
    this.#status = "starting";
    const worker = this.#options.createWorker();
    this.#worker = worker;
    worker.addEventListener("message", (event) => { this.#receive(field(event, "data")); });
    worker.addEventListener("error", (event) => {
      event.preventDefault();
      this.#failWith(new WorkerFault(this.#status === "starting" ? "WorkerStartFailed" : "WorkerCrashed", "The engine worker threw."));
    });
    worker.addEventListener("messageerror", () => { this.#failWith(new WorkerFault("WorkerMessageError", "A message from the engine worker could not be read.")); });
    await this.#request(0, { kind: "start" }, this.#options.startTimeoutMs ?? 60000, "WorkerStartFailed");
    if (this.#status === "starting") this.#status = "running";
  }

  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    if (this.#fault !== null) throw this.#fault;
    if (this.#status !== "running") throw new Error("WorkerTransport.dispatch() called before start().");
    this.#next += 1;
    const json = await this.#request(this.#next, { kind: "dispatch", id: this.#next, message: JSON.stringify(message) }, this.#options.dispatchTimeoutMs ?? 30000, "WorkerTimeout");
    return decodeEngineResponse(json, "The worker-hosted engine");
  }

  // Ends the worker. Everything in flight, and every later dispatch, is
  // rejected as WorkerTerminated.
  terminate(): void {
    this.#failWith(new WorkerFault("WorkerTerminated", "The engine worker was terminated."), "terminated");
  }

  #request(id: number, message: unknown, timeoutMs: number, onTimeout: WorkerFaultName): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => { this.#failWith(new WorkerFault(onTimeout, `The engine worker did not answer within ${timeoutMs} ms.`)); }, timeoutMs);
      this.#waiting.set(id, { resolve, reject, timer });
      this.#worker?.postMessage(message);
    });
  }

  #receive(data: unknown): void {
    const kind = field(data, "kind");
    const id = kind === "started" ? 0 : field(data, "id");
    const waiting = typeof id === "number" ? this.#waiting.get(id) : undefined;
    const message = field(data, "message");
    if (kind === "failed") {
      const name = field(data, "name");
      this.#failWith(new WorkerFault(this.#status === "starting" ? "WorkerStartFailed" : "WorkerEngineFailed", `The worker-hosted engine failed: ${typeof name === "string" ? name : "Error"}.`));
      return;
    }
    if (waiting === undefined || typeof id !== "number") return;
    if (kind === "started" || (kind === "reply" && typeof message === "string")) {
      clearTimeout(waiting.timer);
      this.#waiting.delete(id);
      waiting.resolve(typeof message === "string" ? message : "");
    }
  }

  #failWith(fault: WorkerFault, status: "faulted" | "terminated" = "faulted"): void {
    if (this.#fault !== null) return;
    this.#fault = fault;
    this.#status = status;
    this.#worker?.terminate();
    [...this.#waiting.values()].forEach((waiting) => { clearTimeout(waiting.timer); waiting.reject(fault); });
    this.#waiting.clear();
  }
}
