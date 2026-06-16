// Model × effort compatibility — the two knobs are chosen independently, so
// an unsupported pair must never brick the loop. Set-time rejects the obvious
// case; the runtime clamp is the safety net for the set-model-after-effort
// sequence and raw memory writes.

import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import { resolveReasoningEffort, startMemoryProjector } from "../src/memory/index.ts";
import { buildModelTools } from "../src/tools/model.ts";
import { buildReasoningTools } from "../src/tools/reasoning.ts";
import { clampEffort, supportsEffort, maxOutputTokens } from "../src/llm/models.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  startMemoryProjector({ bus, store, hostId });
  return { store, bus, hostId };
}

function ctx(actorId: string, hostId: string) {
  return { hostId, extensionId: actorId, actorId, abort: new AbortController().signal, secrets: {} };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tool(tools: any[], name: string): { execute: (a: any, c: any) => any } {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing`);
  return t;
}

describe("model capability table", () => {
  it("gates xhigh/max to Opus, low/medium/high broadly, none for Haiku", () => {
    expect(supportsEffort("claude-opus-4-8", "max")).toBe(true);
    expect(supportsEffort("claude-opus-4-7", "xhigh")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-6", "high")).toBe(true);
    expect(supportsEffort("claude-sonnet-4-6", "max")).toBe(false);
    expect(supportsEffort("claude-haiku-4-5-20251001", "low")).toBe(false);
  });

  it("clamps an unsupported level down to the highest the model runs", () => {
    // Sonnet can't do max/xhigh — falls to high.
    expect(clampEffort("claude-sonnet-4-6", "max")).toBe("high");
    expect(clampEffort("claude-sonnet-4-6", "xhigh")).toBe("high");
    // Haiku has no dial — falls to undefined (no thinking), never a 400.
    expect(clampEffort("claude-haiku-4-5-20251001", "max")).toBeUndefined();
    // Opus runs the requested level unchanged.
    expect(clampEffort("claude-opus-4-8", "max")).toBe("max");
  });

  it("never lets the effort default exceed a cheaper model's output ceiling", () => {
    expect(maxOutputTokens("claude-haiku-4-5-20251001")).toBeLessThanOrEqual(32_000);
  });
});

describe("set_reasoning_effort — model compatibility", () => {
  it("rejects max when the current model can't run it (would 400 every turn)", async () => {
    const r = rig();
    await tool(buildModelTools(r), "set_thinking_model").execute(
      { model: "claude-sonnet-4-6", reason: "cheaper" },
      ctx("a", r.hostId),
    );
    await expect(
      tool(buildReasoningTools(r), "set_reasoning_effort").execute(
        { effort: "max", reason: "deep" },
        ctx("a", r.hostId),
      ),
    ).rejects.toThrow(/isn't supported by your current model/);
  });

  it("allows max on the default (Opus) model", async () => {
    const r = rig();
    const res = await tool(buildReasoningTools(r), "set_reasoning_effort").execute(
      { effort: "max", reason: "deep" },
      ctx("a", r.hostId),
    );
    expect(res.effort).toBe("max");
  });
});

describe("set_thinking_model — warns on effort it can't run; default sentinel reverts", () => {
  it("warns when a switch will clamp the agent's existing effort", async () => {
    const r = rig();
    await tool(buildReasoningTools(r), "set_reasoning_effort").execute(
      { effort: "max", reason: "deep" },
      ctx("a", r.hostId),
    );
    const res = await tool(buildModelTools(r), "set_thinking_model").execute(
      { model: "claude-sonnet-4-6", reason: "cheaper" },
      ctx("a", r.hostId),
    );
    expect(res.note).toMatch(/doesn't support your reasoning-effort/);
  });

  it('"default" reverts to the host default (resolves to undefined)', async () => {
    const r = rig();
    const { resolveThinkingModel } = await import("../src/memory/index.ts");
    await tool(buildModelTools(r), "set_thinking_model").execute(
      { model: "claude-sonnet-4-6", reason: "cheaper" },
      ctx("a", r.hostId),
    );
    expect(resolveThinkingModel(r.store, "a")).toBe("claude-sonnet-4-6");
    const res = await tool(buildModelTools(r), "set_thinking_model").execute(
      { model: "default", reason: "back to default" },
      ctx("a", r.hostId),
    );
    expect(res.note).toMatch(/Reverted to the host default/);
    expect(resolveThinkingModel(r.store, "a")).toBeUndefined();
  });
});

describe("resolveReasoningEffort — stale incompatible memory", () => {
  it("clamps persisted effort against the model that will run the thread", async () => {
    const r = rig();
    await tool(buildReasoningTools(r), "set_reasoning_effort").execute(
      { effort: "max", reason: "deep" },
      ctx("a", r.hostId),
    );

    expect(resolveReasoningEffort(r.store, "a", "claude-opus-4-8")).toBe("max");
    expect(resolveReasoningEffort(r.store, "a", "claude-sonnet-4-6")).toBe("high");
    expect(resolveReasoningEffort(r.store, "a", "claude-haiku-4-5-20251001")).toBeUndefined();
  });
});
