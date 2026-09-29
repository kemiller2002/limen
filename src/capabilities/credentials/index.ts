// Browser-secured credentials — WebAuthn passkeys — under the permission
// pattern (kemiller2002/limen#42, LCP-036): the identity and security
// reference.
//
// The pack is a courier. It hands the authenticator a challenge the engine's
// server issued, and hands the authenticator's answer back, every byte as
// base64url. It verifies nothing: attestation, signatures, sign counters,
// which account a credential belongs to and what it authorizes are the
// engine's and its server's. A browser that lets a ceremony finish has not
// authenticated anyone until the server says so.
//
// create and get need transient user activation on every browser: the most
// restrictive browsers require it, so requiring it everywhere keeps behaviour
// the same. Without it the answer is NeedsGesture and nothing is shown.
// Unavailable (no WebAuthn, or not a secure context), NeedsGesture and the
// browser's own refusal (NotAllowed) are distinct outcomes.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { hasUserActivation, presenceOf, type Absence } from "../../capability-support/permissions.js";
import { CAPABILITY_OFFER, type CredentialsRequest, type CredentialsResult, type UnavailableReason } from "./generated/credentials.js";
import { decodeCredentialsRequest } from "./generated/credentials.codec.js";

export { CAPABILITY_OFFER as CREDENTIALS_CAPABILITY } from "./generated/credentials.js";
export type { CredentialsRequest, CredentialsResult, Requirement, UnavailableReason } from "./generated/credentials.js";
export { decodeCredentialsRequest, decodeCredentialsResult } from "./generated/credentials.codec.js";

const reasonOf = (absence: Absence): UnavailableReason => {
  switch (absence) {
    case "no-secure-context": return "insecureContext";
    case "no-api": return "notSupported";
    case "policy-blocks": return "blockedByPolicy";
  }
};

