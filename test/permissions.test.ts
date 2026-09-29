// The permission-sensitive capability pattern (kemiller2002/limen#42,
// LCP-036), its device reference (geolocation) and its security reference
// (WebAuthn credentials), against scripted browser APIs:
//   - both packs share one vocabulary, held here against their contracts;
//   - unavailable is never denied, and each unavailable reason is distinct;
//   - a permission change, including a revocation, is a fact;
//   - nothing is requested at initialization;
//   - gesture-required operations are NeedsGesture without activation;
//   - credentials are carried, never verified.
// Real Chromium — a granted, revoked and denied location, and passkeys on a
// virtual authenticator with and without a real click — is
// test/browser/packs/permissions/.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { geolocationCapability, decodeGeolocationFact, decodeGeolocationResult, type GeolocationFact, type GeolocationRequest, type GeolocationResult } from "../dist/capabilities/geolocation/index.js";
import { credentialsCapability, decodeCredentialsResult, fromBase64Url, toBase64Url, type CredentialsRequest, type CredentialsResult } from "../dist/capabilities/credentials/index.js";
import { hasUserActivation, permissionStateOf, presenceOf } from "../dist/capability-support/permissions.js";
import { runProviderConformance } from "../dist/tooling/provider-conformance.js";
import type { CapabilityProvider, CorrelationId } from "../dist/index.js";
import { withDom } from "./dom-helpers.ts";

type Contract = { readonly types: readonly { readonly name: string; readonly variants?: readonly { readonly name: string; readonly fields: readonly { readonly name: string; readonly type: unknown }[] }[] }[] };
const contractOf = async (name: string): Promise<Contract> => JSON.parse(await readFile(new URL(`../contract/${name}.contract.json`, import.meta.url), "utf8")) as Contract;

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 10); });

// --- scripted browser APIs --------------------------------------------------

type FakePermission = EventTarget & { state: string; set(state: string): void };
const fakePermission = (state: string): FakePermission => {
  const status = Object.assign(new EventTarget(), { state, set: (next: string) => { status.state = next; status.dispatchEvent(new Event("change")); } });
  return status;
};

type Browser = { readonly queries: string[]; readonly located: number[]; permission?: FakePermission; activation?: boolean; secure?: boolean };

const install = (window: Window, browser: Browser, apis: { readonly geolocation?: Geolocation; readonly credentials?: unknown; readonly publicKeyCredential?: unknown }): void => {
  const navigator = window.navigator;
  Object.defineProperty(window, "isSecureContext", { value: browser.secure ?? true, configurable: true });
  Object.defineProperty(navigator, "permissions", { value: { query: async ({ name }: { name: string }) => { browser.queries.push(name); if (browser.permission === undefined) throw new TypeError("unknown"); return browser.permission; } }, configurable: true });
  if (browser.activation !== undefined) Object.defineProperty(navigator, "userActivation", { value: { get isActive() { return browser.activation; } }, configurable: true });
  if (apis.geolocation !== undefined) Object.defineProperty(navigator, "geolocation", { value: apis.geolocation, configurable: true });
  if (apis.credentials !== undefined) Object.defineProperty(navigator, "credentials", { value: apis.credentials, configurable: true });
  if (apis.publicKeyCredential !== undefined) Object.defineProperty(window, "PublicKeyCredential", { value: apis.publicKeyCredential, configurable: true });
};

// getCurrentPosition answering with a position, or with an error code.
const fakeGeolocation = (browser: Browser, answer: { readonly position?: { latitude: number; longitude: number; accuracy: number }; readonly code?: number }): Geolocation => ({
  getCurrentPosition: (success: PositionCallback, failure?: PositionErrorCallback | null) => {
    browser.located.push(1);
    setTimeout(() => {
      if (answer.position !== undefined) success({ coords: { ...answer.position, altitude: null, altitudeAccuracy: null, heading: null, speed: null, toJSON: () => ({}) }, timestamp: 1000, toJSON: () => ({}) });
      else failure?.({ code: answer.code ?? 2, message: "", PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 });
    }, 0);
  },
  watchPosition: () => 0,
  clearWatch: () => {},
});

const run = async <R>(provider: CapabilityProvider, document: Document, request: unknown, decode: (value: unknown) => { ok: true; value: R } | { ok: false }): Promise<R> => {
  const answer = await provider.execute(request, { correlationId: "p" as CorrelationId, signal: new AbortController().signal, document });
  const decoded = answer.kind === "Completed" ? decode(answer.result) : { ok: false as const };
  assert.ok(decoded.ok, JSON.stringify(answer));
  return decoded.value;
};

