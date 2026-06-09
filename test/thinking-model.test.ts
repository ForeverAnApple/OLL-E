// Thinking-model preference — the agent switches the model it thinks with,
// the choice persists as a memory, and the daemon resolves it at loop start.

import { describe, expect, it } from "bun:test";
import { createBus, persistToStore } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import { ulid } from "../src/id/index.ts";
import {
  resolveThinkingModel,
  resolveBootModel,
  startMemoryProjector,
  THINKING_MODEL_ROLE,
} from "../src/memory/index.ts";
import { buildModelTools } from "../src/tools/model.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  startMemoryProjector({ bus, store, hostId });
  return { store, bus, hostId };
}

function ctx(actorId: string, hostId: string) {
  return {
    hostId,
    extensionId: actorId,
    actorId,
    abort: new AbortController().signal,
    secrets: {},
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function setTool(tools: ReturnType<typeof buildModelTools>): { execute: (a: any, c: any) => any } {
  const t = tools.find((x) => x.name === "set_thinking_model");
  if (!t) throw new Error("set_thinking_model missing");
  return t as never;
}

describe("set_thinking_model", () => {
  it("persists the choice as a private thinking-model memory, resolvable at loop start", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));

    expect(resolveThinkingModel(r.store, "agent-1")).toBeUndefined();

    await tool.execute(
      { model: "claude-opus-4-8", reason: "principal asked for the newer model" },
      ctx("agent-1", r.hostId),
    );

    expect(resolveThinkingModel(r.store, "agent-1")).toBe("claude-opus-4-8");

    const rows = r.store.select().from(tables.memories).all();
    const row = rows.find((m) => m.role === THINKING_MODEL_ROLE);
    expect(row?.scope).toBe("private");
    expect(row?.actorId).toBe("agent-1");
    expect(row?.bodyMd.split("\n")[0]).toBe("claude-opus-4-8");
    expect(row?.bodyMd).toContain("principal asked");
  });

  it("reuses one canonical row across switches; newest wins", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));

    await tool.execute({ model: "claude-opus-4-8", reason: "first" }, ctx("a", r.hostId));
    await tool.execute({ model: "claude-sonnet-4-6", reason: "cheaper for now" }, ctx("a", r.hostId));

    const rows = r.store
      .select()
      .from(tables.memories)
      .all()
      .filter((m) => m.role === THINKING_MODEL_ROLE && m.actorId === "a");
    expect(rows.length).toBe(1);
    expect(resolveThinkingModel(r.store, "a")).toBe("claude-sonnet-4-6");
  });

  it("rejects an unpriced model — the ledger must never silently lie", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));
    await expect(
      tool.execute({ model: "gpt-9-imaginary", reason: "why not" }, ctx("a", r.hostId)),
    ).rejects.toThrow(/no such priced model/);
    expect(resolveThinkingModel(r.store, "a")).toBeUndefined();
  });

  it("requires a justification — the switch is justified, not gated", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));
    await expect(
      tool.execute({ model: "claude-opus-4-8", reason: "  " }, ctx("a", r.hostId)),
    ).rejects.toThrow(/reason is required/);
  });

  it("resolver ignores a memory whose model lost its posted price", async () => {
    const r = rig();
    // Hand-write a thinking-model memory pointing at an unpriced model
    // (simulates a model retired from pricing.ts after the agent chose it).
    const { MEMORY_WROTE } = await import("../src/memory/index.ts");
    r.bus.publish({
      type: MEMORY_WROTE,
      hostId: r.hostId,
      actorId: "a",
      durable: true,
      payload: {
        id: ulid(),
        actorId: "a",
        scope: "private",
        scopeRef: "a",
        role: THINKING_MODEL_ROLE,
        title: "thinking-model",
        bodyMd: "claude-opus-4-3-retired\n\nold choice",
        tags: [],
        depth: 1,
        authoredBy: null,
        seededFrom: null,
      },
    });
    expect(resolveThinkingModel(r.store, "a")).toBeUndefined();
  });
});

describe("set_thinking_model — provider smoke test", () => {
  it("commits the switch when the probe succeeds", async () => {
    const r = rig();
    const probed: string[] = [];
    const tool = setTool(
      buildModelTools({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        probe: async (m) => {
          probed.push(m);
        },
      }),
    );
    await tool.execute({ model: "claude-opus-4-8", reason: "verified" }, ctx("a", r.hostId));
    expect(probed).toEqual(["claude-opus-4-8"]);
    expect(resolveThinkingModel(r.store, "a")).toBe("claude-opus-4-8");
  });

  it("rejects the switch and writes nothing when the probe throws (priced but unserved)", async () => {
    const r = rig();
    const tool = setTool(
      buildModelTools({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        // claude-sonnet-4-6 is priced, but pretend the provider rejects it.
        probe: async () => {
          throw new Error("model: not_found");
        },
      }),
    );
    await expect(
      tool.execute({ model: "claude-sonnet-4-6", reason: "try" }, ctx("a", r.hostId)),
    ).rejects.toThrow(/could not verify .* not_found/);
    // Nothing committed — the agent can't brick its own loop.
    expect(resolveThinkingModel(r.store, "a")).toBeUndefined();
  });

  it("does not probe the `default` sentinel", async () => {
    const r = rig();
    let probedCount = 0;
    const tool = setTool(
      buildModelTools({
        bus: r.bus,
        store: r.store,
        hostId: r.hostId,
        probe: async () => {
          probedCount++;
        },
      }),
    );
    await tool.execute({ model: "default", reason: "revert" }, ctx("a", r.hostId));
    expect(probedCount).toBe(0);
    expect(resolveThinkingModel(r.store, "a")).toBeUndefined(); // default → no override
  });
});

describe("resolveBootModel — OLLE_MODEL rescue hatch", () => {
  it("override (priced) wins over the memory", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));
    await tool.execute({ model: "claude-sonnet-4-6", reason: "x" }, ctx("a", r.hostId));
    // Memory says sonnet; override forces opus-4-7.
    expect(resolveBootModel(r.store, "a", "claude-opus-4-7")).toBe("claude-opus-4-7");
  });

  it("falls back to memory when no override", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));
    await tool.execute({ model: "claude-sonnet-4-6", reason: "x" }, ctx("a", r.hostId));
    expect(resolveBootModel(r.store, "a", undefined)).toBe("claude-sonnet-4-6");
  });

  it("`default` override forces host default, ignoring the memory", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));
    await tool.execute({ model: "claude-sonnet-4-6", reason: "x" }, ctx("a", r.hostId));
    expect(resolveBootModel(r.store, "a", "default")).toBeUndefined();
  });

  it("an unpriced override is ignored (a typo can't brick the rescue)", async () => {
    const r = rig();
    const tool = setTool(buildModelTools({ bus: r.bus, store: r.store, hostId: r.hostId }));
    await tool.execute({ model: "claude-opus-4-8", reason: "x" }, ctx("a", r.hostId));
    // Garbage override → fall through to the memory.
    expect(resolveBootModel(r.store, "a", "claude-opus-zzz")).toBe("claude-opus-4-8");
  });
});
