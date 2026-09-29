// Protocol 1.2 form-control state as Chromium reports it: activation toggles a
// real checkbox and radio, and a click on a named submit button is a real
// submission with a submitter. The engine negotiates 1.2 and records events.
import { BrowserKernel } from "../../../../dist/kernel/browser-kernel.js";
import { CORE_CONTRACT_IDENTITY } from "../../../../dist/protocol.js";

const events = [];
const engine = {
  start: async () => {},
  dispatch: async (message) => {
    if (message.kind === "Event") events.push(message.event);
    return {
      view: {}, effects: [], cancellations: [],
      ...(message.kind === "Initialize" ? { handshake: { kind: "Accepted", protocol: { major: 1, minor: 2 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [] } } : {}),
    };
  },
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const last = () => events.at(-1);
const checks = [];
const expect = (name, ok, detail) => checks.push({ name, ok, detail: JSON.stringify(detail) });

await new BrowserKernel(engine, document).start();

document.getElementById("terms").click();
await settle();
expect("clicking a checkbox reports checked: true", last()?.name === "terms" && last()?.checked === true && last()?.value === "on", last());

document.getElementById("terms").click();
await settle();
expect("clicking it again reports checked: false", last()?.checked === false, last());

document.getElementById("tips").click();
await settle();
expect("a checkbox group reports every checked value in the group", JSON.stringify(last()?.values) === JSON.stringify(["news", "tips"]) && last()?.value === "tips", last());

document.getElementById("pro").click();
await settle();
expect("a radio reports the value that became checked", last()?.name === "plan" && last()?.value === "pro" && last()?.checked === true, last());

const colours = document.getElementById("colours");
colours.options[2].selected = true;
colours.dispatchEvent(new Event("change", { bubbles: true }));
await settle();
expect("a multi-select reports every selected value", JSON.stringify(last()?.values) === JSON.stringify(["red", "blue"]), last());

document.getElementById("publish").click();
await settle();
expect("a real submission reports the named button that submitted it", last()?.name === "save" && last()?.submitter === "publish", last());

document.getElementById("draft").click();
await settle();
expect("another button, another submitter", last()?.submitter === "draft", last());

window.__limenPackResult = { pack: "core-form-controls", checks };
