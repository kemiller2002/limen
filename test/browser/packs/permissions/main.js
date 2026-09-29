// The permission pattern in Chromium (kemiller2002/limen#42): a location that
// is prompted for (and dismissed), granted, revoked; passkeys on a virtual
// authenticator, refused without a gesture, created and asserted after a real
// click, and the browser's refusals kept distinct. The runner polls without a
// user gesture, so "no gesture" here means none.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { geolocationCapability, GEOLOCATION_CAPABILITY, decodeGeolocationResult, decodeGeolocationFact } from "../../../../dist/capabilities/geolocation/index.js";
import { credentialsCapability, CREDENTIALS_CAPABILITY, decodeCredentialsResult, fromBase64Url, toBase64Url } from "../../../../dist/capabilities/credentials/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = (capability) => ({ id: capability.id, version: capability.version, fingerprint: capability.fingerprint });
const GEO = offer(GEOLOCATION_CAPABILITY);
const CREDS = offer(CREDENTIALS_CAPABILITY);
const bridge = { queued: [], waiting: new Map(), facts: [], sequence: 0 };
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Initialize") return { view: {}, effects: [], cancellations: [], handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [GEO, CREDS] } };
    if (message.kind === "CapabilityFact") { const decoded = decodeGeolocationFact(message.fact); bridge.facts.push(decoded.ok ? decoded.value : { kind: "Undecodable" }); }
    if (message.kind === "EffectResult") bridge.waiting.get(message.result.correlationId)?.(message.result);
    const effects = bridge.queued;
    bridge.queued = [];
    return { view: {}, effects, cancellations: [] };
  },
};
const act = (action) => new Promise((resolve) => { window.__limenPackActionDone = resolve; window.__limenPackAction = action; });
// withGesture: the runner performs a real click on the page's button, so the
// request runs inside the user activation that click grants.
const ask = async (target, request, withGesture = false) => {
  bridge.sequence += 1;
  const effect = { kind: "Capability", correlationId: `p-${bridge.sequence}`, capability: target.id, version: 1, request };
  const answered = new Promise((resolve) => bridge.waiting.set(effect.correlationId, resolve));
  bridge.queued = [effect];
  if (withGesture) await act({ kind: "click", selector: "#poke" });
  else document.getElementById("poke").click();
  const result = await answered;
  const decoded = result.outcome.kind === "Completed" ? (target === GEO ? decodeGeolocationResult : decodeCredentialsResult)(result.outcome.result) : { ok: false };
  return decoded.ok ? decoded.value : { kind: "Undecodable", result };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });
const LOCATE = { operation: "locate", highAccuracy: false, timeoutMs: 3000, maximumAgeMs: 0 };

await new BrowserKernel(engine, document, undefined, { capabilities: [geolocationCapability(), credentialsCapability()], requireHandshake: true }).start();

// --- geolocation ------------------------------------------------------------
const initial = await ask(GEO, { operation: "permission" });
const watching = await ask(GEO, { operation: "watchPermission" });
expect("registering the packs asked for nothing: the location permission is still prompt, read without prompting", initial.kind === "Permission" && initial.state === "prompt" && watching.kind === "Watching" && watching.state === "prompt", { initial, watching });
const dismissed = await ask(GEO, LOCATE);
const afterDismiss = await ask(GEO, { operation: "permission" });
expect("a dismissed prompt is Denied for that request, and not a lasting denial: the state stays prompt", dismissed.kind === "Denied" && afterDismiss.state === "prompt", { dismissed, afterDismiss });

await act({ kind: "grantPermissions", permissions: ["geolocation"] });
await act({ kind: "setGeolocation", latitude: 51.5007, longitude: -0.1246, accuracy: 25 });
await settle();
const located = await ask(GEO, LOCATE);
expect("granted: the device's real position through the pack", located.kind === "Located" && located.position.latitude === 51.5007 && located.position.longitude === -0.1246 && located.position.accuracyM === 25, located);

await act({ kind: "clearPermissions" });
await settle();
const revokedLocate = await ask(GEO, LOCATE);
expect("revoked: PermissionChanged granted then prompt, as facts, and the next request is Denied",
  JSON.stringify(bridge.facts) === JSON.stringify([{ kind: "PermissionChanged", state: "granted", previous: "prompt" }, { kind: "PermissionChanged", state: "prompt", previous: "granted" }]) && revokedLocate.kind === "Denied",
  { facts: bridge.facts, revokedLocate });
await ask(GEO, { operation: "unwatchPermission" });

// --- credentials --------------------------------------------------------------
const challenge = toBase64Url(crypto.getRandomValues(new Uint8Array(32)).buffer);
const userId = toBase64Url(new TextEncoder().encode("user-7").buffer);
const create = (overrides = {}) => ({ operation: "create", challenge, relyingParty: { name: "Limen" }, user: { id: userId, name: "ada@example.test", displayName: "Ada" }, algorithms: [-7, -257], residentKey: "required", userVerification: "required", excludeCredentials: [], timeoutMs: 5000, ...overrides });

const before = await ask(CREDS, { operation: "availability" });
const noGesture = await ask(CREDS, create());
expect("without a user gesture, create is NeedsGesture and nothing is shown", noGesture.kind === "NeedsGesture" && before.kind === "Available", { before, noGesture });

await act({ kind: "authenticator", userVerified: true });
const available = await ask(CREDS, { operation: "availability" });
expect("with a platform authenticator present, availability says so", available.kind === "Available" && available.platformAuthenticator === true, available);

const created = await ask(CREDS, create(), true);
const clientData = created.kind === "Created" ? JSON.parse(new TextDecoder().decode(fromBase64Url(created.clientDataJSON))) : {};
expect("after a real click, create carries the server's challenge to the authenticator and a passkey back, unverified by the pack",
  created.kind === "Created" && created.credentialId.length > 0 && created.attestationObject.length > 0 && clientData.type === "webauthn.create" && clientData.challenge === challenge && clientData.origin === location.origin,
  { created, clientData });

const asserted = await ask(CREDS, { operation: "get", challenge, allowCredentials: [created.credentialId], userVerification: "required", timeoutMs: 5000 }, true);
expect("after a real click, get returns an assertion for that credential, with the user handle the engine registered",
  asserted.kind === "Asserted" && asserted.credentialId === created.credentialId && asserted.userHandle === userId && asserted.signature.length > 0,
  asserted);

const again = await ask(CREDS, create({ excludeCredentials: [created.credentialId] }), true);
expect("registering again on an authenticator that holds an excluded credential is AlreadyRegistered", again.kind === "AlreadyRegistered", again);

const foreign = await ask(CREDS, create({ relyingParty: { id: "example.com", name: "Elsewhere" } }), true);
expect("a relying party id that is not this origin's is InvalidRelyingParty", foreign.kind === "InvalidRelyingParty", foreign);

await act({ kind: "authenticator", userVerified: false });
const unverified = await ask(CREDS, { operation: "get", challenge, allowCredentials: [created.credentialId], userVerification: "required", timeoutMs: 3000 }, true);
expect("when the authenticator cannot verify the user, get is NotAllowed: refused, not unavailable", unverified.kind === "NotAllowed", unverified);

window.__limenPackResult = { pack: "permissions", checks };