const geo = (document: Document, facts: GeolocationFact[] = []) => {
  const provider = geolocationCapability();
  provider.activate({ document, emitFact: (fact) => { const decoded = decodeGeolocationFact(fact); assert.ok(decoded.ok); facts.push(decoded.value); } });
  return (request: GeolocationRequest): Promise<GeolocationResult> => run(provider, document, request, decodeGeolocationResult);
};
const creds = (document: Document) => {
  const provider = credentialsCapability();
  provider.activate({ document, emitFact: () => {} });
  return (request: CredentialsRequest): Promise<CredentialsResult> => run(provider, document, request, decodeCredentialsResult);
};

const LOCATE = { operation: "locate", highAccuracy: false, timeoutMs: 1000, maximumAgeMs: 0 } as const;

// --- the shared pattern -----------------------------------------------------

test("the packs share one vocabulary: the same permission states and unavailable reasons, and an Unavailable variant with that reason", async () => {
  const [geolocation, credentials] = await Promise.all([contractOf("geolocation"), contractOf("credentials")]);
  const shared = (contract: Contract, name: string) => JSON.stringify(contract.types.find((type) => type.name === name));
  ["PermissionState", "UnavailableReason"].forEach((name) => assert.equal(shared(geolocation, name).replace(/"doc":"[^"]*",?/, ""), shared(credentials, name).replace(/"doc":"[^"]*",?/, ""), name));
  [[geolocation, "GeolocationResult"], [credentials, "CredentialsResult"]].forEach(([contract, result]) => {
    const unavailable = (contract as Contract).types.find((type) => type.name === result)?.variants?.find((variant) => variant.name === "Unavailable");
    assert.deepEqual(unavailable?.fields.map((field) => [field.name, field.type]), [["reason", "UnavailableReason"]], String(result));
  });
});

test("presence: no secure context, no API and a blocking policy are three distinct reasons, checked in that order", async () => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    Object.defineProperty(window, "isSecureContext", { value: false, configurable: true });
    assert.deepEqual(presenceOf(document, { present: true, secureContextRequired: true }), { kind: "absent", because: "no-secure-context" });
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    assert.deepEqual(presenceOf(document, { present: false, secureContextRequired: true }), { kind: "absent", because: "no-api" });
    Object.defineProperty(document, "permissionsPolicy", { value: { allowsFeature: (feature: string) => feature !== "geolocation" }, configurable: true });
    assert.deepEqual(presenceOf(document, { present: true, policyFeature: "geolocation", secureContextRequired: true }), { kind: "absent", because: "policy-blocks" });
    assert.deepEqual(presenceOf(document, { present: true, policyFeature: "camera", secureContextRequired: true }), { kind: "present" });
  });
});

test("activation: read from navigator.userActivation; a browser without it is assumed active so its own refusal is the evidence", async () => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    assert.equal(hasUserActivation(document), true);
    const browser: Browser = { queries: [], located: [], activation: false };
    install(window, browser, {});
    assert.equal(hasUserActivation(document), false);
    browser.activation = true;
    assert.equal(hasUserActivation(document), true);
  });
});

// --- geolocation ------------------------------------------------------------

test("geolocation: activation asks for nothing; permission is read without prompting; unavailable is never denied", async () => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const noApi: Browser = { queries: [], located: [], permission: fakePermission("prompt") };
    install(window, noApi, {});
    const ask = geo(document);
    assert.deepEqual([noApi.queries, noApi.located], [[], []], "registering the pack queried and requested nothing");
    assert.deepEqual(await ask(LOCATE), { kind: "Unavailable", reason: "notSupported" });
    const insecure: Browser = { queries: [], located: [], permission: fakePermission("granted"), secure: false };
    install(window, insecure, { geolocation: fakeGeolocation(insecure, { position: { latitude: 1, longitude: 2, accuracy: 3 } }) });
    assert.deepEqual(await ask(LOCATE), { kind: "Unavailable", reason: "insecureContext" });
    assert.deepEqual(insecure.located, [], "an unavailable API is never called");
    const browser: Browser = { queries: [], located: [], permission: fakePermission("prompt") };
    install(window, browser, { geolocation: fakeGeolocation(browser, { position: { latitude: 51.5, longitude: -0.12, accuracy: 20 } }) });
    assert.deepEqual(await ask({ operation: "permission" }), { kind: "Permission", state: "prompt" });
    assert.deepEqual(browser.located, [], "reading the permission did not prompt");
    assert.deepEqual(await ask(LOCATE), { kind: "Located", position: { latitude: 51.5, longitude: -0.12, accuracyM: 20, timestampMs: 1000 } });
  });
});

