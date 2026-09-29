// Opaque handles for capability packs (kemiller2002/limen#51 §7).
//
// A browser resource — a File, a stream, a socket, an observer — never
// crosses the boundary. The provider keeps it here and hands the engine an
// opaque id. This table makes the lifecycle every handle-returning capability
// must define explicit, and the same everywhere:
//
//   creation   create(resource, dispose) → a fresh id, never reused
//   ownership  the provider owns the resource; the engine owns only the id
//   validity   from create until dispose, within this host session
//   disposal   dispose(id) runs the resource's cleanup exactly once
//   stale      an id that is unknown, already disposed, or from another
//              session is Stale with that reason — never live by accident
//   reload     a new page load is a new session: every earlier id is Stale
//              ("other-session"), even if an engine restored it from storage
//
// Ids are "<session>.<n>". The session token is random per table, so ids
// from a previous page load cannot collide with this one's.

export type StaleReason = "unknown" | "disposed" | "other-session";

export type Lookup<T> = { readonly kind: "Live"; readonly resource: T } | { readonly kind: "Stale"; readonly reason: StaleReason };

export type Disposal = { readonly kind: "Disposed" } | { readonly kind: "Stale"; readonly reason: StaleReason };

export type HandleTable<T> = {
  readonly create: (resource: T, dispose: (resource: T) => void) => string;
  readonly use: (id: string) => Lookup<T>;
  readonly dispose: (id: string) => Disposal;
  // Host teardown: disposes everything still live. Returns how many were.
  readonly disposeAll: () => number;
  readonly size: () => number;
};

type Entry<T> = { readonly resource: T; readonly dispose: (resource: T) => void };

const randomSession = (): string => Math.random().toString(36).slice(2, 10);

export const createHandleTable = <T>(session: string = randomSession()): HandleTable<T> => {
  // The table is the one mutable place: live entries and a monotonic counter.
  const live = new Map<string, Entry<T>>();
  const counter = { issued: 0 };

  const classify = (id: string): StaleReason => {
    const [owner, sequence] = id.split(".");
    if (owner !== session) return "other-session";
    const number = Number(sequence);
    return Number.isInteger(number) && number >= 1 && number <= counter.issued ? "disposed" : "unknown";
  };

  return {
    create: (resource, dispose) => {
      counter.issued += 1;
      const id = `${session}.${counter.issued}`;
      live.set(id, { resource, dispose });
      return id;
    },
    use: (id) => {
      const entry = live.get(id);
      return entry === undefined ? { kind: "Stale", reason: classify(id) } : { kind: "Live", resource: entry.resource };
    },
    dispose: (id) => {
      const entry = live.get(id);
      if (entry === undefined) return { kind: "Stale", reason: classify(id) };
      live.delete(id);
      entry.dispose(entry.resource);
      return { kind: "Disposed" };
    },
    disposeAll: () => {
      const entries = Array.from(live.values());
      live.clear();
      entries.forEach((entry) => entry.dispose(entry.resource));
      return entries.length;
    },
    size: () => live.size,
  };
};
