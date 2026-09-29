// The device's location under the permission pattern (kemiller2002/limen#42,
// LCP-036): the device-facing reference for every permission-sensitive pack.
//
// Three things are kept apart, as capability-support/permissions.ts defines:
// whether the API is here (Unavailable, with a reason, never a denial), what
// the user allowed (the permission state, and PermissionChanged facts, so a
// revocation is visible), and what one request produced (Located, Denied,
// PositionUnavailable, TimedOut). Nothing is asked at initialization: only
// locate can make the browser prompt, and only when the engine sends it.
//
// A granted permission is evidence, never application authorization: what a
// location lets this user do is the engine's decision.
//
// Optional: nothing in Core imports this module.

import { defineCapability, type CapabilityHost, type CapabilityProvider, type CapabilityRequestContext } from "../../kernel/capabilities.js";
import { presenceOf, permissionStateOf, watchPermission, type Absence } from "../../capability-support/permissions.js";
import { CAPABILITY_OFFER, type GeolocationFact, type GeolocationRequest, type GeolocationResult, type Position, type UnavailableReason } from "./generated/geolocation.js";
import { decodeGeolocationRequest } from "./generated/geolocation.codec.js";

export { CAPABILITY_OFFER as GEOLOCATION_CAPABILITY } from "./generated/geolocation.js";
export type { GeolocationFact, GeolocationRequest, GeolocationResult, PermissionState, Position, UnavailableReason } from "./generated/geolocation.js";
export { decodeGeolocationFact, decodeGeolocationRequest, decodeGeolocationResult } from "./generated/geolocation.codec.js";

const reasonOf = (absence: Absence): UnavailableReason => {
  switch (absence) {
    case "no-secure-context": return "insecureContext";
    case "no-api": return "notSupported";
    case "policy-blocks": return "blockedByPolicy";
  }
};

const positionOf = (position: GeolocationPosition): Position => {
  const { coords } = position;
  return {
    latitude: coords.latitude,
    longitude: coords.longitude,
    accuracyM: coords.accuracy,
    ...(coords.altitude !== null ? { altitudeM: coords.altitude } : {}),
    ...(coords.heading !== null && !Number.isNaN(coords.heading) ? { headingDeg: coords.heading } : {}),
    ...(coords.speed !== null ? { speedMps: coords.speed } : {}),
    timestampMs: position.timestamp,
  };
};

// GeolocationPositionError codes: 1 permission denied, 2 position
// unavailable, 3 timeout.
const failureOf = (code: number): GeolocationResult => {
  switch (code) {
    case 1: return { kind: "Denied" };
    case 3: return { kind: "TimedOut" };
    default: return { kind: "PositionUnavailable" };
  }
};

const locate = (geolocation: Geolocation, request: { readonly highAccuracy: boolean; readonly timeoutMs: number; readonly maximumAgeMs: number }, signal: AbortSignal): Promise<GeolocationResult> =>
  new Promise((resolve) => {
    // The browser has no way to abandon a position request; a cancellation
    // answers now and ignores whatever arrives later.
    const onAbort = (): void => resolve({ kind: "Cancelled" });
    signal.addEventListener("abort", onAbort, { once: true });
    geolocation.getCurrentPosition(
      (position) => { signal.removeEventListener("abort", onAbort); resolve({ kind: "Located", position: positionOf(position) }); },
      (error) => { signal.removeEventListener("abort", onAbort); resolve(failureOf(error.code)); },
      { enableHighAccuracy: request.highAccuracy, timeout: request.timeoutMs, maximumAge: request.maximumAgeMs },
    );
  });

export const geolocationCapability = (): CapabilityProvider => {
  const wiring: { host?: CapabilityHost<GeolocationFact>; stop?: (() => void) | undefined } = {};

  const execute = async (request: GeolocationRequest, context: CapabilityRequestContext): Promise<GeolocationResult> => {
    if (context.signal.aborted) return { kind: "Cancelled" };
    const { document } = context;
    const geolocation = document.defaultView?.navigator.geolocation;
    const presence = presenceOf(document, { present: geolocation !== undefined, policyFeature: "geolocation", secureContextRequired: true });
    if (presence.kind === "absent") return { kind: "Unavailable", reason: reasonOf(presence.because) };
    switch (request.operation) {
      case "permission": {
        const state = await permissionStateOf(document, "geolocation");
        return { kind: "Permission", ...(state !== undefined ? { state } : {}) };
      }
      case "watchPermission": {
        wiring.stop?.();
        wiring.stop = await watchPermission(document, "geolocation", (state, previous) => wiring.host?.emitFact({ kind: "PermissionChanged", state, previous }));
        const state = await permissionStateOf(document, "geolocation");
        return wiring.stop === undefined || state === undefined ? { kind: "CannotWatch" } : { kind: "Watching", state };
      }
      case "unwatchPermission":
        wiring.stop?.();
        wiring.stop = undefined;
        return { kind: "Unwatched" };
      case "locate":
        return geolocation === undefined ? { kind: "Unavailable", reason: "notSupported" } : locate(geolocation, request, context.signal);
    }
  };

  return defineCapability<GeolocationRequest, GeolocationResult, GeolocationFact>({ offer: CAPABILITY_OFFER, decodeRequest: decodeGeolocationRequest, execute, activate: (host) => { wiring.host = host; } });
};
