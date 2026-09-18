// A complete Limen engine, in plain JavaScript, with no build step.
//
// This file is shipped inside the npm package so that a consumer can read one
// entire working application without cloning the repository. It is deliberately
// the smallest thing that is still architecturally correct: state is
// authoritative, transitions are pure, and what the view is *allowed* to do is
// projected rather than re-derived by the DOM.
//
// TypeScript consumers get full types for everything used here; see
// examples/minimal/types.check.ts, and docs/quick-start.md for the TypeScript
// version of this same application.

/** @typedef {{ count: number }} State */

/** The one place this application's truth lives. @type {State} */
const initialState = { count: 0 };

// Pure: same state and event name in, same state out. No DOM, no fetch, no
// globals — and nothing here could reach them even if it tried, because this
// module imports nothing.
/**
 * @param {State} state
 * @param {string} name
 * @returns {State}
 */
export function transition(state, name) {
  switch (name) {
    case "increment": return { count: state.count + 1 };
    case "reset": return { count: 0 };
    // An event the engine does not recognise is a wiring bug — an HTML
    // data-event that nothing answers. Failing loudly beats a button that
    // silently does nothing.
    default: throw new Error(`Unrecognized event: ${name}`);
  }
}

// Pure: state in, view out. `resetDisabled` is the point of the example — the
// engine decides whether Reset is available, and the DOM never works it out
// from the number on screen.
/**
 * @param {State} state
 * @returns {Record<string, string | number | boolean>}
 */
export function project(state) {
  return { count: state.count, resetDisabled: state.count === 0 };
}

/**
 * The whole engine↔kernel contract: two methods.
 * @returns {{ start(): Promise<void>, dispatch(message: any): Promise<any> }}
 */
export function createCounterTransport() {
  let state = initialState;
  return {
    async start() {},
    async dispatch(message) {
      if (message.kind === "Event") state = transition(state, message.event.name);
      // Every response carries a full projection, any effects to run, and any
      // in-flight effects to cancel. This engine requests no effects at all.
      return { view: project(state), effects: [], cancellations: [] };
    },
  };
}