test("geolocation: denied, position unavailable and timed out are three outcomes", async () => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const outcomes = await [1, 2, 3].reduce<Promise<readonly GeolocationResult[]>>(async (done, code) => {
      const previous = await done;
      const browser: Browser = { queries: [], located: [], permission: fakePermission("prompt") };
      install(window, browser, { geolocation: fakeGeolocation(browser, { code }) });
      return [...previous, await geo(document)(LOCATE)];
    }, Promise.resolve([]));
    assert.deepEqual(outcomes.map((outcome) => outcome.kind), ["Denied", "PositionUnavailable", "TimedOut"]);
  });
});

test("geolocation: permission changes, including a revocation, are facts until unwatched; a browser that cannot report them says so", async () => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const status = fakePermission("prompt");
    const browser: Browser = { queries: [], located: [], permission: status };
    install(window, browser, { geolocation: fakeGeolocation(browser, {}) });
    const facts: GeolocationFact[] = [];
    const ask = geo(document, facts);
    assert.deepEqual(await ask({ operation: "watchPermission" }), { kind: "Watching", state: "prompt" });
    status.set("granted");
    status.set("granted");
    status.set("prompt");
    status.set("denied");
    await settle();
    assert.deepEqual(facts, [
      { kind: "PermissionChanged", state: "granted", previous: "prompt" },
      { kind: "PermissionChanged", state: "prompt", previous: "granted" },
      { kind: "PermissionChanged", state: "denied", previous: "prompt" },
    ], "a repeated state is not a change; granted to prompt is the revocation");
    assert.deepEqual(await ask({ operation: "unwatchPermission" }), { kind: "Unwatched" });
    status.set("granted");
    assert.equal(facts.length, 3);
    browser.permission = undefined;
    assert.deepEqual(await ask({ operation: "watchPermission" }), { kind: "CannotWatch" });
    assert.deepEqual(await ask({ operation: "permission" }), { kind: "Permission" }, "no state rather than a guessed one");
    assert.equal(await permissionStateOf(document, "geolocation"), undefined);
  });
});

// --- credentials ------------------------------------------------------------

const bytes = (...values: number[]): ArrayBuffer => new Uint8Array(values).buffer;

type Seen = { readonly created: CredentialCreationOptions[]; readonly got: CredentialRequestOptions[] };

const fakeCredentials = (seen: Seen, answer: { readonly error?: string }) => ({
  create: async (options: CredentialCreationOptions) => {
    seen.created.push(options);
    if (answer.error !== undefined) throw Object.assign(new Error("refused"), { name: answer.error });
    return { rawId: bytes(1, 2, 3), authenticatorAttachment: "platform", response: { clientDataJSON: bytes(4), attestationObject: bytes(5, 6), getTransports: () => ["internal"] } };
  },
  get: async (options: CredentialRequestOptions) => {
    seen.got.push(options);
    if (answer.error !== undefined) throw Object.assign(new Error("refused"), { name: answer.error });
    return { rawId: bytes(1, 2, 3), response: { clientDataJSON: bytes(7), authenticatorData: bytes(8), signature: bytes(9, 10), userHandle: bytes(11) } };
  },
});

const CREATE: CredentialsRequest = {
  operation: "create", challenge: toBase64Url(bytes(0xfb, 0xff, 0x01)), relyingParty: { name: "Limen" }, user: { id: toBase64Url(bytes(42)), name: "ada", displayName: "Ada" },
  algorithms: [-7, -257], residentKey: "required", userVerification: "required", excludeCredentials: [], timeoutMs: 5000,
};
const GET: CredentialsRequest = { operation: "get", challenge: toBase64Url(bytes(0xfe)), allowCredentials: [toBase64Url(bytes(1, 2, 3))], userVerification: "preferred", timeoutMs: 5000 };

const withCredentials = async (browserState: Partial<Browser>, answer: { readonly error?: string }, act: (ask: (request: CredentialsRequest) => Promise<CredentialsResult>, seen: Seen) => Promise<void>): Promise<void> => {
  await withDom("<p></p>", async (document) => {
    const window = document.defaultView ?? assert.fail("window");
    const seen: Seen = { created: [], got: [] };
    const browser: Browser = { queries: [], located: [], activation: true, ...browserState };
    install(window, browser, { credentials: fakeCredentials(seen, answer), publicKeyCredential: Object.assign(function PublicKeyCredential() {}, { isUserVerifyingPlatformAuthenticatorAvailable: async () => true, isConditionalMediationAvailable: async () => false }) });
    await act(creds(document), seen);
  });
};

test("base64url: round trips, no padding, and anything else is refused", () => {
  const all = bytes(...Array.from({ length: 256 }, (_, index) => index));
  assert.deepEqual([...(fromBase64Url(toBase64Url(all)) ?? [])], [...new Uint8Array(all)]);
  assert.equal(toBase64Url(bytes(0xfb, 0xff)), "-_8");
  assert.equal(fromBase64Url("a+b/"), undefined);
  assert.equal(fromBase64Url("abc="), undefined);
});

