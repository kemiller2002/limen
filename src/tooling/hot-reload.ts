// State-safe hot reload for the edit loop (kemiller2002/limen#36, LCP-030).
// Development only: nothing in Core or the default package path imports it.
//
// The policy is one pure function, planReload:
//   a stylesheet change swaps that stylesheet in place — no kernel, engine or
//     DOM state is touched;
//   an HTML change remounts: the page's DOM is replaced with the new page's,
//     and the same engine is restarted from its own snapshot;
//   an engine change restores the new engine from the old one's snapshot only
//     when the snapshot versions are exactly equal — compatibility is never
//     guessed — and otherwise resets it;
//   anything else, or anything the page cannot apply, reloads the page.
//
// The browser side keeps no copy of application state. The engine produces
// its snapshot and consumes it; this module only carries it across.

import type { EngineTransport } from "../protocol.js";

export type Change =
  | { readonly kind: "css"; readonly path: string }
  | { readonly kind: "html"; readonly path: string }
  | { readonly kind: "engine"; readonly path: string }
  | { readonly kind: "other"; readonly path: string };

export type ReloadPlan =
  | { readonly kind: "swapStylesheet"; readonly path: string }
  | { readonly kind: "remount" }
  | { readonly kind: "restoreEngine"; readonly version: string }
  | { readonly kind: "resetEngine"; readonly reason: "incompatible" | "no-snapshot" }
  | { readonly kind: "fullReload"; readonly reason: string };

export type PlanFacts = {
  // The stylesheets the page links, by path.
  readonly stylesheets: readonly string[];
  // The running engine's snapshot version, if it can snapshot.
  readonly currentVersion: string | undefined;
  // The replacement engine's snapshot version (engine changes only).
  readonly nextVersion?: string | undefined;
  // Whether the page being edited is the page that is open.
  readonly currentPage: string;
};

const samePath = (left: string, right: string): boolean => left.split("?")[0] === right.split("?")[0];

export const planReload = (change: Change, facts: PlanFacts): ReloadPlan => {
  switch (change.kind) {
    case "css":
      return facts.stylesheets.some((path) => samePath(path, change.path))
        ? { kind: "swapStylesheet", path: change.path }
        : { kind: "fullReload", reason: "the page does not link this stylesheet" };
    case "html":
      return samePath(change.path, facts.currentPage) ? { kind: "remount" } : { kind: "fullReload", reason: "another page changed" };
    case "engine":
      if (facts.currentVersion === undefined || facts.nextVersion === undefined) return { kind: "resetEngine", reason: "no-snapshot" };
      return facts.currentVersion === facts.nextVersion
        ? { kind: "restoreEngine", version: facts.nextVersion }
        : { kind: "resetEngine", reason: "incompatible" };
    case "other":
      return { kind: "fullReload", reason: "not a stylesheet, page or engine" };
  }
};

// ---------------------------------------------------------------------------
// The browser side
// ---------------------------------------------------------------------------

// An engine that can be replaced. snapshotVersion is its compatibility key:
// a snapshot restores only into an engine with exactly the same key.
export type HotEngine = {
  readonly snapshotVersion: string | undefined;
  readonly create: (restored: unknown) => { readonly transport: EngineTransport; readonly snapshot: () => unknown };
};

export type HotKernel = { readonly start: () => Promise<void>; readonly dispose: () => void };

export type HotReloadOptions = {
  readonly document: Document;
  readonly engine: HotEngine;
  readonly kernel: (transport: EngineTransport) => HotKernel;
  // Re-import the changed engine module (a cache-busting dynamic import).
  readonly loadEngine: (path: string) => Promise<HotEngine>;
  // The changed page's <body>, parsed.
  readonly loadPage: (path: string) => Promise<readonly Node[]>;
  readonly reload: () => void;
  // Paths, e.g. location.pathname.
  readonly currentPage: string;
};

export type HotReloader = {
  readonly apply: (change: Change) => Promise<ReloadPlan>;
};

