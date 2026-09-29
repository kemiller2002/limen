# Camera, microphone and recording

> **Optional — not Limen Core.** This is the media pack, a capability pack. It composes with the Core concept `typed-capabilities`: capture and recording are requested through the generic Capability seam, and every outcome is typed. Nothing here is required to use Limen; the mandatory model is the seven concepts in [the Core mental model](https://github.com/kemiller2002/limen/blob/main/docs/core-mental-model.md).

Camera and microphone capture, previews and recordings, without a
`MediaStream`, a track, a recorder or a `Blob` ever crossing the boundary
(kemiller2002/limen#44, LCP-038). It follows the permission pattern of
[docs/51](https://github.com/kemiller2002/limen/blob/main/docs/51-permission-sensitive-capabilities.md).

```ts
import { mediaCapability } from "@echelon-foundry/typescript-wasm-kernel/capabilities/media";

const media = mediaCapability();
await new BrowserKernel(transport, document, diagnostics, { capabilities: [media] }).start();
// at teardown, if the page outlives the kernel:
media.dispose();
```

The contract is
[`contract/media.contract.json`](https://github.com/kemiller2002/limen/blob/main/contract/media.contract.json).
It is generated for TypeScript, F#, C# and Rust.

## Three things kept apart

| Question | Answer |
| --- | --- |
| Can this browser capture at all? | `Unavailable { reason }`: `notSupported`, `insecureContext` or `blockedByPolicy`. Never a denial. |
| What has the user allowed? | `permission`, `watchPermission` and `PermissionChanged` facts, per device (`camera`, `microphone`). A revocation is a fact. Reading the state never prompts. |
| What did this capture produce? | `Capturing`, `Denied`, `DeviceUnavailable { notFound \| inUse \| overconstrained }`, `Cancelled`, or `Failed { reason }` with the browser's error name. |

Nothing is asked at initialization. Only `startCapture` can make the browser
prompt, and only when the engine sends it. A granted permission is evidence,
never application authorization.

## Captures are ids

`startCapture { audio, video, audioDevice?, videoDevice? }` answers with an opaque
`CaptureId` and a description of the tracks: kind, label and, for video, width
and height.

The engine never holds the stream. To show it, the HTML names a `<video>`:

```html
<video data-media-preview="self" playsinline></video>
<li data-media-key="…"><video data-media-preview="tile"></video></li>
```

`preview { capture, target: { name, key? } }` puts the capture in that element,
muted. A missing element, several matches or a non-`<video>` element is an
answer (`NotFound`, `Ambiguous`, `WrongElement`), never a guess.

## Recording

- `record { capture, mimeType? }` starts a recording. A type this browser
  cannot record is `NotRecordable`.
- `finish` stops it and answers `Recorded { bytes, mimeType, durationMs }` once
  every byte has arrived.
- `read { recording, offset, length }` returns base64 in slices of at most
  `MAX_READ_BYTES` (1 MiB). Reading an unfinished recording is `StillRecording`.
- `release` discards the recording, stopping it first if it is still running.

To upload a recording, the engine reads it and sends it with Http. The pack
never uploads anything.

## Everything ends

| Resource | Ends when |
| --- | --- |
| a capture | `stop`, which stops every track, ends its recordings and clears its previews. Its id is then `Stale`. |
| a capture the engine cancelled | its request is cancelled. The capture is stopped the moment the browser delivers it, and is never reported. |
| a track the browser ends (device unplugged, access revoked) | `TrackEnded`, then `CaptureEnded` once no track is left. An ended capture cannot be previewed or recorded (`CaptureEnded`). |
| a recording | `finish`, then `release`. If its capture ends first, it becomes `RecordingInterrupted`, and `finish` still answers with what was recorded. |
| everything | `dispose()` at the host's teardown: every capture and recording this provider still owns. |

Session policy stays in the engine: who is on a call, whether recording is
allowed, what a recording is for.

## Verified

- **jsdom, `test/media.test.ts`, 14 tests:** every outcome and fact, stop,
  cancellation of a pending capture, browser-ended tracks, the recording
  lifecycle and bounds, dispose, and the shared provider conformance suite.
- **Chromium, `npm run smoke:packs`, page `media`, 11 checks under strict CSP
  and Trusted Types.** It uses the browser's fake camera and microphone.
  - Before a grant, capture is `Denied`.
  - After a grant, the devices are listed with labels.
  - A missing device is `DeviceUnavailable`.
  - The preview plays the fake camera.
  - One second of recording reads back with a WebM header.
  - `stop` and `dispose()` end everything.
  - Each permission change, including the revocation, is a fact.

Measured along the way:

- Chromium's headless shell rejects `getUserMedia` with `NotSupportedError`,
  so the page runs in full Chromium.
- With prompts answered as denials, a refused prompt persists as `denied`,
  and a cleared grant reads `denied`, not `prompt`.

## Peer connections

Sending a capture to a peer is the [peer connection pack](56-peer-connections.md).
The application hands it this pack's captures explicitly
(`peerCapability({ captures: media })`), using `streamFor`. A peer connection
is not the same resource as a capture, and packs never import each other.

## Size

The `kernel-with-media` profile in `bench/budgets.json` adds 11.8 KB gzip over
the kernel. It is loaded only by applications that register this pack.
