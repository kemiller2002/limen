import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport } from "../protocol.js";
import { ReferenceEngine } from "./engine.js";

/**
 * Reference implementation only — **not** a base class or a starting point.
 *
 * This transport is hard-wired to this repository's demo domain (email
 * availability). It understands exactly two event names, `emailChanged` and
 * `checkAvailability`, and throws `Unrecognized event: …` otherwise; it also
 * throws on every `StorageResult`, because its domain never requests a
 * Storage effect.
 *
 * To build an application, implement {@link EngineTransport} yourself — it is
 * two methods and about eight lines. See `docs/02-getting-started.md`.
 */
export class DirectTypeScriptTransport implements EngineTransport {
  readonly #engine = new ReferenceEngine();
  async start(): Promise<void> {}
  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    return this.#engine.handle(message);
  }
}
