import { describe, expect, it } from "bun:test";
import { runCli } from "../src/cli/run.ts";

function capture(fn: () => Promise<void> | void) {
  const logs: string[] = [];
  const errs: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(" "));
  console.error = (...a) => errs.push(a.join(" "));
  return Promise.resolve(fn())
    .then(() => ({ logs, errs }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
    });
}

describe("cli", () => {
  it("prints help on no args", async () => {
    const { logs } = await capture(() => runCli([]));
    expect(logs.join("\n")).toContain("Usage: olle");
  });

  it("prints version", async () => {
    const { logs } = await capture(() => runCli(["version"]));
    expect(logs.join("\n")).toMatch(/olle \d/);
  });
});
