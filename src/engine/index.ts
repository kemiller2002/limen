// The TypeScript reference engine, as the package's ./reference-engine
// entrypoint (kemiller2002/limen#61). It is a demonstration of an engine, not
// part of Limen Core and not how an application is structured: an application
// writes its own engine, in the language it chooses, behind an EngineTransport. Nothing
// the root entrypoint exports depends on this module.

export { ReferenceEngine, project } from "./engine.js";
export { DirectTypeScriptTransport } from "./transport.js";
export { decodeEmail, eventToCommand, initialState, transition } from "./domain.js";
export type { Command, EmailAddress, State, TransitionError, TransitionResult } from "./domain.js";
