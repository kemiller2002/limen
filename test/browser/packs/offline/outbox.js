// The offline reference page's engine-side outbox: a JavaScript port of
// libraries/fsharp/Limen.Outbox, held to the same language-neutral rules
// (conformance/outbox) by test/outbox-reference.test.ts. Pure: every command
// returns [next outbox, emitted sends, ignored reason or null].

export const empty = Object.freeze({ online: false, held: false, operations: [], notices: [] });

const blocking = (operation) => operation.status !== "queued";

const pump = (outbox) => {
  const head = outbox.operations[0];
  if (head === undefined || !outbox.online || outbox.held || outbox.operations.some(blocking)) return [outbox, []];
  return [
    { ...outbox, operations: outbox.operations.map((o) => (o.id === head.id ? { ...o, status: "sending" } : o)) },
    [{ send: { id: head.id, kind: head.kind, payload: head.payload } }],
  ];
};
const settled = (outbox) => [...pump(outbox), null];
const ignoring = (reason, outbox) => [outbox, [], reason];
const find = (id, outbox) => outbox.operations.find((o) => o.id === id);
const replace = (operation, outbox) => ({ ...outbox, operations: outbox.operations.map((o) => (o.id === operation.id ? operation : o)) });
const remove = (id, outbox) => ({ ...outbox, operations: outbox.operations.filter((o) => o.id !== id) });
const notify = (id, reason, outbox) => ({ ...outbox, notices: [...outbox.notices, { id, reason }] });
const withoutVersion = ({ version, ...operation }) => operation;

export const enqueue = (id, kind, payload, outbox) =>
  find(id, outbox) !== undefined ? ignoring("duplicate-operation", outbox) : settled({ ...outbox, operations: [...outbox.operations, { id, kind, payload, status: "queued" }] });

export const connectivity = (online, outbox) => (online ? settled({ ...outbox, online: true, held: false }) : [{ ...outbox, online: false }, [], null]);

export const flush = (outbox) => (outbox.online ? settled({ ...outbox, held: false }) : ignoring("offline", outbox));

export const result = (id, outcome, outbox) => {
  const operation = find(id, outbox);
  if (operation === undefined) return ignoring("unknown-operation", outbox);
  if (operation.status !== "sending") return ignoring("not-sending", outbox);
  switch (outcome.kind) {
    case "confirmed": return settled(remove(id, outbox));
    case "rejected": return settled(notify(id, outcome.reason, remove(id, outbox)));
    case "conflict": return [replace({ ...operation, status: "conflict", version: outcome.version }, outbox), [], null];
    case "failed": return [{ ...replace({ ...operation, status: "queued" }, outbox), held: true }, [], null];
    case "unknown": return [replace({ ...operation, status: "unknown" }, outbox), [], null];
    default: throw new TypeError(`not an outcome: ${outcome.kind}`);
  }
};

export const reconcile = (id, applied, outbox) => {
  const operation = find(id, outbox);
  if (operation?.status !== "unknown") return ignoring("not-unknown", outbox);
  return applied ? settled(remove(id, outbox)) : settled(replace({ ...operation, status: "queued" }, outbox));
};

export const resolve = (id, resolution, outbox) => {
  const operation = find(id, outbox);
  if (operation?.status !== "conflict") return ignoring("not-conflict", outbox);
  return resolution.kind === "discard"
    ? settled(notify(id, "discarded", remove(id, outbox)))
    : settled(replace({ ...withoutVersion(operation), payload: resolution.payload, status: "queued" }, outbox));
};

export const restore = (operations) =>
  [{ ...empty, operations: operations.map((o) => (o.status === "sending" ? { ...o, status: "unknown" } : o)) }, [], null];

export const dismiss = (id, outbox) => [{ ...outbox, notices: outbox.notices.filter((notice) => notice.id !== id) }, [], null];

// One vector step's command, applied.
export const apply = (step, outbox) => {
  if ("enqueue" in step) return enqueue(step.enqueue.id, step.enqueue.kind, step.enqueue.payload, outbox);
  if ("connectivity" in step) return connectivity(step.connectivity.online, outbox);
  if ("flush" in step) return flush(outbox);
  if ("result" in step) return result(step.result.id, step.result.outcome, outbox);
  if ("reconcile" in step) return reconcile(step.reconcile.id, step.reconcile.applied, outbox);
  if ("resolve" in step) return resolve(step.resolve.id, step.resolve.resolution, outbox);
  if ("restore" in step) return restore(step.restore.operations);
  return dismiss(step.dismiss.id, outbox);
};
