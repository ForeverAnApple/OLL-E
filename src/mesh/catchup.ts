// Catchup-on-reconnect — teams.plan.md Feature D.
//
// Two roles, one module:
//   * Caller side (we reconnected, peer holds events we missed):
//       request() → sends catchup_request{ sinceEventId } → resolves
//       when peer responds with a chunk carrying hasMore=false.
//       Each chunk is fed in through handleChunk() which calls
//       bus.inject(event, {remote:true}) on every event and reports
//       the new watermark via opts.onWatermark.
//
//   * Serve side (peer reconnected to us, we know what they missed):
//       serve() → SQL scans events where json_extract(payload,'$.teamId')
//       matches AND id > sinceEventId, paged at chunkSize. Memory
//       events extra-filtered on scope='team' so we don't leak private
//       writes that happened to ride the bus with a teamId by accident.
//
// `bus.inject`'s in-memory dedup + INSERT OR IGNORE persistence handle
// the overlap between a live event arriving during catchup and the same
// event arriving via a chunk. The watermark advances monotonically;
// store order ends up as event-log union, not delivery race.

import type { EventBus } from "../bus/index.ts";
import type { Event } from "../bus/types.ts";
import type { Store } from "../store/db.ts";
import { ulid } from "../id/index.ts";
import {
  MESH_PROTO,
  signEnvelope,
  type MeshEnvelope,
  type UnsignedEnvelope,
} from "./envelope.ts";
import { validateTeamScope } from "./scope.ts";

const DEFAULT_CHUNK_SIZE = 200;

export interface CatchupOptions {
  store: Store;
  bus: EventBus;
  hostId: string;
  chunkSize?: number;
}

export interface CatchupRequestParams {
  teamId: string;
  peerHostId: string;
  secret: string;
  sinceEventId: string | null;
  send: (env: MeshEnvelope) => void;
  /** Bridge persists this so post-restart resumes pick up where we left off. */
  onWatermark?: (newWatermark: string) => void;
}

/** A `catchup_request` envelope. The envelope union widens `kind` to the
 *  whole MeshPayloadKind set, so we narrow with a manual alias rather
 *  than `Extract` (which collapses to `never`). */
export type CatchupRequestEnvelope = MeshEnvelope & {
  kind: "catchup_request";
  payload: { sinceEventId?: string | null };
};

/** A `catchup_chunk` envelope, similarly hand-narrowed. */
export type CatchupChunkEnvelope = MeshEnvelope & {
  kind: "catchup_chunk";
  payload: { events?: Event[]; hasMore?: boolean };
};

export interface CatchupServeParams {
  teamId: string;
  envelope: CatchupRequestEnvelope;
  secret: string;
  fromHostId: string;
  send: (env: MeshEnvelope) => void;
}

export interface Catchup {
  request(params: CatchupRequestParams): Promise<void>;
  /** Feed inbound catchup_chunk envelopes into the in-flight request.
   *  Returns true if a request was waiting, false if the chunk arrived
   *  out of band (e.g. after cancellation). */
  handleChunk(env: CatchupChunkEnvelope): boolean;
  serve(params: CatchupServeParams): void;
  /** Cancel any in-flight request for a peer (e.g. on link close). */
  cancel(teamId: string, peerHostId: string): void;
}

interface InFlight {
  teamId: string;
  peerHostId: string;
  secret: string;
  watermark: string | null;
  send: (env: MeshEnvelope) => void;
  onWatermark?: (w: string) => void;
  resolve: () => void;
  reject: (err: Error) => void;
}

interface EventRow {
  id: string;
  hlc: string;
  host_id: string;
  actor_id: string;
  type: string;
  payload: string;
  parent_event_id: string | null;
  to_agent_id: string | null;
  thread_id: string | null;
  parent_thread_id: string | null;
  created_at: number;
}

function hydrate(row: EventRow): Event {
  return {
    id: row.id,
    hlc: row.hlc,
    hostId: row.host_id,
    actorId: row.actor_id,
    type: row.type,
    payload: row.payload === null ? null : JSON.parse(row.payload),
    parentEventId: row.parent_event_id ?? undefined,
    toAgentId: row.to_agent_id ?? undefined,
    threadId: row.thread_id ?? undefined,
    parentThreadId: row.parent_thread_id ?? undefined,
    createdAt: row.created_at,
    durable: true,
  };
}

