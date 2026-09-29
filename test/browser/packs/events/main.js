// The rich event facts pack with trusted input: the runner presses keys,
// drags the pointer, drags and drops, and composes through an IME when asked.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { eventsCapability, EVENTS_CAPABILITY, decodeRichEvent } from "../../../../dist/capabilities/events/index.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const offer = { id: EVENTS_CAPABILITY.id, version: EVENTS_CAPABILITY.version, fingerprint: EVENTS_CAPABILITY.fingerprint };
const facts = [];
const events = [];
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "CapabilityFact") {
      const decoded = decodeRichEvent(message.fact);
      facts.push(decoded.ok ? decoded.value : { name: "UNDECODABLE" });
    }
    if (message.kind === "Event") events.push(message.event);
    return {
      view: {}, effects: [], cancellations: [],
      ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer] } } : {}),
    };
  },
};

const act = (action) => new Promise((resolve) => {
  window.__limenPackActionDone = () => setTimeout(resolve, 100);
  window.__limenPackAction = action;
});
const named = (name) => facts.filter((fact) => fact.name === name);
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document, undefined, { capabilities: [eventsCapability()] }).start();

await act({ kind: "press", selector: "#notes", key: "a" });
await act({ kind: "press", selector: "#notes", key: "Control+Shift+Enter" });
await act({ kind: "press", selector: "#notes", key: "Enter" });
const shortcuts = named("shortcut");
expect("keyboard: only the declared key is reported, with its modifiers", shortcuts.length === 2 && shortcuts[0].keyboard.key === "Enter" && shortcuts[0].modifiers.ctrl && shortcuts[0].modifiers.shift && !shortcuts[1].modifiers.ctrl, shortcuts);
expect("keyboard: the declared key's default is prevented (no newline); other keys still type", document.getElementById("notes").value === "a", document.getElementById("notes").value);

await act({ kind: "drag", from: [50, 150], to: [400, 400], steps: 20 });
const drag = named("drag");
const down = drag.findIndex((fact) => fact.type === "pointerdown");
const pressed = drag.slice(down + 1, -1);
const moves = drag.filter((fact) => fact.type === "pointermove");
expect("pointer drag: a hover, then down, pressed moves (coalesced), up — in the order they happened", down >= 0 && drag.slice(0, down).every((fact) => fact.pointer.buttons === 0) && pressed.length >= 1 && pressed.length <= 20 && pressed.every((fact) => fact.type === "pointermove" && fact.pointer.buttons === 1) && drag.at(-1)?.type === "pointerup", drag.map((fact) => fact.type + ":" + fact.pointer.buttons));
expect("pointer capture: moves keep arriving far outside the element, with its button held", moves.some((fact) => fact.pointer.x > 300 && fact.pointer.buttons === 1) && drag.at(-1)?.pointer.x === 400, moves.map((fact) => [fact.pointer.x, fact.pointer.buttons]));

await act({ kind: "dragAndDrop", source: "#source", target: "#zone" });
const zone = named("zone");
const drop = zone.find((fact) => fact.type === "drop");
expect("drag and drop: dragover then drop, with the dragged types and no contents", zone.some((fact) => fact.drag?.phase === "over") && drop?.drag.phase === "drop" && drop.drag.types.includes("text/uri-list") && drop.drag.fileCount === 0, zone);

await act({ kind: "compose", selector: "#ime", steps: ["に", "にほ", "日本"], commit: "日本" });
expect("IME: the committed text arrives at compositionend", named("composed").length === 1 && named("composed")[0].composition.committed === "日本", named("composed"));

await act({ kind: "compose", selector: "#ime-input", steps: ["に", "にほん"], commit: "日本" });
const imeInputs = named("imeInput");
expect("IME: input facts during composition carry no uncommitted data", imeInputs.every((fact) => fact.input.data === undefined || fact.input.data === "日本") && imeInputs.every((fact) => !["に", "にほん"].includes(fact.input.data)), imeInputs);

await act({ kind: "compose", selector: "#simple", steps: ["か", "かん", "漢"], commit: "漢字" });
expect("IME on the simple path: only the committed value reaches the engine", events.length >= 1 && events.every((event) => event.value === "漢字"), events);

expect("every fact decoded with the generated decoder", facts.every((fact) => fact.name !== "UNDECODABLE"), facts.length);

window.__limenPackResult = { pack: "limen.events", checks };
