// Entry for the Ink-based chat REPL. Owns initial IPC bringup +
// metadata fetch, then hands ownership of the connection lifecycle to
// <ChatApp> (which reconnects on its own).

import { render } from "ink";
import { resolvePaths } from "../../paths.ts";
import { connectOrExit } from "../ipc-helper.ts";
import { ChatApp } from "./app.tsx";
import { mintThreadId } from "./ids.ts";
import type { AgentSelf } from "../../observability/index.ts";

export async function runInkChat(): Promise<void> {
  const paths = resolvePaths();
  const client = await connectOrExit(paths.socketFile);

  // rootAgentId blocks observability.self below; everything else is
  // independent so fire them in parallel.
  const [{ rootAgentId }, chatStatus, inboxOpen, initialModel] = await Promise.all([
    client.call<{ rootAgentId: string }>("status.rootAgent"),
    client
      .call<{ enabled: boolean; reason: string | null }>("status.chat")
      .catch(() => ({ enabled: true, reason: null as string | null })),
    client
      .call<{ open: number }>("inbox.count")
      .then((r) => r.open)
      .catch(() => 0),
    client
      .call<{ model: string }>("model.get")
      .then((r) => r.model)
      .catch(() => ""),
  ]);
  if (!chatStatus.enabled) {
    client.close();
    console.error(`olle chat: chat agent is disabled\n  ${chatStatus.reason ?? "chat loop not running"}`);
    process.exit(1);
  }
  const self = await client
    .call<AgentSelf | null>("observability.self", { agentId: rootAgentId })
    .catch(() => null);
  const agentName =
    self?.displayName?.trim() || self?.name?.trim() || "agent";
  // `model.get` is the daemon's effective-model truth: the thinking-model
  // memory clamped to the live backend, else the backend's own default
  // (OpenAI router, CLI brain — not a hardcoded Anthropic name). Prefer it;
  // self.thinkingModel is the same resolution delivered through
  // observability.self, kept only as the fallback when model.get fails.
  const headerModel = initialModel || self?.thinkingModel?.trim() || "";
  const initialThreadId = mintThreadId();

  const app = render(
    <ChatApp
      client={client}
      socketFile={paths.socketFile}
      agentId={rootAgentId}
      agentName={agentName}
      initialThreadId={initialThreadId}
      initialModel={headerModel}
      initialEffort={self?.reasoningEffort ?? ""}
      inboxOpen={inboxOpen}
    />,
    { exitOnCtrlC: false },  // we handle Ctrl-C inside the app (two-tap quit + cancel-turn)
  );

  await app.waitUntilExit();
  // ChatApp owns the connection lifecycle (it may have rebuilt the
  // client across reconnects). Closing the prop-supplied one here would
  // be a no-op on the current connection — leave it to the app's
  // teardown path.
}
