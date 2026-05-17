// Mesh bridge — v0 contract wire.ts sees.
//
// Two implementations satisfy this interface:
//   * `createLocalPair` — in-memory pair for tests of the bus↔bridge seam.
//   * `RealMeshBridge` — WebSocket peer mesh with team-scoped HMAC envelopes.
//     The real bridge derives team scope from `payload.teamId` or, for
//     memory events, `payload.scopeRef`, then applies the Feature E filter.
//
// The team-management surface (addPeer / setTeamSecret / addr) lives on
// `RealMeshBridge` directly, NOT on this interface. Daemons hold a
// `RealMeshBridge` and pass `.asBridge()` into `wireBridgeToBus`. This
// keeps the wire seam narrow — wire.ts just sees broadcast/onReceive.
//
// Remote-or-local is carried on the bus's DeliveryContext, never on
// `event.payload`. The persisted row matches what the original publisher
// emitted (LOG 2026-05-14 honest event identity).

import type { Event } from "../bus/types.ts";

export type MeshReceiver = (event: Event) => void;

export interface MeshBridge {
  /** Name of the peer cell this bridge represents, for logging. */
  readonly peerId: string;
  /** Called by the local bus to mirror a published event to peers.
   *  Real bridges derive team scope and drop events that are not eligible
   *  to cross. */
  broadcast(event: Event): void;
  /** Local bus registers here to receive remote-originated events. */
  onReceive(fn: MeshReceiver): () => void;
  /** Tear down connections. */
  close(): void;
}
