// Wire a MeshBridge to an EventBus:
//  - local durable events (unless marked already-remote) are broadcast
//    to the bridge;
//  - events received from the bridge are re-published on the local bus
//    with a marker so re-broadcast doesn't loop.
//
// Dedup: we track seen event ids so two peers can't ping-pong when a
// future bridge has more than one path.

import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import { isRemote, REMOTE_TAG, type MeshBridge } from "./types.ts";

export interface WireOptions {
  bus: EventBus;
  bridge: MeshBridge;
  /** Only mirror events whose type is in this list. Defaults to all. */
  typeFilter?: (event: Event) => boolean;
}

export interface WiredBridge {
  unwire(): void;
  seen: ReadonlySet<string>;
}

export function wireBridgeToBus(opts: WireOptions): WiredBridge {
  const seen = new Set<string>();
  const filter = opts.typeFilter ?? (() => true);

  const unsubLocal = opts.bus.subscribe("*", (event) => {
    if (!event.durable) return; // transient locals stay local
    if (isRemote(event)) return; // arrived from a peer; don't reflect
    if (seen.has(event.id)) return;
    if (!filter(event)) return;
    seen.add(event.id);
    opts.bridge.broadcast(event);
  });

  const unsubRemote = opts.bridge.onReceive((event) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    const payload = event.payload as Record<string, unknown>;
    // Keep REMOTE_TAG on the re-published event so the local "*" hook
    // doesn't loop it back across the bridge. Durable: mesh semantics
    // are log-merge — every team cell keeps its own copy, and FK
    // consumers (claims, ledger) need the row to exist locally.
    opts.bus.publish({
      type: event.type,
      payload: {
        ...payload,
        [REMOTE_TAG]: true,
        remoteOrigin: event.hostId,
        remoteEventId: event.id,
      },
      hostId: opts.bus.hostId,
      actorId: event.actorId,
      parentEventId: event.parentEventId,
      durable: true,
    });
  });

  return {
    unwire() {
      unsubLocal();
      unsubRemote();
    },
    seen,
  };
}