// base64url, without padding, as WebAuthn servers expect.
export const toBase64Url = (bytes: ArrayBuffer): string =>
  btoa(Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

export const fromBase64Url = (text: string): Uint8Array<ArrayBuffer> | undefined => {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return undefined;
  try {
    const padded = text.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
  } catch {
    return undefined;
  }
};

// Every base64url field decoded, or the first that is not.
const decodeAll = (fields: Readonly<Record<string, string>>): { readonly ok: true; readonly bytes: Readonly<Record<string, Uint8Array<ArrayBuffer>>> } | { readonly ok: false; readonly field: string } => {
  const decoded = Object.entries(fields).map(([name, text]) => [name, fromBase64Url(text)] as const);
  const bad = decoded.find(([, bytes]) => bytes === undefined);
  return bad !== undefined ? { ok: false, field: bad[0] } : { ok: true, bytes: Object.fromEntries(decoded.flatMap(([name, bytes]) => (bytes === undefined ? [] : [[name, bytes]]))) };
};

const nameOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "Error";

// The browser's refusal, by DOMException name. NotAllowedError deliberately
// conflates cancel, timeout, no matching credential and failed verification.
const refusalOf = (error: unknown, aborted: boolean): CredentialsResult => {
  if (aborted) return { kind: "Cancelled" };
  const name = nameOf(error);
  switch (name) {
    case "NotAllowedError": return { kind: "NotAllowed" };
    case "InvalidStateError": return { kind: "AlreadyRegistered" };
    case "SecurityError": return { kind: "InvalidRelyingParty" };
    case "NotSupportedError": return { kind: "NotSupported", problem: name };
    case "AbortError": return { kind: "Cancelled" };
    default: return { kind: "NotSupported", problem: name };
  }
};

const publicKeyOf = (credential: Credential | null): PublicKeyCredential | undefined =>
  credential !== null && "rawId" in credential && "response" in credential ? (credential as PublicKeyCredential) : undefined;

// Structural, so a scripted authenticator in a test is judged the same way.
const attestation = (response: AuthenticatorResponse): response is AuthenticatorAttestationResponse => "attestationObject" in response;
const assertion = (response: AuthenticatorResponse): response is AuthenticatorAssertionResponse => "signature" in response && "authenticatorData" in response;

const staticMethod = async (view: Window, name: string): Promise<boolean> => {
  const constructor: unknown = Reflect.get(view, "PublicKeyCredential");
  const method: unknown = typeof constructor === "function" ? Reflect.get(constructor, name) : undefined;
  return typeof method === "function" ? (await Reflect.apply(method, constructor, [])) === true : false;
};

const create = async (container: CredentialsContainer, request: Extract<CredentialsRequest, { operation: "create" }>, signal: AbortSignal): Promise<CredentialsResult> => {
  const decoded = decodeAll({ challenge: request.challenge, userId: request.user.id, ...Object.fromEntries(request.excludeCredentials.map((id, index) => [`excludeCredentials[${index}]`, id])) });
  if (!decoded.ok) return { kind: "InvalidRequest", problem: `${decoded.field} is not base64url` };
  const { challenge, userId } = decoded.bytes;
  if (challenge === undefined || userId === undefined) return { kind: "InvalidRequest", problem: "missing bytes" };
  try {
    const credential = publicKeyOf(await container.create({
      signal,
      publicKey: {
        challenge,
        rp: { name: request.relyingParty.name, ...(request.relyingParty.id !== undefined ? { id: request.relyingParty.id } : {}) },
        user: { id: userId, name: request.user.name, displayName: request.user.displayName },
        pubKeyCredParams: request.algorithms.map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { residentKey: request.residentKey, requireResidentKey: request.residentKey === "required", userVerification: request.userVerification },
        excludeCredentials: request.excludeCredentials.map((_, index) => ({ type: "public-key", id: decoded.bytes[`excludeCredentials[${index}]`] ?? new Uint8Array() })),
        timeout: request.timeoutMs,
      },
    }));
    if (credential === undefined || !attestation(credential.response)) return { kind: "NotAllowed" };
    const attachment = credential.authenticatorAttachment;
    return {
      kind: "Created",
      credentialId: toBase64Url(credential.rawId),
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      attestationObject: toBase64Url(credential.response.attestationObject),
      transports: typeof credential.response.getTransports === "function" ? credential.response.getTransports() : [],
      ...(attachment !== null && attachment !== undefined ? { authenticatorAttachment: attachment } : {}),
    };
  } catch (error) {
    return refusalOf(error, signal.aborted);
  }
};

const get = async (container: CredentialsContainer, request: Extract<CredentialsRequest, { operation: "get" }>, signal: AbortSignal): Promise<CredentialsResult> => {
  const decoded = decodeAll({ challenge: request.challenge, ...Object.fromEntries(request.allowCredentials.map((id, index) => [`allowCredentials[${index}]`, id])) });
  if (!decoded.ok) return { kind: "InvalidRequest", problem: `${decoded.field} is not base64url` };
  const { challenge } = decoded.bytes;
  if (challenge === undefined) return { kind: "InvalidRequest", problem: "missing bytes" };
  try {
    const credential = publicKeyOf(await container.get({
      signal,
      publicKey: {
        challenge,
        ...(request.relyingPartyId !== undefined ? { rpId: request.relyingPartyId } : {}),
        allowCredentials: request.allowCredentials.map((_, index) => ({ type: "public-key", id: decoded.bytes[`allowCredentials[${index}]`] ?? new Uint8Array() })),
        userVerification: request.userVerification,
        timeout: request.timeoutMs,
      },
    }));
    if (credential === undefined || !assertion(credential.response)) return { kind: "NotAllowed" };
    const userHandle = credential.response.userHandle;
    return {
      kind: "Asserted",
      credentialId: toBase64Url(credential.rawId),
      clientDataJSON: toBase64Url(credential.response.clientDataJSON),
      authenticatorData: toBase64Url(credential.response.authenticatorData),
      signature: toBase64Url(credential.response.signature),
      ...(userHandle !== null ? { userHandle: toBase64Url(userHandle) } : {}),
    };
  } catch (error) {
    return refusalOf(error, signal.aborted);
  }
};

export const credentialsCapability = (): CapabilityProvider => {
  const execute = async (request: CredentialsRequest, context: CapabilityRequestContext): Promise<CredentialsResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const { document } = context;
    const view = document.defaultView;
    const container = view?.navigator.credentials;
    const presence = presenceOf(document, { present: view !== null && container !== undefined && "PublicKeyCredential" in view, policyFeature: "publickey-credentials-get", secureContextRequired: true });
    if (presence.kind === "absent" || view === null || container === undefined) return { kind: "Unavailable", reason: presence.kind === "absent" ? reasonOf(presence.because) : "notSupported" };
    switch (request.operation) {
      case "availability": {
        const [platformAuthenticator, conditionalMediation] = await Promise.all([staticMethod(view, "isUserVerifyingPlatformAuthenticatorAvailable"), staticMethod(view, "isConditionalMediationAvailable")]);
        return { kind: "Available", platformAuthenticator, conditionalMediation };
      }
      case "create":
        return hasUserActivation(document) ? create(container, request, context.signal) : { kind: "NeedsGesture" };
      case "get":
        return hasUserActivation(document) ? get(container, request, context.signal) : { kind: "NeedsGesture" };
    }
  };

  return defineCapability<CredentialsRequest, CredentialsResult>({ offer: CAPABILITY_OFFER, decodeRequest: decodeCredentialsRequest, execute });
};
