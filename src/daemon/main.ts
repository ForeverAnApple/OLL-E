import { startDaemon } from "./daemon.ts";

async function main(): Promise<void> {
  const daemon = await startDaemon({ version: "0.0.0" });

  const stop = async (signal: NodeJS.Signals) => {
    console.log(`\nolle: received ${signal}, shutting down`);
    await daemon.shutdown();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // Keep the event loop alive. The IPC server's handles already do this, but
  // we pin it explicitly so future stubs don't cause an early exit.
  await new Promise<void>(() => {});
}

main().catch((err) => {
  console.error("olle daemon failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
