import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { createBus, persistToStore, type Event } from "../src/bus/index.ts";
import { openStore, tables } from "../src/store/index.ts";
import type { AgentScope } from "../src/store/schema.ts";
import { ulid } from "../src/id/index.ts";
import { installGrantScopeExecutor } from "../src/permissions/index.ts";

function rig() {
  const store = openStore({ path: ":memory:" });
  const hostId = ulid();
  store.insert(tables.hosts).values({ id: hostId, hostname: "t", createdAt: Date.now() }).run();
  const bus = createBus({ hostId, persist: persistToStore(store) });
  const exec = installGrantScopeExecutor({ bus, store, hostId });
  function seedAgent(id: string, scope: AgentScope, ownsMoney = false): void {
    store
      .insert(tables.agents)
      .values({ id, name: id, hostId, scope, channels: [], ownsMoney, createdAt: Date.now() })
      .run();
  }
  function scopeOf(id: string): AgentScope {
    return (
      store.select({ scope: tables.agents.scope }).from(tables.agents).where(eq(tables.agents.id, id)).all()[0]
        ?.scope ?? {}
    );
  }
  function resolve(
    status: string,
    inner: Record<string, unknown>,
    ownerAgentId: string,
  ): void {
    bus.publish({
      type: "decision.resolved",
      hostId,
      actorId: ownerAgentId,
      durable: true,
      payload: { decisionId: ulid(), status, ownerAgentId, payload: inner },
    });
  }
  return { store, bus, hostId, exec, seedAgent, scopeOf, resolve };
}

describe("grant_scope executor", () => {
  it("merges the granted {tool, tier} into the target scope on approve and emits scope.granted", () => {
    const { seedAgent, scopeOf, resolve, bus } = rig();
    const approver = ulid();
    const target = ulid();
    seedAgent(approver, { allowTiers: ["operational", "strategic", "vision"] }, true);
    seedAgent(target, { allowTools: ["memory_search"] });
    const granted: Event[] = [];
    bus.subscribe("scope.granted", (e) => void granted.push(e));

    resolve(
      "approved",
      { action: "grant_scope", agentId: target, tool: "discord_send", tier: "strategic" },
      approver,
    );

    const scope = scopeOf(target);
    expect(scope.allowTools).toEqual(["memory_search", "discord_send"]);
    expect(granted).toHaveLength(1);
    expect((granted[0]!.payload as { tool: string }).tool).toBe("discord_send");
  });

  it("rejects a grant that exceeds the approver's authority without mutating scope", () => {
    const { seedAgent, scopeOf, resolve, bus } = rig();
    const approver = ulid();
    const target = ulid();
    // Approver may only grant operational — a strategic grant exceeds authority.
    seedAgent(approver, { allowTiers: ["operational"] }, true);
    seedAgent(target, { allowTools: ["memory_search"] });
    const rejected: Event[] = [];
    const granted: Event[] = [];
    bus.subscribe("scope.grant-rejected", (e) => void rejected.push(e));
    bus.subscribe("scope.granted", (e) => void granted.push(e));

    resolve(
      "approved",
      { action: "grant_scope", agentId: target, tool: "discord_send", tier: "strategic" },
      approver,
    );

    expect(rejected).toHaveLength(1);
    expect(granted).toHaveLength(0);
    // Scope untouched.
    expect(scopeOf(target).allowTools).toEqual(["memory_search"]);
  });

  it("acts on a modified resolution using the overridden payload", () => {
    const { seedAgent, scopeOf, resolve } = rig();
    const approver = ulid();
    const target = ulid();
    seedAgent(approver, { allowTiers: ["operational", "strategic", "vision"] }, true);
    seedAgent(target, { allowTools: ["memory_search"] });

    // The principal modified the proposal to grant a different tool.
    resolve(
      "modified",
      { action: "grant_scope", agentId: target, tool: "telegram_send", tier: "operational" },
      approver,
    );

    expect(scopeOf(target).allowTools).toEqual(["memory_search", "telegram_send"]);
  });

  it("is a no-op on a denied resolution", () => {
    const { seedAgent, scopeOf, resolve, bus } = rig();
    const approver = ulid();
    const target = ulid();
    seedAgent(approver, { allowTiers: ["operational", "strategic", "vision"] }, true);
    seedAgent(target, { allowTools: ["memory_search"] });
    const touched: Event[] = [];
    bus.subscribe("scope.granted", (e) => void touched.push(e));
    bus.subscribe("scope.grant-rejected", (e) => void touched.push(e));

    resolve(
      "denied",
      { action: "grant_scope", agentId: target, tool: "discord_send", tier: "strategic" },
      approver,
    );

    expect(touched).toHaveLength(0);
    expect(scopeOf(target).allowTools).toEqual(["memory_search"]);
  });
});