export function createCatchup(opts: CatchupOptions): Catchup {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const inFlight = new Map<string, InFlight>();

  const key = (teamId: string, peerHostId: string) => `${teamId}::${peerHostId}`;

  // Scope rule (plan Feature E): normal team events carry payload.teamId;
  // memory events carry the team in scopeRef (or legacy payload.teamId).
  // Private/scratch memory never leaves this host.
  const stmt = opts.store.raw.prepare(
    `SELECT id, hlc, host_id, actor_id, type, payload, parent_event_id,
            to_agent_id, thread_id, parent_thread_id, created_at
       FROM events
      WHERE (
          (
            type IN ('memory.wrote', 'memory.forgotten')
            AND json_extract(payload, '$.scope') = 'team'
            AND COALESCE(
              json_extract(payload, '$.scopeRef'),
              json_extract(payload, '$.teamId')
            ) = ?
          )
          OR (
            type NOT IN ('memory.wrote', 'memory.forgotten')
            AND json_extract(payload, '$.teamId') = ?
          )
        )
        AND id > ?
      ORDER BY id ASC
      LIMIT ?`,
  );

  function sign(unsigned: UnsignedEnvelope, secret: string): MeshEnvelope {
    const hmac = signEnvelope(unsigned, secret);
    return { ...unsigned, hmac } as MeshEnvelope;
  }

  function sendRequest(state: InFlight): void {
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: ulid(),
      teamId: state.teamId,
      fromHostId: opts.hostId,
      kind: "catchup_request",
      payload: {
        sinceEventId: state.watermark,
      },
      sentAt: Date.now(),
    };
    state.send(sign(unsigned, state.secret));
  }

  function emitScopeViolation(reason: string, detail: Record<string, unknown>): void {
    try {
      opts.bus.publish({
        type: "mesh.scope-violation",
        hostId: opts.hostId,
        actorId: "mesh",
        durable: true,
        payload: { reason, ...detail },
      });
    } catch (err) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.error("[mesh/catchup] failed to emit scope-violation:", err);
    }
  }

  function request(params: CatchupRequestParams): Promise<void> {
    const k = key(params.teamId, params.peerHostId);
    const prior = inFlight.get(k);
    if (prior) {
      prior.reject(new Error("superseded by new catchup request"));
      inFlight.delete(k);
    }
    return new Promise<void>((resolve, reject) => {
      const state: InFlight = {
        teamId: params.teamId,
        peerHostId: params.peerHostId,
        secret: params.secret,
        watermark: params.sinceEventId,
        send: params.send,
        onWatermark: params.onWatermark,
        resolve,
        reject,
      };
      inFlight.set(k, state);
      sendRequest(state);
    });
  }

  function handleChunk(env: CatchupChunkEnvelope): boolean {
    // Find the in-flight by team + sender — envelope.fromHostId is the
    // peer who served us.
    const k = key(env.teamId, env.fromHostId);
    const state = inFlight.get(k);
    if (!state) return false;

    const payload = env.payload as {
      events?: Event[];
      hasMore?: boolean;
    };
    const events = Array.isArray(payload.events) ? payload.events : [];
    let highest = state.watermark;
    for (const ev of events) {
      // Advance over rejected events too. Otherwise an older buggy peer that
      // serves one bad row can trap us requesting the same chunk forever.
      if (highest === null || ev.id > highest) {
        highest = ev.id;
      }
      const scope = validateTeamScope(ev, env.teamId);
      if (!scope.ok) {
        emitScopeViolation(scope.reason, {
          envelopeTeamId: env.teamId,
          payloadTeamId: scope.payloadTeamId,
          scope: scope.scope,
          eventId: ev.id,
          fromHostId: env.fromHostId,
          envelopeKind: env.kind,
        });
        continue;
      }
      try {
        opts.bus.inject(ev, { remote: true });
      } catch (err) {
        // eslint-disable-next-line no-console -- mesh is infra
        console.error("[mesh/catchup] inject failed:", err);
        continue;
      }
    }
    if (highest !== state.watermark && highest !== null) {
      state.watermark = highest;
      state.onWatermark?.(highest);
    }

    if (payload.hasMore) {
      sendRequest(state);
    } else {
      inFlight.delete(k);
      state.resolve();
    }
    return true;
  }

  function serve(params: CatchupServeParams): void {
    const rawSince = (params.envelope.payload as { sinceEventId?: string | null })
      .sinceEventId;
    const since = typeof rawSince === "string" ? rawSince : "";
    let rows: EventRow[];
    try {
      rows = stmt.all(params.teamId, params.teamId, since, chunkSize) as EventRow[];
    } catch (err) {
      // eslint-disable-next-line no-console -- mesh is infra
      console.error("[mesh/catchup] serve query failed:", err);
      rows = [];
    }
    const events = rows.map(hydrate);
    // hasMore iff we hit the chunk boundary; the next request will start
    // strictly after the last id we returned.
    const hasMore = rows.length === chunkSize;
    const unsigned: UnsignedEnvelope = {
      proto: MESH_PROTO,
      envelopeId: ulid(),
      teamId: params.teamId,
      fromHostId: opts.hostId,
      kind: "catchup_chunk",
      payload: {
        events,
        hasMore,
      },
      sentAt: Date.now(),
    };
    params.send(sign(unsigned, params.secret));
  }

  function cancel(teamId: string, peerHostId: string): void {
    const k = key(teamId, peerHostId);
    const state = inFlight.get(k);
    if (!state) return;
    inFlight.delete(k);
    state.reject(new Error("catchup cancelled"));
  }

  return { request, handleChunk, serve, cancel };
}
