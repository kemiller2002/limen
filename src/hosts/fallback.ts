// The optional fatal-fallback host (kemiller2002/limen#50, LCP-032).
//
// Application errors are engine state and never come here. This host is for
// the other kind: the engine could not start, its Initialize failed, the page
// refused a binding, the engine was incompatible, or the engine threw while
// handling a message — cases where the engine cannot project its own
// recovery UI, and where its state after a throw is unknown.
//
// Health is mechanical and separate from application state:
//
//   starting → available
//            → unavailable { id, phase, attempt, restartable }
//
// One deterministic policy, preserve-and-cover:
//   - on a fault the kernel is disposed (nothing more reaches an engine in an
//     unknown state), every existing child of <body> is made inert and hidden
//     from assistive technology, and a static, generic failure surface is
//     appended — so the page is never silently dead;
//   - Restart clones the page's pre-start DOM back and starts a fresh kernel
//     from the composition root; Reload reloads the document. Restarts are
//     bounded: after maxRestarts, only Reload is offered.
//
// The error id is stable and redacted: LIMEN-<PHASE>-<ErrorName>. It names the
// failing step and the exception's class, never its message, payload or
// headers, so it can go in a support ticket or telemetry as it is.
//
// This module imports no kernel. The composition root builds each kernel
// through connect(guard), wrapping its transport with guard so the host can
// see a fault's error name.

import type { EngineTransport } from "../protocol.js";

export type HostFaultPhase = "start" | "initialize" | "binding" | "incompatible" | "dispatch";

export type Health =
  | { readonly kind: "starting"; readonly attempt: number }
  | { readonly kind: "available"; readonly attempt: number }
  | { readonly kind: "unavailable"; readonly attempt: number; readonly id: string; readonly phase: HostFaultPhase; readonly restartable: boolean };

// What the host needs from a kernel, by shape.
export type Kernel = { readonly start: () => Promise<void>; readonly status: string; readonly dispose: () => void };

export type FallbackText = {
  readonly title: string;
  readonly message: string;
  readonly restart: string;
  readonly reload: string;
  readonly exhausted: string;
  readonly idLabel: string;
};

export const DEFAULT_FALLBACK_TEXT: FallbackText = {
  title: "Something went wrong",
  message: "This page stopped working. Nothing you entered has been sent since.",
  restart: "Try again",
  reload: "Reload the page",
  exhausted: "Trying again did not help. Reload the page, or contact support with the error ID.",
  idLabel: "Error ID",
};

export type FallbackOptions = {
  readonly document: Document;
  // Builds a fresh kernel for each attempt. Wrap the transport with guard.
  readonly connect: (guard: (transport: EngineTransport) => EngineTransport) => Kernel;
  // Restarts offered after the first attempt fails. Default 2.
  readonly maxRestarts?: number;
  readonly text?: Partial<FallbackText>;
  // Every health change, for telemetry. The id is already redacted.
  readonly onHealth?: (health: Health) => void;
  // Default: the document's own location.reload().
  readonly reload?: () => void;
};

export type FallbackHost = {
  readonly health: () => Health;
  // Restart now, if allowed; answers the health that results.
  readonly restart: () => Promise<Health>;
};

// A name safe to put in an id: the exception's class, never its message.
const errorName = (error: unknown): string => {
  const name = typeof error === "object" && error !== null && "name" in error && typeof error.name === "string" ? error.name : "Error";
  return /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(name) ? name : "Error";
};

export const faultId = (phase: HostFaultPhase, name: string): string => `LIMEN-${phase.toUpperCase()}-${name}`;