const stylesheetLinks = (document: Document): readonly HTMLLinkElement[] =>
  Array.from(document.querySelectorAll("link[rel~=stylesheet]")).filter((link): link is HTMLLinkElement => "href" in link && link.localName === "link");

const pathOf = (document: Document, href: string): string => new URL(href, document.baseURI).pathname;

export const createHotReloader = async (options: HotReloadOptions): Promise<HotReloader> => {
  const { document } = options;
  // The page as authored, before any kernel bound it; replaced on remount.
  const page: { nodes: readonly Node[] } = { nodes: Array.from(document.body.childNodes, (node) => node.cloneNode(true)) };
  const running: { engine: HotEngine; instance: ReturnType<HotEngine["create"]>; kernel: HotKernel; stamp: number } = (() => {
    const instance = options.engine.create(undefined);
    return { engine: options.engine, instance, kernel: options.kernel(instance.transport), stamp: 0 };
  })();
  await running.kernel.start();

  // Stop the kernel, put the page back as authored, start a fresh kernel.
  const restart = async (engine: HotEngine, restored: unknown): Promise<void> => {
    running.kernel.dispose();
    document.body.replaceChildren(...page.nodes.map((node) => document.importNode(node, true)));
    running.engine = engine;
    running.instance = engine.create(restored);
    running.kernel = options.kernel(running.instance.transport);
    await running.kernel.start();
  };

  // Load the new stylesheet next to the old one, then remove the old: the
  // page is never unstyled, and nothing else is touched.
  const swapStylesheet = (path: string): Promise<void> => new Promise((resolve) => {
    const old = stylesheetLinks(document).find((link) => samePath(pathOf(document, link.href), path));
    if (old === undefined) { resolve(); return; }
    running.stamp += 1;
    const next = old.cloneNode(true) as HTMLLinkElement;
    const url = new URL(old.href, document.baseURI);
    url.searchParams.set("limen-hot", String(running.stamp));
    next.href = url.href;
    const done = (): void => { old.remove(); resolve(); };
    next.addEventListener("load", done, { once: true });
    next.addEventListener("error", done, { once: true });
    old.after(next);
  });

  const apply = async (change: Change): Promise<ReloadPlan> => {
    const nextEngine = change.kind === "engine" ? await options.loadEngine(change.path) : undefined;
    const plan = planReload(change, {
      stylesheets: stylesheetLinks(document).map((link) => pathOf(document, link.href)),
      currentVersion: running.engine.snapshotVersion,
      nextVersion: nextEngine?.snapshotVersion,
      currentPage: options.currentPage,
    });
    switch (plan.kind) {
      case "swapStylesheet":
        await swapStylesheet(plan.path);
        return plan;
      case "remount":
        page.nodes = await options.loadPage(change.path);
        await restart(running.engine, running.engine.snapshotVersion === undefined ? undefined : running.instance.snapshot());
        return plan;
      case "restoreEngine":
        if (nextEngine !== undefined) await restart(nextEngine, running.instance.snapshot());
        return plan;
      case "resetEngine":
        if (nextEngine !== undefined) await restart(nextEngine, undefined);
        return plan;
      case "fullReload":
        options.reload();
        return plan;
    }
  };

  return { apply };
};

// The dev server's change stream (scripts/dev-server.ts), as Change values.
export const connectDevEvents = (document: Document, url: string, onChange: (change: Change) => void): (() => void) => {
  const view = document.defaultView;
  if (view === null || typeof view.EventSource !== "function") return () => {};
  const source = new view.EventSource(url);
  source.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (typeof event.data !== "string") return;
    try {
      const value: unknown = JSON.parse(event.data);
      if (typeof value === "object" && value !== null && "kind" in value && "path" in value && typeof value.path === "string"
        && (value.kind === "css" || value.kind === "html" || value.kind === "engine" || value.kind === "other")) {
        onChange({ kind: value.kind, path: value.path });
      }
    } catch {
      // Not a change message; the stream carries nothing else.
    }
  });
  return () => source.close();
};
