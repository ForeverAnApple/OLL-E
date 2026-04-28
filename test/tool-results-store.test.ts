import { describe, expect, it } from "bun:test";
import { openStore } from "../src/store/index.ts";
import { createToolResultStore } from "../src/store/tool-results.ts";
import { buildToolResultTools } from "../src/tools/tool-results.ts";

function fresh() {
  const store = openStore({ path: ":memory:" });
  // tool_results.host_id has an FK to hosts; seed a row so persist() works.
  store.raw.exec(
    `INSERT INTO hosts (id, hostname, created_at) VALUES ('h', 'localhost', 0)`,
  );
  return store;
}

describe("tool result store", () => {
  it("persists and reads back full content", () => {
    const store = fresh();
    const trs = createToolResultStore({ db: store.raw, hostId: "h" });
    trs.persist({
      id: "tu1",
      threadId: "th1",
      actorId: "agent",
      hostId: "h",
      toolName: "fat",
      content: "abcdef".repeat(1000),
    });
    const r = trs.read("tu1");
    expect(r).not.toBeNull();
    expect(r!.totalBytes).toBe(6000);
    expect(r!.content.length).toBe(6000);
    expect(r!.meta.toolName).toBe("fat");
    expect(r!.hasMore).toBe(false);
  });

  it("slices with offset + limit and reports hasMore", () => {
    const store = fresh();
    const trs = createToolResultStore({ db: store.raw, hostId: "h" });
    trs.persist({
      id: "tu1",
      threadId: "th1",
      actorId: "agent",
      hostId: "h",
      toolName: "fat",
      content: "0123456789".repeat(100),
    });
    const r = trs.read("tu1", { offset: 50, limit: 100 });
    expect(r!.offset).toBe(50);
    expect(r!.content.length).toBe(100);
    expect(r!.hasMore).toBe(true);
    const tail = trs.read("tu1", { offset: 950, limit: 100 });
    expect(tail!.content.length).toBe(50);
    expect(tail!.hasMore).toBe(false);
  });

  it("INSERT OR IGNORE on duplicate id (idempotent under replay)", () => {
    const store = fresh();
    const trs = createToolResultStore({ db: store.raw, hostId: "h" });
    trs.persist({
      id: "tu1",
      threadId: "th1",
      actorId: "agent",
      hostId: "h",
      toolName: "fat",
      content: "first",
    });
    trs.persist({
      id: "tu1",
      threadId: "th1",
      actorId: "agent",
      hostId: "h",
      toolName: "fat",
      content: "second",
    });
    const r = trs.read("tu1");
    expect(r!.content).toBe("first");
  });

  it("returns null for unknown handles", () => {
    const store = fresh();
    const trs = createToolResultStore({ db: store.raw, hostId: "h" });
    expect(trs.read("nope")).toBeNull();
  });

  it("read_tool_result tool clamps oversize requests and reports nextOffset", async () => {
    const store = fresh();
    const trs = createToolResultStore({ db: store.raw, hostId: "h" });
    trs.persist({
      id: "tu1",
      threadId: "th1",
      actorId: "agent",
      hostId: "h",
      toolName: "fat",
      content: "Z".repeat(200_000),
    });
    const [tool] = buildToolResultTools({ store: trs, maxSliceBytes: 10_000 });
    const ctx = {
      hostId: "h",
      extensionId: "core",
      actorId: "agent",
      abort: new AbortController().signal,
      secrets: {},
    };
    const out = (await tool!.execute(
      { handle: "tool-result/tu1", offset: 0, limit: 1_000_000 },
      ctx,
    )) as Record<string, unknown>;
    expect(out.totalBytes).toBe(200_000);
    expect(out.returnedBytes).toBe(10_000);
    expect(out.hasMore).toBe(true);
    expect(out.nextOffset).toBe(10_000);
  });

  it("read_tool_result accepts the bare id without prefix", async () => {
    const store = fresh();
    const trs = createToolResultStore({ db: store.raw, hostId: "h" });
    trs.persist({
      id: "tu1",
      threadId: "th1",
      actorId: "agent",
      hostId: "h",
      toolName: "fat",
      content: "hello",
    });
    const [tool] = buildToolResultTools({ store: trs });
    const ctx = {
      hostId: "h",
      extensionId: "core",
      actorId: "agent",
      abort: new AbortController().signal,
      secrets: {},
    };
    const out = (await tool!.execute({ handle: "tu1" }, ctx)) as Record<string, unknown>;
    expect(out.content).toBe("hello");
  });
});