export const startWithFallback = async (options: FallbackOptions): Promise<FallbackHost> => {
  const { document } = options;
  const text: FallbackText = { ...DEFAULT_FALLBACK_TEXT, ...options.text };
  const maxRestarts = options.maxRestarts ?? 2;
  // The page as it was before any kernel bound it: templates intact, nothing
  // projected. Cloned as nodes, never as HTML strings.
  const pristine = Array.from(document.body.childNodes, (node) => node.cloneNode(true));

  // The host's own cells: its health, the current kernel, and the fault the
  // guarded transport recorded for the current attempt.
  const state: { health: Health; kernel: Kernel | undefined; running: boolean } = { health: { kind: "starting", attempt: 1 }, kernel: undefined, running: false };
  const recorded: { fault: { readonly phase: HostFaultPhase; readonly name: string } | undefined } = { fault: undefined };
  // Read through a function: the guard writes it during start(), which
  // TypeScript cannot see across the await.
  const faultSoFar = () => recorded.fault;

  const publish = (health: Health): Health => {
    state.health = health;
    options.onHealth?.(health);
    return health;
  };

  const surfaceFor = (health: Extract<Health, { kind: "unavailable" }>): HTMLElement => {
    const element = (tag: string, content?: string, className?: string): HTMLElement => {
      const created = document.createElement(tag);
      if (content !== undefined) created.textContent = content;
      if (className !== undefined) created.className = className;
      return created;
    };
    const surface = element("div", undefined, "limen-fallback");
    surface.setAttribute("role", "alert");
    surface.setAttribute("data-limen-fallback", health.phase);
    const reload = element("button", text.reload, "limen-fallback-reload");
    reload.setAttribute("type", "button");
    reload.addEventListener("click", () => (options.reload ?? (() => document.defaultView?.location.reload()))());
    const restart = element("button", text.restart, "limen-fallback-restart");
    restart.setAttribute("type", "button");
    restart.addEventListener("click", () => { void host.restart(); });
    const code = element("p", undefined, "limen-fallback-id");
    code.append(`${text.idLabel}: `, element("code", health.id));
    surface.append(
      element("h2", text.title),
      element("p", health.restartable ? text.message : text.exhausted),
      code,
      ...(health.restartable ? [restart] : []),
      reload,
    );
    return surface;
  };

  // Preserve-and-cover: stop the kernel, keep the last view but make it
  // inert, and show the surface. Idempotent for one attempt.
  const fail = (phase: HostFaultPhase, name: string): Health => {
    if (state.health.kind === "unavailable") return state.health;
    state.kernel?.dispose();
    const health: Health = { kind: "unavailable", attempt: state.health.attempt, id: faultId(phase, name), phase, restartable: state.health.attempt <= maxRestarts };
    Array.from(document.body.children).forEach((child) => {
      child.setAttribute("inert", "");
      child.setAttribute("aria-hidden", "true");
    });
    const surface = surfaceFor(health);
    document.body.append(surface);
    surface.querySelector("button")?.focus();
    return publish(health);
  };

  // The transport as the host sees it: every rejection is recorded by phase
  // and class, then passed on unchanged so the kernel reports it as it always
  // has. A throw while running is fatal: the engine's state is now unknown.
  const guard = (transport: EngineTransport): EngineTransport => ({
    start: async () => {
      try {
        await transport.start();
      } catch (error) {
        recorded.fault = { phase: "start", name: errorName(error) };
        throw error;
      }
    },
    dispatch: async (message) => {
      try {
        return await transport.dispatch(message);
      } catch (error) {
        const name = errorName(error);
        if (message.kind === "Initialize") recorded.fault = { phase: "initialize", name };
        else if (state.running) queueMicrotask(() => { fail("dispatch", name); });
        throw error;
      }
    },
  });

  const attempt = async (): Promise<Health> => {
    recorded.fault = undefined;
    state.running = false;
    const kernel = options.connect(guard);
    state.kernel = kernel;
    await kernel.start();
    switch (kernel.status) {
      case "running":
        state.running = true;
        return publish({ kind: "available", attempt: state.health.attempt });
      case "incompatible":
        return fail("incompatible", "Incompatible");
      default:
        // No transport fault recorded: the page refused a binding at start.
        return fail(faultSoFar()?.phase ?? "binding", faultSoFar()?.name ?? "BindingError");
    }
  };

  const host: FallbackHost = {
    health: () => state.health,
    restart: async () => {
      if (state.health.kind !== "unavailable" || !state.health.restartable) return state.health;
      const next = state.health.attempt + 1;
      state.kernel?.dispose();
      document.body.replaceChildren(...pristine.map((node) => node.cloneNode(true)));
      publish({ kind: "starting", attempt: next });
      return attempt();
    },
  };

  publish(state.health);
  await attempt();
  return host;
};
