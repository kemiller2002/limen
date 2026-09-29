// An optional host adapter: runs a Limen engine compiled to raw WebAssembly
// (Rust, or any language that can export three functions) with no JavaScript
// bindings generator. The ABI moves UTF-8 JSON through linear memory:
//
//   limen_alloc(len) -> ptr        host writes len bytes of input at ptr
//   limen_dispatch(ptr, len) -> n  consumes the input; returns BigInt
//                                  (out_ptr << 32) | out_len. The output's
//                                  first byte is 0 (JSON follows) or 1 (an
//                                  error message follows)
//   limen_free(ptr, len)           host releases the output
//
// Mechanism only; the engine's response is decoded with the generated
// contract decoder before the kernel sees it.

import type { BrowserToEngineMessage, EngineToBrowserMessage, EngineTransport } from "../protocol.js";
import { decodeEngineResponse } from "./dotnet-wasm-transport.js";

export type RawWasmOptions = {
  // () => fetch("./engine.wasm") — resolved by the caller.
  readonly loadModule: () => Promise<Response>;
};

type Abi = {
  readonly memory: WebAssembly.Memory;
  readonly alloc: (length: number) => number;
  readonly dispatch: (pointer: number, length: number) => bigint;
  readonly free: (pointer: number, length: number) => void;
};

const exported = (exports: WebAssembly.Exports, name: string): unknown => Reflect.get(exports, name);

const abiOf = (exports: WebAssembly.Exports): Abi => {
  const memory = exported(exports, "memory");
  const alloc = exported(exports, "limen_alloc");
  const dispatch = exported(exports, "limen_dispatch");
  const free = exported(exports, "limen_free");
  if (!(memory instanceof WebAssembly.Memory) || typeof alloc !== "function" || typeof dispatch !== "function" || typeof free !== "function") {
    throw new Error("The WebAssembly module does not implement the Limen raw ABI (memory, limen_alloc, limen_dispatch, limen_free).");
  }
  return {
    memory,
    alloc: (length) => Number(Reflect.apply(alloc, undefined, [length])),
    dispatch: (pointer, length) => BigInt.asUintN(64, BigInt(Reflect.apply(dispatch, undefined, [pointer, length]) as bigint)),
    free: (pointer, length) => { Reflect.apply(free, undefined, [pointer, length]); },
  };
};

export class RawWasmTransport implements EngineTransport {
  readonly #options: RawWasmOptions;
  #abi: Abi | null = null;

  constructor(options: RawWasmOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    const { instance } = await WebAssembly.instantiateStreaming(this.#options.loadModule(), {});
    this.#abi = abiOf(instance.exports);
  }

  async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
    const abi = this.#abi;
    if (abi === null) throw new Error("RawWasmTransport.dispatch() called before start().");
    const input = new TextEncoder().encode(JSON.stringify(message));
    const pointer = abi.alloc(input.length);
    new Uint8Array(abi.memory.buffer, pointer, input.length).set(input);
    const packed = abi.dispatch(pointer, input.length);
    const outPointer = Number(packed >> 32n);
    const outLength = Number(packed & 0xffffffffn);
    // Copy out before freeing: memory.buffer may be replaced if memory grows.
    const output = new Uint8Array(abi.memory.buffer, outPointer, outLength).slice();
    abi.free(outPointer, outLength);
    const text = new TextDecoder().decode(output.subarray(1));
    if (output[0] !== 0) throw new Error(`The WebAssembly engine refused the message: ${text}`);
    return decodeEngineResponse(text, "The WebAssembly engine");
  }
}
