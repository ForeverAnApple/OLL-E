import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, lstatSync, mkdirSync } from "node:fs";

export interface OllePaths {
  readonly root: string;
  readonly dbFile: string;
  readonly configFile: string;
  readonly extensionsDir: string;
  readonly goalsDir: string;
  readonly memoryDir: string;
  readonly logsDir: string;
  readonly logFile: string;
  readonly runDir: string;
  readonly socketFile: string;
  readonly pidFile: string;
  readonly secretsDir: string;
  /** Single-line text file holding the host's currently-selected default
   *  model (e.g. "gpt-5.5", "claude-opus-4-7"). Daemon reads on boot and
   *  on `model.set` events; CLI/chat write via IPC. Absent file →
   *  hard-coded boot default. Chosen over config.toml so no TOML parser
   *  is needed; over a memory row so chat bringup doesn't depend on the
   *  projector having caught up. */
  readonly defaultModelFile: string;
  /** Per-agent, per-thread message-history snapshots. Was `sessionsDir`
   *  in the chat-only era — renamed when every agent became a mailbox. */
  readonly threadsDir: string;
}

export function resolvePaths(rootOverride?: string): OllePaths {
  const root =
    rootOverride ?? process.env.OLLE_HOME ?? join(homedir(), ".olle");
  return {
    root,
    dbFile: join(root, "olle.db"),
    configFile: join(root, "config.toml"),
    extensionsDir: join(root, "extensions"),
    goalsDir: join(root, "goals"),
    memoryDir: join(root, "memory"),
    logsDir: join(root, "logs"),
    logFile: join(root, "logs", "olle.log"),
    runDir: join(root, "run"),
    socketFile: join(root, "run", "olle.sock"),
    pidFile: join(root, "run", "olle.pid"),
    secretsDir: join(root, "secrets"),
    defaultModelFile: join(root, "default_model"),
    threadsDir: join(root, "threads"),
  };
}

export function ensurePaths(paths: OllePaths): void {
  for (const dir of [
    paths.root,
    paths.extensionsDir,
    paths.goalsDir,
    paths.memoryDir,
    paths.logsDir,
    paths.runDir,
    paths.secretsDir,
    paths.threadsDir,
  ]) {
    ensurePrivateDir(dir);
  }
}

function ensurePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory()) {
    throw new Error(`paths: ${dir} exists but is not a directory`);
  }
  if (st.isSymbolicLink()) {
    throw new Error(`paths: ${dir} must not be a symlink`);
  }
  chmodSync(dir, 0o700);
}
