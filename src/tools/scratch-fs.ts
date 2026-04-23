// Scratch-fs: per-task ephemeral working dir the agent can read/write.
// Scoped under ~/.olle/memory/scratch/<taskId>/. Purged on task completion
// or timeout (v0 purge is manual via clearScratch(); scheduled sweep is v1+).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ToolDef } from "../extensions/types.ts";

export interface ScratchOptions {
  baseDir: string;
  /** Task id scopes the subtree. */
  taskId: string;
}

export function scratchDir(opts: ScratchOptions): string {
  const dir = join(opts.baseDir, opts.taskId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function safeResolve(base: string, rel: string): string {
  const abs = resolve(base, rel);
  const inside = relative(base, abs);
  if (inside.startsWith("..") || resolve(base, inside) !== abs) {
    throw new Error(`scratch-fs: path escapes scratch dir: ${rel}`);
  }
  return abs;
}

export function clearScratch(opts: ScratchOptions): void {
  const dir = join(opts.baseDir, opts.taskId);
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

export function buildScratchTools(opts: ScratchOptions): ToolDef[] {
  const base = scratchDir(opts);

  const readTool: ToolDef<{ path: string }, string> = {
    name: "scratch_read",
    description: "Read a text file from the task's scratch directory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: ({ path }) => readFileSync(safeResolve(base, path), "utf8"),
  };

  const writeTool: ToolDef<{ path: string; content: string }, string> = {
    name: "scratch_write",
    description: "Write a text file into the task's scratch directory; creates parents.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: ({ path, content }) => {
      const abs = safeResolve(base, path);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content, "utf8");
      return `wrote ${content.length} bytes to ${path}`;
    },
  };

  const listTool: ToolDef<{ path?: string }, string[]> = {
    name: "scratch_list",
    description: "List entries in a scratch subdirectory.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      additionalProperties: false,
    },
    execute: ({ path = "." }) => {
      const abs = safeResolve(base, path);
      if (!existsSync(abs)) return [];
      const out: string[] = [];
      for (const name of readdirSync(abs)) {
        const p = join(abs, name);
        const isDir = statSync(p).isDirectory();
        out.push(isDir ? `${name}/` : name);
      }
      return out;
    },
  };

  const deleteTool: ToolDef<{ path: string }, string> = {
    name: "scratch_delete",
    description: "Delete a file or subdir under the task's scratch dir.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    execute: ({ path }) => {
      const abs = safeResolve(base, path);
      rmSync(abs, { recursive: true, force: true });
      return `deleted ${path}`;
    },
  };

  return [readTool, writeTool, listTool, deleteTool];
}
