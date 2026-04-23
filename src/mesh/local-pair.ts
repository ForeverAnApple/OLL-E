// In-memory bridge pair for exercising the mesh protocol inside one
// process. Two cells created back-to-back call createLocalPair() and get
// back two bridges that pipe events to each other.

import type { Event } from "../bus/types.ts";
import { REMOTE_TAG, type MeshBridge, type MeshReceiver } from "./types.ts";

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
    const marked: Event = {
      ...event,
      payload: {
        ...(event.payload as Record<string, unknown>),
        [REMOTE_TAG]: true,
      },
    };
    for (const fn of dest) {
      try {
        fn(marked);
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
