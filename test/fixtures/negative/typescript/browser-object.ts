import { defineCapability } from "../../../../src/kernel/capabilities.js";

type Request = { readonly operation: "pick" };
const decodeRequest = (_value: unknown) => ({ ok: true as const, value: { operation: "pick" as const } });

// The result would carry a live DOM node and a File across the boundary.
export const leaky = defineCapability<Request, { readonly element: Element; readonly file: File }, never>({
  offer: { id: "limen.fixture.leaky", version: 1, fingerprint: "sha256:0" },
  decodeRequest,
  execute: async (_request, { document }) => ({ element: document.body, file: new File([], "x") }),
});
