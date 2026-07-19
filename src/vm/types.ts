// Core types for the microVM-isolation subsystem. Types only — no logic that
// imports a hypervisor lives here, so this module stays cheap and dependency-
// free. The backend implementations (Firecracker, etc.) and the placement
// policy impl are wired elsewhere and satisfy these shapes.

import type { Channel } from "./channel.ts";
import type { Manifest } from "../extensions/types.ts";

/** Result of probing whether a backend can run on this host. */
export interface BackendAvailability {
  available: boolean;
  reason?: string;
  /** Backend identifier, e.g. "firecracker", "process". */
  backend: string;
}

/** Inputs to boot a guest for an agent. `bootNonce` binds the guest's first
 *  handshake to this launch so a stale guest can't impersonate a fresh one. */
export interface VmStartOpts {
  agentId: string;
  bootNonce: string;
}

/** A running guest and the seams to talk to it and reap it. */
export interface VmHandle {
  /** Bidirectional RPC to the guest. */
  channel: Channel;
  /** Force-terminate the guest. */
  kill(): Promise<void>;
  /** Resolves with the guest's exit code when it exits. */
  onExit: Promise<number>;
}

/** A hypervisor (or process) backend that prepares, starts, and stops guests
 *  keyed by an opaque `vmKey` (the PlacementPolicy decides what that key is). */
export interface VmBackend {
  probe(): Promise<BackendAvailability>;
  prepare(vmKey: string): Promise<void>;
  start(vmKey: string, opts: VmStartOpts): Promise<VmHandle>;
  stop(vmKey: string): Promise<void>;
}

/** Maps an agent + extension manifest to a vmKey — the co-location decision
 *  (one VM per agent, per extension, shared, …). The v1 impl returns agentId. */
export interface PlacementPolicy {
  placementFor(agentId: string, manifest: Manifest): string;
}
