// A synthetic engine for the worker-hosting measurements (kemiller2002/limen#41).
// It answers with a view of the size it is asked for, or spends the time it is
// asked to, so payload and compute cost can be measured apart from any real
// application. Not an example of engine design.
const row = (index) => ({ id: `r${index}`, text: `row ${index} — the quick brown fox jumps over the lazy dog` });

export const createSyntheticEngine = () => ({
  start: async () => {},
  dispatch: async (message) => {
    const event = message.kind === "Event" ? message.event : undefined;
    if (event?.name === "payload") return { view: { rows: Array.from({ length: Number(event.value) }, (_, index) => row(index)) }, effects: [], cancellations: [] };
    if (event?.name === "work") {
      const until = performance.now() + Number(event.value);
      while (performance.now() < until) { /* the engine is busy: a long, synchronous transition */ }
    }
    return { view: { rows: [] }, effects: [], cancellations: [] };
  },
});
