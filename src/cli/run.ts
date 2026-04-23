import { startDaemon } from "../daemon/daemon.ts";
import { resolvePaths } from "../paths.ts";
import { connectIpc } from "../ipc/client.ts";

export async function runCli(args: string[]): Promise<void> {
  const [cmd, ...rest] = args;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;
    case "version":
    case "--version":
    case "-v":
      console.log("olle 0.0.0");
      return;
    case "run":
      await cmdRun();
      return;
    case "status":
      await cmdStatus();
      return;
    case "tail":
      await cmdTail(rest);
      return;
    case "publish":
      await cmdPublish(rest);
      return;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exit(2);
  }
}

async function cmdRun(): Promise<void> {
  const daemon = await startDaemon({ version: "0.0.0" });
  const stop = async (sig: NodeJS.Signals) => {
    console.log(`\nolle: received ${sig}, shutting down`);
    await daemon.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Park the main task — IPC server keeps the loop alive.
  await new Promise<void>(() => {});
}

async function cmdStatus(): Promise<void> {
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile).catch((e) => {
    console.error(`olle: daemon not reachable (${e.message})`);
    process.exit(1);
  });
  const value = await client.call<{ hostId: string; pid: number; uptimeMs: number }>("status");
  client.close();
  console.log(
    `host: ${value.hostId}\npid:  ${value.pid}\nup:   ${Math.round(value.uptimeMs / 1000)}s`,
  );
}

async function cmdTail(args: string[]): Promise<void> {
  const type = args[0] ?? "*";
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  const sub = client.stream("tail", { type });
  const stop = () => {
    void sub.cancel().then(() => {
      client.close();
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  for await (const ev of sub.events) {
    console.log(
      `${ev.hlc} ${ev.type} actor=${ev.actorId} payload=${JSON.stringify(ev.payload)}`,
    );
  }
}

async function cmdPublish(args: string[]): Promise<void> {
  const [type, ...rest] = args;
  if (!type) {
    console.error("usage: olle publish <type> [json-payload]");
    process.exit(2);
  }
  const payload = rest.length ? JSON.parse(rest.join(" ")) : {};
  const paths = resolvePaths();
  const client = await connectIpc(paths.socketFile);
  const res = await client.call<{ id: string; hlc: string }>("publish", {
    type,
    payload,
    actorId: "cli",
    durable: true,
  });
  client.close();
  console.log(`${res.hlc} ${res.id}`);
}

function printHelp(): void {
  console.log(
    [
      "olle — a world agents love to live in",
      "",
      "Usage: olle <command> [args]",
      "",
      "Commands:",
      "  run                start foreground daemon",
      "  status             show daemon status",
      "  tail [type]        stream events from the daemon (default: all)",
      "  publish <type> [json]   emit a durable event",
      "  version            show version",
      "  help               show this help",
    ].join("\n"),
  );
}