test("credentials: create and get carry the server's challenge in and the authenticator's answer out, verifying nothing", async () => {
  await withCredentials({}, {}, async (ask, seen) => {
    assert.deepEqual(await ask({ operation: "availability" }), { kind: "Available", platformAuthenticator: true, conditionalMediation: false });
    assert.deepEqual(await ask(CREATE), { kind: "Created", credentialId: "AQID", clientDataJSON: "BA", attestationObject: "BQY", transports: ["internal"], authenticatorAttachment: "platform" });
    const publicKey = seen.created[0]?.publicKey;
    assert.deepEqual([...new Uint8Array(publicKey?.challenge as ArrayBuffer)], [0xfb, 0xff, 0x01], "the challenge's bytes, decoded from base64url");
    assert.deepEqual(publicKey?.pubKeyCredParams, [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }]);
    assert.equal(publicKey?.rp.id, undefined, "absent: the page's own domain");
    assert.deepEqual(await ask(GET), { kind: "Asserted", credentialId: "AQID", clientDataJSON: "Bw", authenticatorData: "CA", signature: "CQo", userHandle: "Cw" });
    assert.deepEqual([...new Uint8Array(seen.got[0]?.publicKey?.allowCredentials?.[0]?.id as ArrayBuffer)], [1, 2, 3]);
  });
});

test("credentials: without a user gesture, create and get are NeedsGesture and the browser is never asked", async () => {
  await withCredentials({ activation: false }, {}, async (ask, seen) => {
    assert.deepEqual(await ask(CREATE), { kind: "NeedsGesture" });
    assert.deepEqual(await ask(GET), { kind: "NeedsGesture" });
    assert.deepEqual([seen.created.length, seen.got.length], [0, 0]);
    assert.equal((await ask({ operation: "availability" })).kind, "Available", "reading availability needs no gesture");
  });
});

test("credentials: the browser's refusals stay distinct from unavailability and from each other", async () => {
  const refusals = await ["NotAllowedError", "InvalidStateError", "SecurityError", "NotSupportedError"].reduce<Promise<readonly string[]>>(async (done, error) => {
    const previous = await done;
    const found: string[] = [];
    await withCredentials({}, { error }, async (ask) => { found.push((await ask(CREATE)).kind); });
    return [...previous, ...found];
  }, Promise.resolve([]));
  assert.deepEqual(refusals, ["NotAllowed", "AlreadyRegistered", "InvalidRelyingParty", "NotSupported"]);
  await withCredentials({ secure: false }, {}, async (ask, seen) => {
    assert.deepEqual(await ask(CREATE), { kind: "Unavailable", reason: "insecureContext" });
    assert.equal(seen.created.length, 0);
  });
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await creds(document)({ operation: "availability" }), { kind: "Unavailable", reason: document.defaultView?.isSecureContext === true ? "notSupported" : "insecureContext" });
  });
});

test("credentials: a field that is not base64url is InvalidRequest, naming the field, and nothing is shown", async () => {
  await withCredentials({}, {}, async (ask, seen) => {
    assert.deepEqual(await ask({ ...CREATE, challenge: "not base64url!" }), { kind: "InvalidRequest", problem: "challenge is not base64url" });
    assert.deepEqual(await ask({ ...GET, allowCredentials: ["AQID", "a+b"] }), { kind: "InvalidRequest", problem: "allowCredentials[1] is not base64url" });
    assert.deepEqual([seen.created.length, seen.got.length], [0, 0]);
  });
});

test("both packs pass the shared provider conformance suite", async () => {
  await withDom("<p></p>", async (document) => {
    assert.deepEqual(await runProviderConformance(geolocationCapability(), {
      document, decodeResult: decodeGeolocationResult,
      valid: [{ name: "permission", payload: { operation: "permission" } }],
      malformed: [{ name: "locate without options", payload: { operation: "locate" } }, { name: "watchPosition", payload: { operation: "watchPosition" } }],
      cancellable: { name: "permission", payload: { operation: "permission" } },
    }), []);
    assert.deepEqual(await runProviderConformance(credentialsCapability(), {
      document, decodeResult: decodeCredentialsResult,
      valid: [{ name: "availability", payload: { operation: "availability" } }],
      malformed: [{ name: "create without a challenge", payload: { ...CREATE, challenge: undefined } }, { name: "an unknown requirement", payload: { ...GET, userVerification: "always" } }],
      cancellable: { name: "availability", payload: { operation: "availability" } },
    }), []);
  });
});
