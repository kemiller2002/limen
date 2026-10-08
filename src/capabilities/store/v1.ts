// limen.store version 1, exactly as Limen 0.7.x shipped it.
//
// An engine built against 0.7.x selects this offer in its handshake, and the
// kernel accepts only an identical id, version and fingerprint. A host that
// registers storeCapability() with no options therefore keeps offering it,
// with 0.7.x behaviour, so upgrading Limen never refuses an existing engine.
// The fingerprint is SHA-256 of the canonical 0.7.1 contract, frozen at
// contract/frozen/store.v1.contract.json; test/store.test.ts recomputes it.

export const STORE_CAPABILITY_V1 = { id: "limen.store", version: 1, fingerprint: "sha256:0ba8d199066c4ef37ec8a3fd0767bf191644f581b0faa6c545234a1b5f7c4cf6" } as const;
