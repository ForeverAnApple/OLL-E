// Inviter-side WebSocket server. Accepts inbound peer connections after
// invite codes have been distributed; the first envelope on each socket
// is the `hello` from the joiner. We verify it against the team secret,
// then hand control to the bridge via `onPeerHello` — the listener owns
// no peer table of its own.
//
// The bridge sets `onEnvelope` / `onClose` synchronously inside its
// `onPeerHello` callback by mutating the params object. Simple, no
// promise dance, and the contract is one call site.
//
// Address advertised: OLLE_ADVERTISE_ADDR if set, else
// ws://<hostname>:<port>. v0 LAN-only; multi-NIC hosts override via env.

import { hostname as osHostname } from "node:os";
import type { ServerWebSocket } from "bun";
import {
  decodeEnvelope,
  encodeEnvelope,
  MeshEnvelopeError,
  verifyEnvelope,
  type MeshEnvelope,
} from "./envelope.ts";

export interface ListenerHelloParams {
  teamId: string;
  fromHostId: string;
  /** Raw payload of the hello envelope. Carries optional `inviteId` on
   *  first-join hellos so the bridge can validate single-use against
   *  `team_invites`. Subsequent reconnect hellos from PeerLink have no
   *  inviteId; only the bridge layer knows which case to enforce. */
  helloPayload: Record<string, unknown>;
  /** Send any envelope (welcome, etc.) back over this inbound socket. */
  respond: (env: MeshEnvelope) => void;
  /** Bridge sets this to receive subsequent verified envelopes. */
  onEnvelope: (env: MeshEnvelope) => void;
  /** Bridge sets this to learn when the socket goes away. */
  onClose: () => void;
  /** Bridge sets this true synchronously inside onPeerHello to reject
   *  the connection (e.g. invite already redeemed). The listener closes
   *  the socket and drops onEnvelope/onClose bookkeeping. */
  reject?: boolean;
}

export interface ListenerOptions {
  hostId: string;
  port: number;
  /** teamId → shared secret. Bridge mutates the map as teams come/go. */
  teamSecrets: Map<string, string>;
  /** Called once per inbound socket after a verified hello.
   *  The bridge MUST replace `params.onEnvelope` / `params.onClose`
   *  inside this call so subsequent envelopes route correctly. */
  onPeerHello: (params: ListenerHelloParams) => void;
}

export interface Listener {
  readonly addr: string;
  readonly port: number;
  close(): Promise<void>;
}

interface SocketData {
  state: "awaiting-hello" | "live" | "rejected";
  teamId: string | null;
  fromHostId: string | null;
  onEnvelope: (env: MeshEnvelope) => void;
  onClose: () => void;
}

