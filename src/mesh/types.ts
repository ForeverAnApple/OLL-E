// Mesh bridge — v0 seam for cross-host event propagation.
//
// The real wire protocol (v1+) will use per-team shared secrets and
// either LAN mDNS or a bootstrap peer list. v0 ships only a contract and
// an in-memory pair bridge that lets two cells on the same process
// exchange events — enough to exercise the claim protocol, validate the
// seams, and demo pooled compute without any real networking.

import type { Event } from "../bus/types.ts";

export type MeshReceiver = (event: Event) => void;

export interface MeshBridge {
  /** Name of the peer cell this bridge represents, for logging. */
  readonly peerId: string;
  /** Called by the local bus to mirror a published event to peers. */
  broadcast(event: Event): void;
  /** Local bus registers here to receive remote-originated events. */
  onReceive(fn: MeshReceiver): () => void;
  /** Tear down connections. */
  close(): void;
}

/** Sticks on an inbound event when a bridge delivers it, so the local bus
 *  can distinguish local publishes from peer mirrors and avoid bounce. */
export const REMOTE_TAG = "olle.remote" as const;

export function isRemote(event: Event): boolean {
  const p = event.payload as Record<string, unknown> | null | undefined;
  return Boolean(p && p[REMOTE_TAG] === true);
}
