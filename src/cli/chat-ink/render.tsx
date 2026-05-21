// Entry for the Ink-based chat REPL. Owns IPC bringup, fetches the
// daemon-side metadata cmdChat used to fetch, then mounts <ChatApp>.

import { render } from "ink";
import { resolvePaths } from "../../paths.ts";
import { connectOrExit } from "../ipc-helper.ts";
import { ChatApp } from "./app.tsx";
import { mintId } from "./ids.ts";
import type { AgentSelf } from "../../observability/index.ts";

export async function runInkChat(): Promise<void> {
  const paths = resolvePaths();
  const client = await connectOrExit(paths.socketFile);

  const { rootAgentId } = await client.call<{ rootAgentId: string }>("status.rootAgent");
  const chatStatus = await client
    .call<{ enabled: boolean; reason: string | null }>("status.chat")
    .catch(() => ({ enabled: true, reason: null as string | null }));
  if (!chatStatus.enabled) {
    client.close();
    console.error(`olle chat-ink: chat agent is disabled\n  ${chatStatus.reason ?? "chat loop not running"}`);
    process.exit(1);
  }
  const self = await client
    .call<AgentSelf | null>("observability.self", { agentId: rootAgentId })
    .catch(() => null);
  const agentName =
    self?.displayName?.trim() || self?.name?.trim() || "agent";
  const inboxOpen = await client
    .call<{ open: number }>("inbox.count")
    .then((r) => r.open)
    .catch(() => 0);
  const initialModel = await client
    .call<{ model: string }>("model.get")
    .then((r) => r.model)
    .catch(() => "");
  const initialThreadId = mintId("cli:");

  const app = render(
    <ChatApp
      client={client}
      agentId={rootAgentId}
      agentName={agentName}
      initialThreadId={initialThreadId}
      initialModel={initialModel}
      inboxOpen={inboxOpen}
    />,
    { exitOnCtrlC: false },  // we handle Ctrl-C inside the app (two-tap quit + cancel-turn)
  );

  await app.waitUntilExit();
  try { client.close(); } catch { /* already closed */ }
}
