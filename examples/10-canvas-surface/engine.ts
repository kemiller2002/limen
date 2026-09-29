// The engine for the canvas surface example (kemiller2002/limen#45). It owns
// the data, the selection and the viewport it has adopted, and the chart's
// lifecycle. The surface (scatter-adapter.ts) owns every pixel. What crosses
// is a small scene as props and semantic facts back; the projected message
// count shows how little that is while the surface draws at frame rate.

import type { BrowserToEngineMessage, CapabilityId, CorrelationId, EffectRequest, EngineToBrowserMessage, EngineTransport, ViewState } from "../../dist/protocol.js";
import { CORE_CONTRACT_IDENTITY } from "../../dist/protocol.js";
import { CAPABILITY_OFFER as ADAPTERS } from "../../dist/capabilities/adapters/generated/adapters.js";
import type { AdaptersRequest, InstanceId } from "../../dist/capabilities/adapters/generated/adapters.js";
import { decodeAdaptersFact, decodeAdaptersResult } from "../../dist/capabilities/adapters/generated/adapters.codec.js";
import { CAPABILITY_OFFER as FOCUS } from "../../dist/capabilities/focus/generated/focus.js";
import type { Point, Viewport } from "./scene.js";

export type Chart =
  | { readonly kind: "mounting" }
  | { readonly kind: "mounted"; readonly instance: InstanceId }
  // instance: the quarantined instance to unmount before mounting again.
  | { readonly kind: "faulted"; readonly phase: string; readonly reason: string; readonly instance: InstanceId | null }
  | { readonly kind: "hidden" };

export type State = {
  readonly points: readonly Point[];
  readonly selected: string | null;
  readonly viewport: Viewport;
  readonly chart: Chart;
  readonly wide: boolean;
  // Every message the engine has received: the boundary's traffic.
  readonly messages: number;
  // What the surface last reported about its own drawing, when asked.
  readonly surface: { readonly frames: number; readonly emitted: number; readonly width: number } | null;
};

// Deterministic data: no randomness in the engine.
const pointAt = (index: number): Point => ({ id: `p${index + 1}`, label: `Sample ${index + 1}`, x: Math.round(Math.cos(index * 1.7) * (index + 4) * 10) / 10, y: Math.round(Math.sin(index * 1.3) * (index + 6) * 10) / 10 });

export const initialState: State = {
  points: Array.from({ length: 24 }, (_, index) => pointAt(index)),
  selected: null,
  viewport: { cx: 0, cy: 0, zoom: 8 },
  chart: { kind: "mounting" },
  wide: true,
  messages: 0,
  surface: null,
};

export const sceneProps = (state: State) => ({ points: state.points, selected: state.selected, viewport: state.viewport });

export const project = (state: State): ViewState => {
  const selected = state.points.find((point) => point.id === state.selected);
  return {
    showChart: state.chart.kind !== "hidden",
    chartFaulted: state.chart.kind === "faulted",
    chartStatus: state.chart.kind === "faulted" ? `The chart stopped (${state.chart.phase}: ${state.chart.reason}). The rest of the page is unaffected.` : state.chart.kind,
    width: state.wide ? "wide" : "narrow",
    pointCount: String(state.points.length),
    selection: selected === undefined ? "Nothing selected" : `${selected.label}: (${selected.x}, ${selected.y})`,
    zoom: `${Math.round(state.viewport.zoom * 10) / 10}×`,
    messages: String(state.messages),
    surfaceFrames: state.surface === null ? "not measured" : String(state.surface.frames),
    surfaceEmitted: state.surface === null ? "not measured" : String(state.surface.emitted),
    surfaceWidth: state.surface === null ? "not measured" : String(state.surface.width),
  };
};

// --- transitions ---------------------------------------------------------------

type Step = { readonly state: State; readonly requests: readonly AdaptersRequest[]; readonly focus?: true };
const only = (state: State): Step => ({ state, requests: [] });
const SCATTER = { id: "scatter", version: 1 } as const;
const mount = (state: State): AdaptersRequest => ({ operation: "mount", slot: { name: "chart" }, adapter: SCATTER, props: sceneProps(state) });
// Push the scene to the surface, if one is mounted.
const redraw = (state: State): Step => (state.chart.kind === "mounted" ? { state, requests: [{ operation: "update", instance: state.chart.instance, props: sceneProps(state) }] } : only(state));

const isViewport = (value: unknown): value is Viewport => {
  const number = (name: string): boolean => typeof value === "object" && value !== null && typeof Reflect.get(value, name) === "number" && Number.isFinite(Reflect.get(value, name));
  return number("cx") && number("cy") && number("zoom");
};

