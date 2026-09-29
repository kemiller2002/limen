// The shared pattern for permission-sensitive capability packs
// (kemiller2002/limen#42, LCP-036): geolocation, credentials, and every later
// device or security pack answer the same three questions the same way.
//
//   Is the API here at all?     presence: present, or absent because of a
//                               condition (not supported, insecure context,
//                               blocked by the page's permissions policy).
//                               Never reported as a denial.
//   What has the user allowed?  permission state: granted, denied or prompt,
//                               read from the Permissions API where the
//                               browser has one; changes arrive as facts, so
//                               a revocation is visible.
//   Is there a user gesture?    transient user activation, for operations the
//                               browser (or the most restrictive browser)
//                               allows only right after one.
//
// A browser permission is evidence, never application authorization: what a
// granted permission lets this user do is the engine's decision. Nothing here
// asks for a permission; only an operation the engine requested does.

// Permission states are the browser's own (the DOM's PermissionState). What
// the browser lacks is reported as a condition; each pack maps it onto its
// generated UnavailableReason, so no wire shape is declared here.
export type Absence = "no-secure-context" | "no-api" | "policy-blocks";
export type Presence = { readonly kind: "present" } | { readonly kind: "absent"; readonly because: Absence };

// The Permissions Policy feature list, where the browser exposes it; absent,
// nothing is known to be blocked.
const policyAllows = (document: Document, feature: string): boolean => {
  const policy: unknown = Reflect.get(document, "permissionsPolicy") ?? Reflect.get(document, "featurePolicy");
  const allows: unknown = typeof policy === "object" && policy !== null ? Reflect.get(policy, "allowsFeature") : undefined;
  return typeof allows === "function" ? Reflect.apply(allows, policy, [feature]) !== false : true;
};

// present: whether the API object exists on this browser.
export const presenceOf = (document: Document, options: { readonly present: boolean; readonly policyFeature?: string; readonly secureContextRequired: boolean }): Presence => {
  const view = document.defaultView;
  if (options.secureContextRequired && view?.isSecureContext !== true) return { kind: "absent", because: "no-secure-context" };
  if (!options.present) return { kind: "absent", because: "no-api" };
  if (options.policyFeature !== undefined && !policyAllows(document, options.policyFeature)) return { kind: "absent", because: "policy-blocks" };
  return { kind: "present" };
};

const stateOf = (value: unknown): PermissionState | undefined => (value === "granted" || value === "denied" || value === "prompt" ? value : undefined);

type StatusLike = EventTarget & { readonly state: unknown };

const statusFor = async (document: Document, name: string): Promise<StatusLike | undefined> => {
  const permissions = document.defaultView?.navigator.permissions;
  if (permissions === undefined || typeof permissions.query !== "function") return undefined;
  try {
    // A name the browser does not know rejects with TypeError.
    return await permissions.query({ name: name as PermissionName });
  } catch {
    return undefined;
  }
};

// undefined: this browser cannot say (no Permissions API, or it does not know
// the permission). Then an operation's own outcome is the only evidence.
export const permissionStateOf = async (document: Document, name: string): Promise<PermissionState | undefined> =>
  stateOf((await statusFor(document, name))?.state);

// Calls onChange with the new and previous state whenever the user or the
// browser changes the permission; returns the unsubscribe, or undefined if
// this browser cannot report changes.
export const watchPermission = async (
  document: Document,
  name: string,
  onChange: (state: PermissionState, previous: PermissionState) => void,
): Promise<(() => void) | undefined> => {
  const status = await statusFor(document, name);
  const initial = stateOf(status?.state);
  if (status === undefined || initial === undefined) return undefined;
  const last = { state: initial };
  const listener = (): void => {
    const next = stateOf(status.state);
    if (next === undefined || next === last.state) return;
    const previous = last.state;
    last.state = next;
    onChange(next, previous);
  };
  status.addEventListener("change", listener);
  return () => status.removeEventListener("change", listener);
};

// Transient user activation: true for a few seconds after a real click, key
// press or touch. A browser without the UserActivation API is assumed active,
// so the browser's own refusal remains the evidence there.
export const hasUserActivation = (document: Document): boolean => {
  const activation: unknown = document.defaultView?.navigator === undefined ? undefined : Reflect.get(document.defaultView.navigator, "userActivation");
  const active: unknown = typeof activation === "object" && activation !== null ? Reflect.get(activation, "isActive") : undefined;
  return typeof active === "boolean" ? active : true;
};
