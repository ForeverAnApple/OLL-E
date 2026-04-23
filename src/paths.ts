import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

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
  readonly sessionsDir: string;
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
    sessionsDir: join(root, "sessions"),
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
    paths.sessionsDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }
}
