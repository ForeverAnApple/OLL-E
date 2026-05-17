// Wire a MeshBridge to an EventBus with honest event identity.
//
// Outbound: local durable events flow through bus.subscribe with a
// `{ remote: false }` delivery context. Mirror the original event to the
// bridge — no payload mutation, no re-mint. Bridge receivers see exactly
// what the originating publisher emitted.
//
// Inbound: a peer hands us its event; we call bus.inject(event, {remote:
// true}). Persist is idempotent on event.id, dispatch is dedup'd in-memory
// by the bus, and handlers see the original hostId / hlc / actorId. The
// subscribe handler then skips re-broadcast based on ctx.remote, so no
// REMOTE_TAG payload pollution is needed to prevent the ping-pong.

import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { MeshBridge } from "./types.ts";

export interface WireOptions {
  bus: EventBus;
  bridge: MeshBridge;
  /** Only mirror events whose type is in this list. Defaults to all. */
  typeFilter?: (event: Event) => boolean;
}

export interface WiredBridge {
  unwire(): void;
}

export function wireBridgeToBus(opts: WireOptions): WiredBridge {
  const filter = opts.typeFilter ?? (() => true);

  const unsubLocal = opts.bus.subscribe("*", (event, ctx) => {
    if (!event.durable) return; // transient locals stay local
    if (ctx.remote) return; // arrived from a peer; don't reflect
    if (!filter(event)) return;
    opts.bridge.broadcast(event);
  });

  const unsubRemote = opts.bridge.onReceive((event) => {
    opts.bus.inject(event, { remote: true });
  });

  return {
    unwire() {
      unsubLocal();
      unsubRemote();
    },
  };
}
