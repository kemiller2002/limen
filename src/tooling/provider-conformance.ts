// A shared conformance suite for capability providers (LCP-031): the same
// checks for every pack, fed by that pack's own fixtures and generated
// decoder. It proves the provider honours the Core seam — it does not test
// what the capability means.
//
//   1. A malformed request is Rejected(malformed-request) and never throws.
//   2. Every valid request Completes, and the result decodes with the pack's
//      generated decoder.
//   3. Every result is plain JSON: it survives a JSON round trip unchanged,
//      so no DOM node, File, function or other browser object crossed.
//   4. An aborted request still settles, promptly, with a result the decoder
//      accepts (the provider's own Cancelled, or its completed answer if it
//      finished first) — cancellation never fabricates or loses an outcome.
//   5. The descriptor names an id, a positive version and a fingerprint.

import type { CapabilityProvider } from "../kernel/capabilities.js";
import type { CorrelationId } from "../protocol.js";

type Decoded = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: { readonly path: string } };

export type ProviderFixture = {
  // The request payloads; `unknown` because malformed ones are the point.
  readonly valid: readonly { readonly name: string; readonly payload: unknown }[];
  readonly malformed: readonly { readonly name: string; readonly payload: unknown }[];
  readonly cancellable?: { readonly name: string; readonly payload: unknown };
  readonly decodeResult: (value: unknown) => Decoded;
  readonly document: Document;
  readonly settleWithinMs?: number;
};

const sameJson = (value: unknown): boolean => {
  try {
    return JSON.stringify(JSON.parse(JSON.stringify(value))) === JSON.stringify(value) && !containsNonJson(value);
  } catch {
    return false;
  }
};

const containsNonJson = (value: unknown): boolean => {
  if (value === null || ["string", "boolean"].includes(typeof value)) return false;
  if (typeof value === "number") return !Number.isFinite(value);
  if (Array.isArray(value)) return value.some(containsNonJson);
  if (typeof value !== "object") return true;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype !== Object.prototype && prototype !== null) || Object.values(value).some(containsNonJson);
};

const settle = async <T>(work: Promise<T>, milliseconds: number): Promise<{ readonly settled: true; readonly value: T } | { readonly settled: false }> => {
  const timeout = new Promise<{ readonly settled: false }>((resolve) => { setTimeout(() => resolve({ settled: false }), milliseconds); });
  return Promise.race([work.then((value) => ({ settled: true as const, value })), timeout]);
};

export const runProviderConformance = async (provider: CapabilityProvider, fixture: ProviderFixture): Promise<readonly string[]> => {
  const within = fixture.settleWithinMs ?? 1000;
  const context = (name: string, signal: AbortSignal) => ({ correlationId: `conformance-${name}` as CorrelationId, signal, document: fixture.document });
  const execute = async (name: string, payload: unknown, signal: AbortSignal = new AbortController().signal): Promise<{ readonly kind: "threw"; readonly error: string } | { readonly kind: "result"; readonly result: Awaited<ReturnType<CapabilityProvider["execute"]>> }> => {
    try {
      return { kind: "result", result: await provider.execute(payload, context(name, signal)) };
    } catch (error) {
      return { kind: "threw", error: String(error) };
    }
  };

  const descriptor = provider.descriptor;
  const descriptorFailures = [
    ...(typeof descriptor.id === "string" && descriptor.id.length > 0 ? [] : ["descriptor: id is empty"]),
    ...(Number.isInteger(descriptor.version) && descriptor.version >= 1 ? [] : ["descriptor: version must be a positive integer"]),
    ...(/^sha256:[0-9a-f]{64}$/.test(descriptor.fingerprint) ? [] : ["descriptor: fingerprint is not a generated contract fingerprint"]),
  ];

  const malformedFailures = await Promise.all(fixture.malformed.map(async ({ name, payload }) => {
    const outcome = await execute(name, payload);
    if (outcome.kind === "threw") return [`malformed ${name}: threw instead of answering Rejected (${outcome.error})`];
    return outcome.result.kind === "Rejected" && outcome.result.reason === "malformed-request" ? [] : [`malformed ${name}: answered ${outcome.result.kind}, expected Rejected(malformed-request)`];
  }));

  const validFailures = await Promise.all(fixture.valid.map(async ({ name, payload }) => {
    const outcome = await execute(name, payload);
    if (outcome.kind === "threw") return [`valid ${name}: threw (${outcome.error})`];
    if (outcome.result.kind !== "Completed") return [`valid ${name}: answered ${outcome.result.kind}, expected Completed`];
    const decoded = fixture.decodeResult(outcome.result.result);
    return [
      ...(decoded.ok ? [] : [`valid ${name}: result is outside the pack's contract at ${decoded.error.path}`]),
      ...(sameJson(outcome.result.result) ? [] : [`valid ${name}: result is not plain JSON (a browser object, function or non-finite number crossed)`]),
    ];
  }));

  const cancellable = fixture.cancellable;
  const cancellationFailures = cancellable === undefined ? [] : await (async () => {
    const { name, payload } = cancellable;
    const controller = new AbortController();
    const running = execute(name, payload, controller.signal);
    controller.abort("cancelled");
    const outcome = await settle(running, within);
    if (!outcome.settled) return [`cancellable ${name}: did not settle within ${within}ms of cancellation`];
    if (outcome.value.kind === "threw") return [`cancellable ${name}: threw on cancellation (${outcome.value.error})`];
    if (outcome.value.result.kind !== "Completed") return [`cancellable ${name}: answered ${outcome.value.result.kind} on cancellation`];
    return fixture.decodeResult(outcome.value.result.result).ok ? [] : [`cancellable ${name}: cancelled result is outside the pack's contract`];
  })();

  return [...descriptorFailures, ...malformedFailures.flat(), ...validFailures.flat(), ...cancellationFailures];
};
