import type { ExtensionHost } from "../extensions/index.ts";

export interface FaultIsolationOptions {
  host: ExtensionHost;
  /** Sink for unattributed errors. Defaults to console.error. Tests pass a
   *  capture so they can assert on the message. */
  log?: (msg: string, err: unknown) => void;
}

export interface FaultIsolation {
  uninstall(): void;
}

/** Install process-level guards so a throw from extension code (timer
 *  callback, microtask, naked promise) routes into the existing circuit
 *  breaker on ExtensionHost instead of terminating the daemon.
 *
 *  Architecture says crashed extensions auto-disable; the breaker that
 *  implements that already exists at host.reportFailure(). The piece this
 *  module supplies is the missing wire from "Node would otherwise call
 *  process.exit(1)" to "host.reportFailure()". Unattributed errors are
 *  logged loudly and dropped — never fatal. The daemon stays up. */
export function installFaultIsolation(opts: FaultIsolationOptions): FaultIsolation {
  const { host } = opts;
  const log = opts.log ?? defaultLog;

  const handler = (err: unknown): void => route(err, host, log);

  process.on("uncaughtException", handler);
  process.on("unhandledRejection", handler);

  return {
    uninstall(): void {
      process.off("uncaughtException", handler);
      process.off("unhandledRejection", handler);
    },
  };
}

function route(err: unknown, host: ExtensionHost, log: NonNullable<FaultIsolationOptions["log"]>): void {
  const name = host.attribute(err);
  if (name) {
    host.reportFailure(name, err);
    return;
  }
  log(`olle: unattributed daemon error: ${formatError(err)}`, err);
}

function defaultLog(msg: string, err: unknown): void {
  console.error(msg);
  if (err && typeof err === "object" && "stack" in err) {
    console.error((err as { stack?: string }).stack);
  }
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
