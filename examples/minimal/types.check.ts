// Not part of the running application. This file exists so that a build can
// prove the package's type declarations actually resolve for a consumer —
// scripts/clean-room.ts type-checks it against the *installed* package, not
// against this repository's source.
//
// If you are writing TypeScript, this is the shape your own engine takes.
import { BrowserKernel } from "@echelon-foundry/typescript-wasm-kernel";
import type {
  BrowserToEngineMessage,
  EngineToBrowserMessage,
  EngineTransport,
  ViewState,
} from "@echelon-foundry/typescript-wasm-kernel/protocol";

type State = { readonly count: number };

const transition = (state: State, name: string): State => {
  switch (name) {
    case "increment": return { count: state.count + 1 };
    case "reset": return { count: 0 };
    default: throw new Error(`Unrecognized event: ${name}`);
  }
};

const project = (state: State): ViewState => ({
  count: state.count,
  resetDisabled: state.count === 0,
});

export function createCounterTransport(): EngineTransport {
  let state: State = { count: 0 };
  return {
    async start(): Promise<void> {},
    async dispatch(message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> {
      if (message.kind === "Event") state = transition(state, message.event.name);
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}

export const mount = async (document: Document): Promise<void> => {
  await new BrowserKernel(createCounterTransport(), document).start();
};
