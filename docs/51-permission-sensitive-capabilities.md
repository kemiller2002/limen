# Permission-sensitive capabilities

> **Optional — not Limen Core.** This is permission-sensitive capabilities, a capability packs. It composes with the Core concept `typed-capabilities`: each is requested through the Capability seam with typed outcomes. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

One pattern for every browser feature that needs a permission, a secure
context or a user gesture (kemiller2002/limen#42, LCP-036). Examples are
location, notifications, camera and microphone, passkeys, sharing, wake lock
and sensors. Without a pattern, each of these would invent its own
architecture.

Two packs prove it:

- a device-facing one, [`./capabilities/geolocation`](../src/capabilities/geolocation/index.ts);
- a security-facing one, [`./capabilities/credentials`](../src/capabilities/credentials/index.ts),
  for WebAuthn passkeys.

Both are optional, and nothing in Core imports them.

## The pattern

Every pack in the family answers three questions the same way, using
[`capability-support/permissions.ts`](../src/capability-support/permissions.ts).

| Question | Answer | Never |
| --- | --- | --- |
| Is the API here at all? | `Unavailable { reason }`, where reason is `notSupported`, `insecureContext` or `blockedByPolicy`. Checked before anything else, and the API is then not called at all. | reported as a denial |
| What has the user allowed? | The permission state (`granted`, `denied` or `prompt`), read from the Permissions API without prompting. `PermissionChanged { state, previous }` facts arrive while watched, so a revocation (`granted` → `prompt` or `denied`) is visible. Where the browser cannot say, the state is absent, not guessed. | asked for at initialization |
| Is there a user gesture? | Operations that need transient user activation answer `NeedsGesture` without it, and nothing is shown. | worked around |

`PermissionState` and `UnavailableReason` are declared in each pack's contract
with identical values, and a test holds the packs to that. So an F#, C# or
Rust engine matches both packs' outcomes the same way.

**A browser permission is evidence, never authorization.** A granted location
tells the engine the browser will share one. Whether this user may use it for
a given purpose is the engine's decision. The same holds for a passkey: a
finished ceremony has authenticated no one until the server verifies it.

**Nothing is requested at initialization.** Registering a pack reads nothing
and asks nothing. Only an operation the engine sends, such as `locate` or
`create`, can make the browser prompt.

## Geolocation

| Request | Answer |
| --- | --- |
| `permission` | `Permission { state? }`, read without prompting |
| `watchPermission` / `unwatchPermission` | `Watching { state }`, then `PermissionChanged` facts; `CannotWatch` where the browser cannot report changes |
| `locate { highAccuracy, timeoutMs, maximumAgeMs }` | `Located { position }`, or one of `Denied`, `PositionUnavailable`, `TimedOut`, `Unavailable { reason }` or `Cancelled` |

## Credentials (WebAuthn passkeys)

| Request | Answer |
| --- | --- |
| `availability` | `Available { platformAuthenticator, conditionalMediation }`, or `Unavailable` |
| `create { challenge, relyingParty, user, algorithms, residentKey, userVerification, excludeCredentials, timeoutMs }` | `Created { credentialId, clientDataJSON, attestationObject, transports, authenticatorAttachment? }` |
| `get { challenge, relyingPartyId?, allowCredentials, userVerification, timeoutMs }` | `Asserted { credentialId, clientDataJSON, authenticatorData, signature, userHandle? }` |

Failures are kept distinct:

| Outcome | Meaning |
| --- | --- |
| `NeedsGesture` | no transient activation; nothing was shown |
| `NotAllowed` | the user cancelled, the ceremony timed out, no credential matched, or verification failed. WebAuthn deliberately does not say which. |
| `AlreadyRegistered` | an excluded credential is already on the authenticator |
| `InvalidRelyingParty` | the relying party id is not valid for this origin |
| `NotSupported { problem }` | no authenticator supports what was asked |
| `InvalidRequest { problem }` | a field that should be base64url is not |
| `Unavailable { reason }` | no WebAuthn, or not a secure context |

Every byte field is base64url without padding, as WebAuthn servers expect.
The pack is a courier: it carries the server's challenge in and the
authenticator's answer out, and verifies nothing. Attestation, signatures,
sign counters, which account a credential belongs to and what it authorizes
belong to the engine and its server.

`create` and `get` need a user gesture **on every browser**. The most
restrictive browsers require one, and requiring it everywhere keeps an
engine's behaviour the same across browsers.

## Adding another pack to the family

1. Declare `PermissionState` and `UnavailableReason` in its contract with the
   same values, and give its result an `Unavailable { reason }` variant.
2. Check `presenceOf` first, then read or watch the permission with
   `permissionStateOf` / `watchPermission`, and gate gesture-bound operations
   on `hasUserActivation`.
3. Map the browser's refusals onto distinct outcomes. Never collapse
   "unavailable" into "denied", or "denied" into "failed".
4. Add it to the convention test in
   [`test/permissions.test.ts`](../test/permissions.test.ts).

Media capture and WebRTC (#44) build on this pattern.

## Proof

- [`test/permissions.test.ts`](../test/permissions.test.ts) (jsdom, scripted
  browser APIs):
  - the shared vocabulary, held against both contracts;
  - three distinct unavailable reasons;
  - activation;
  - no request at initialization;
  - denied, unavailable and timed out as three outcomes;
  - permission changes and revocation, with a repeated state not counted as a
    change;
  - the challenge and answer carried as bytes;
  - `NeedsGesture` without ever calling the browser (a mutation check
    confirmed this test fails if the gesture requirement is removed);
  - each refusal kept distinct;
  - base64url validation;
  - provider conformance for both packs.
- [`test/browser/packs/permissions/`](../test/browser/packs/permissions/main.js)
  (Chromium, on `localhost`, strict CSP) covers location:
  - nothing asked at start;
  - a dismissed prompt is `Denied` for that request, while the state stays
    `prompt`;
  - a granted, real position;
  - a revocation reported as facts, with the next request `Denied`.

  It covers passkeys on a virtual authenticator:
  - `NeedsGesture` without a click;
  - `Created` and then `Asserted` after real clicks, with `clientDataJSON`
    carrying the engine's challenge and origin;
  - `AlreadyRegistered`, `InvalidRelyingParty`, and `NotAllowed` when the
    user is not verified.

Findings from the Chromium work:

- **Playwright's `page.evaluate` grants the page user activation.** Measured:
  `navigator.userActivation.isActive` turns true on every call. The pack smoke
  runner polled with it, so every "needs a gesture" check could pass
  vacuously. The runner now polls through the DevTools protocol with
  `userGesture: false`, so only a performed click or key press activates a
  page.

  This exposed one page that depended on the accident. The overlay page opened
  a popover inside a dialog with no gesture, and Chromium groups overlays
  opened without activation, so one Escape closed both. That page now clicks
  inside the dialog first, as a user would.
- **A WebAuthn relying party cannot be an IP address**, so this page is served
  on `localhost` (`page.json: { "host": "localhost" }`).
- **A dismissed prompt is not a denial.** Chromium answers that request with
  `PERMISSION_DENIED` but leaves the state `prompt`, so the engine can ask
  again later.
