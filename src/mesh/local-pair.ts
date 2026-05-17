// In-memory bridge pair for exercising the mesh wire-up inside one
// process. Tests that want to verify the bus↔bridge seam (wire.ts,
// honest event identity, no-bounce) use this; tests that want the
// real WebSocket + HMAC stack use `startRealMeshBridge`.
//
// **Bypass mode (deliberate):** local-pair forwards every durable
// event regardless of `payload.teamId` or `scope`. Scope filtering is
// a property of `RealMeshBridge`; the local-pair exists to prove the
// wire-up, not the filter. Tests asserting filter behavior live next
// to RealMeshBridge (test/mesh-bridge.test.ts).
//
// The pair simulates "another host sent us this": deliver the event
// byte-identical to what was broadcast. wire.ts flips it through
// bus.inject(event, {remote: true}) on the receiving side; remote-ness
// lives in the bus's DeliveryContext, not on the payload (LOG 2026-05-14).

import type { Event } from "../bus/types.ts";
import type { MeshBridge, MeshReceiver } from "./types.ts";

export interface LocalPair {
  a: MeshBridge;
  b: MeshBridge;
}

export function createLocalPair(opts?: { nameA?: string; nameB?: string }): LocalPair {
  const nameA = opts?.nameA ?? "cell-a";
  const nameB = opts?.nameB ?? "cell-b";

  const aRecv: Set<MeshReceiver> = new Set();
  const bRecv: Set<MeshReceiver> = new Set();

  const deliver = (dest: Set<MeshReceiver>, event: Event): void => {
    for (const fn of dest) {
      try {
        fn(event);
      } catch (err) {
        // eslint-disable-next-line no-console -- mesh is infra
        console.error("[mesh] receiver threw:", err);
      }
    }
  };

  const a: MeshBridge = {
    peerId: nameB,
    broadcast(event) {
      if (bRecv.size === 0) return;
      queueMicrotask(() => deliver(bRecv, event));
    },
    onReceive(fn) {
      aRecv.add(fn);
      return () => {
        aRecv.delete(fn);
      };
    },
    close() {
      aRecv.clear();
    },
  };

  const b: MeshBridge = {
    peerId: nameA,
    broadcast(event) {
      if (aRecv.size === 0) return;
      queueMicrotask(() => deliver(aRecv, event));
    },
    onReceive(fn) {
      bRecv.add(fn);
      return () => {
        bRecv.delete(fn);
      };
    },
    close() {
      bRecv.clear();
    },
  };

  return { a, b };
}
