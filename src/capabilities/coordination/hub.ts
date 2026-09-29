// The optional SharedWorker relay behind channels opened with via: "hub"
// (kemiller2002/limen#46, LCP-040). The host serves a one-line module:
//
//   import { serveHub } from "…/capabilities/coordination/hub.js";
//   serveHub(self);
//
// and names its URL in coordinationCapability({ hub: { url } }). The hub relays
// each message to every other context that joined the channel; it keeps no
// application state, reads no message, and never answers on anyone's behalf.
// A context leaves explicitly (the pack sends leave on pagehide); where the
// browser reports a closed port, a context that vanished is dropped too.

export type HubScope = {
  addEventListener(type: "connect", listener: (event: MessageEvent) => void): void;
};

type Member = { readonly port: MessagePort; readonly context: string };

const field = (value: unknown, name: string): unknown => (typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined);

export const serveHub = (scope: HubScope): void => {
  const rooms: { members: ReadonlyMap<string, readonly Member[]> } = { members: new Map() };
  const leave = (port: MessagePort, channel?: string): void => {
    rooms.members = new Map([...rooms.members].map(([name, members]) => [name, channel === undefined || channel === name ? members.filter((member) => member.port !== port) : members] as const));
  };

  scope.addEventListener("connect", (event) => {
    const port = event.ports[0];
    if (port === undefined) return;
    port.addEventListener("message", (message) => {
      const data: unknown = message.data;
      const kind = field(data, "kind");
      const channel = field(data, "channel");
      const context = field(data, "context") ?? field(data, "from");
      if (typeof channel !== "string" || typeof context !== "string") return;
      switch (kind) {
        case "join":
          leave(port, channel);
          rooms.members = new Map([...rooms.members, [channel, [...(rooms.members.get(channel) ?? []), { port, context }]]]);
          return;
        case "leave":
          leave(port, channel);
          return;
        case "send":
          // Relayed as sent; the receiving pack validates it.
          (rooms.members.get(channel) ?? []).filter((member) => member.port !== port).forEach((member) => member.port.postMessage(data));
          return;
        default:
          return;
      }
    });
    port.addEventListener("close", () => leave(port));
    port.start();
  });
};