export const onEvent = (state: State, name: string): Step => {
  switch (name) {
    case "addPoint": return redraw({ ...state, points: [...state.points, pointAt(state.points.length)] });
    case "resetView": return state.chart.kind === "mounted" ? { state, requests: [{ operation: "command", instance: state.chart.instance, name: "fit", args: null }] } : only(state);
    case "measureSurface": return state.chart.kind === "mounted" ? { state, requests: [{ operation: "command", instance: state.chart.instance, name: "stats", args: null }] } : only(state);
    case "focusChart": return state.chart.kind === "mounted" ? { state, requests: [], focus: true } : only(state);
    case "toggleWidth": return only({ ...state, wide: !state.wide });
    case "hideChart": return state.chart.kind === "hidden" ? only(state) : only({ ...state, chart: { kind: "hidden" } });
    case "showChart": {
      const chart = state.chart;
      if (chart.kind !== "hidden" && chart.kind !== "faulted") return only(state);
      const quarantined: readonly AdaptersRequest[] = chart.kind === "faulted" && chart.instance !== null ? [{ operation: "unmount", instance: chart.instance }] : [];
      return { state: { ...state, chart: { kind: "mounting" } }, requests: [...quarantined, mount(state)] };
    }
    // A demonstration fault: props the surface cannot draw.
    case "breakChart": return state.chart.kind === "mounted" ? { state, requests: [{ operation: "update", instance: state.chart.instance, props: { points: "not a list" } }] } : only(state);
    default: return only(state);
  }
};

const mountedInstance = (state: State): InstanceId | null => (state.chart.kind === "mounted" ? state.chart.instance : null);

// A fact from the surface: the engine decides what it means.
export const onFact = (state: State, fact: unknown): Step => {
  const decoded = decodeAdaptersFact(fact);
  if (!decoded.ok) return only(state);
  const value = decoded.value;
  switch (value.kind) {
    case "AdapterEvent": {
      if (value.name === "select") {
        const id: unknown = typeof value.data === "object" && value.data !== null ? Reflect.get(value.data, "id") : undefined;
        // Only a point the engine knows can be selected.
        return typeof id === "string" && state.points.some((point) => point.id === id) ? redraw({ ...state, selected: id }) : only(state);
      }
      // The surface's settled viewport is adopted; it already shows it.
      if (value.name === "viewport" && isViewport(value.data)) return only({ ...state, viewport: value.data });
      return only(state);
    }
    case "AdapterFaulted": return only({ ...state, chart: { kind: "faulted", phase: value.phase, reason: value.reason, instance: value.instance } });
    case "SlotRemoved": return only(state.chart.kind === "hidden" ? state : { ...state, chart: { kind: "hidden" } });
  }
};

export const onResult = (state: State, result: unknown): Step => {
  const decoded = decodeAdaptersResult(result);
  if (!decoded.ok) return only(state);
  const value = decoded.value;
  switch (value.kind) {
    case "Mounted":
      return state.chart.kind === "mounting" ? only({ ...state, chart: { kind: "mounted", instance: value.instance } }) : only(state);
    case "Faulted": return only({ ...state, chart: { kind: "faulted", phase: value.phase, reason: value.reason, instance: mountedInstance(state) } });
    case "CommandDone": {
      if (isViewport(value.result)) return only({ ...state, viewport: value.result });
      const stat = (name: string): number | undefined => {
        const found: unknown = typeof value.result === "object" && value.result !== null ? Reflect.get(value.result, name) : undefined;
        return typeof found === "number" ? found : undefined;
      };
      const [frames, emitted, width] = [stat("frames"), stat("emitted"), stat("width")];
      return frames !== undefined && emitted !== undefined && width !== undefined ? only({ ...state, surface: { frames, emitted, width } }) : only(state);
    }
    case "Updated": case "Unmounted": case "Adapters": case "UnknownAdapter": case "VersionMismatch": case "UnknownCommand":
    case "SlotOccupied": case "NotFound": case "Ambiguous": case "Stale": case "Cancelled":
      return only(state);
  }
};

// --- the transport ---------------------------------------------------------------

const offer = (capability: { readonly id: string; readonly version: number; readonly fingerprint: string }) =>
  ({ id: capability.id as CapabilityId, version: capability.version, fingerprint: capability.fingerprint });

export const createCanvasTransport = (): EngineTransport => {
  const cell = { state: initialState, effects: 0 };
  const respond = (step: Step): EngineToBrowserMessage => {
    cell.state = step.state;
    const id = (): CorrelationId => `chart-${(cell.effects += 1)}` as CorrelationId;
    const effects: EffectRequest[] = [
      ...step.requests.map((request): EffectRequest => ({ kind: "Capability", correlationId: id(), capability: offer(ADAPTERS).id, version: ADAPTERS.version, request })),
      ...(step.focus === true ? [{ kind: "Capability" as const, correlationId: id(), capability: offer(FOCUS).id, version: FOCUS.version, request: { operation: "focusFirst", scope: { name: "chart" } } }] : []),
    ];
    return { view: project(cell.state), effects, cancellations: [] };
  };
  const counted = (state: State): State => ({ ...state, messages: state.messages + 1 });
  return {
    start: async () => {},
    dispatch: async (message: BrowserToEngineMessage): Promise<EngineToBrowserMessage> => {
      const state = counted(cell.state);
      switch (message.kind) {
        case "Initialize":
          return { ...respond({ state, requests: [mount(state)] }), handshake: { kind: "Accepted", protocol: { major: 1, minor: 4 }, contract: { ...CORE_CONTRACT_IDENTITY }, capabilities: [offer(ADAPTERS), offer(FOCUS)] } };
        case "Event":
          return respond(onEvent(state, message.event.name));
        case "CapabilityFact":
          return respond(onFact(state, message.fact));
        case "EffectResult":
          return respond(message.result.kind === "CapabilityResult" && message.result.outcome.kind === "Completed" && message.result.capability === offer(ADAPTERS).id ? onResult(state, message.result.outcome.result) : only(state));
        case "LocationChanged":
          return respond(only(state));
      }
    },
  };
};