export async function startListener(opts: ListenerOptions): Promise<Listener> {
  const advertiseHost = process.env.OLLE_ADVERTISE_ADDR ?? `ws://${osHostname()}`;

  const server = Bun.serve<SocketData, never>({
    port: opts.port,
    hostname: "0.0.0.0",
    fetch(req, srv) {
      const upgraded = srv.upgrade(req, {
        data: {
          state: "awaiting-hello",
          teamId: null,
          fromHostId: null,
          onEnvelope: () => {},
          onClose: () => {},
        } satisfies SocketData,
      });
      if (upgraded) return undefined;
      return new Response("expected websocket upgrade", { status: 426 });
    },
    websocket: {
      open(_ws) {
        // wait for hello
      },
      message(ws: ServerWebSocket<SocketData>, msg) {
        if (ws.data.state === "rejected") return;
        let raw: string;
        if (typeof msg === "string") raw = msg;
        else if (msg instanceof Buffer) raw = msg.toString("utf8");
        else raw = new TextDecoder().decode(msg);

        let env: MeshEnvelope;
        try {
          env = decodeEnvelope(raw);
        } catch (err) {
          if (!(err instanceof MeshEnvelopeError)) throw err;
          // eslint-disable-next-line no-console -- mesh is infra
          console.warn("[mesh/listener] decode failed:", err.message);
          ws.data.state = "rejected";
          ws.close();
          return;
        }

        if (ws.data.state === "awaiting-hello") {
          if (env.kind !== "hello") {
            // eslint-disable-next-line no-console -- mesh is infra
            console.warn(
              `[mesh/listener] first envelope kind ${env.kind}; expected hello — closing`,
            );
            ws.data.state = "rejected";
            ws.close();
            return;
          }
          const secret = opts.teamSecrets.get(env.teamId);
          if (!secret) {
            // eslint-disable-next-line no-console -- mesh is infra
            console.warn(
              `[mesh/listener] hello for unknown team ${env.teamId}; closing`,
            );
            ws.data.state = "rejected";
            ws.close();
            return;
          }
          if (!verifyEnvelope(env, secret)) {
            // eslint-disable-next-line no-console -- mesh is infra
            console.warn("[mesh/listener] hello HMAC verify failed; closing");
            ws.data.state = "rejected";
            ws.close();
            return;
          }
          ws.data.teamId = env.teamId;
          ws.data.fromHostId = env.fromHostId;

          const respond = (out: MeshEnvelope) => {
            try {
              ws.send(encodeEnvelope(out));
            } catch (err) {
              // eslint-disable-next-line no-console -- mesh is infra
              console.error("[mesh/listener] respond send threw:", err);
            }
          };

          const params: ListenerHelloParams = {
            teamId: env.teamId,
            fromHostId: env.fromHostId,
            helloPayload: (env as { payload?: Record<string, unknown> }).payload ?? {},
            respond,
            onEnvelope: () => {},
            onClose: () => {},
          };
          try {
            opts.onPeerHello(params);
          } catch (err) {
            // eslint-disable-next-line no-console -- mesh is infra
            console.error("[mesh/listener] onPeerHello threw:", err);
            ws.data.state = "rejected";
            ws.close();
            return;
          }
          if (params.reject) {
            ws.data.state = "rejected";
            ws.close();
            return;
          }
          ws.data.onEnvelope = params.onEnvelope;
          ws.data.onClose = params.onClose;
          ws.data.state = "live";
          return;
        }

        // Live state
        if (ws.data.teamId !== env.teamId) {
          // eslint-disable-next-line no-console -- mesh is infra
          console.warn(
            `[mesh/listener] envelope team ${env.teamId} mismatch on live socket team ${ws.data.teamId}; dropping`,
          );
          return;
        }
        const secret = opts.teamSecrets.get(env.teamId);
        if (!secret) {
          // eslint-disable-next-line no-console -- mesh is infra
          console.warn(
            `[mesh/listener] envelope for now-unknown team ${env.teamId}; closing`,
          );
          ws.data.state = "rejected";
          ws.close();
          return;
        }
        if (!verifyEnvelope(env, secret)) {
          // eslint-disable-next-line no-console -- mesh is infra
          console.warn("[mesh/listener] envelope HMAC verify failed; closing");
          ws.data.state = "rejected";
          ws.close();
          return;
        }
        try {
          ws.data.onEnvelope(env);
        } catch (err) {
          // eslint-disable-next-line no-console -- mesh is infra
          console.error("[mesh/listener] onEnvelope threw:", err);
        }
      },
      close(ws: ServerWebSocket<SocketData>) {
        try {
          ws.data.onClose();
        } catch (err) {
          // eslint-disable-next-line no-console -- mesh is infra
          console.error("[mesh/listener] onClose threw:", err);
        }
      },
    },
  });

  const port = server.port;
  if (port === undefined) {
    throw new Error("[mesh/listener] server has no port — unix-socket mode unsupported");
  }
  const addr = `${advertiseHost.replace(/\/$/, "")}:${port}`;

  return {
    addr,
    port,
    async close() {
      server.stop(true);
    },
  };
}
