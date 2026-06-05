/**
 * Background Process Manager Tool
 *
 * Provides a set of tools for managing persistent background processes,
 * similar to Claude Code's `bg` command. Useful for debugging GUI apps,
 * long-running servers, or any process that needs to stay alive across turns.
 *
 * Tools:
 *   bg_run    - Start a background process
 *   bg_list   - List all background processes
 *   bg_kill   - Stop a background process
 *   bg_logs   - Read output/logs from a background process
 *
 * Usage:
 *   1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 *   2. Run pi with: pi -e ./bg-tool.ts
 *
 * Example flows:
 *   - Start a GUI app to debug: bg_run(name="my-app", command="electron .")
 *   - Check its output: bg_logs(name="my-app", tail=50)
 *   - Kill it when done: bg_kill(name="my-app")
 *   - See what's running: bg_list()
 */

import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, AgentToolResult } from "@earendil-works/pi-coding-agent";

// ─── State ──────────────────────────────────────────────────────────────────

interface BackgroundProcess {
  name: string;
  command: string;
  pid: number;
  cwd: string;
  startTime: number;
  logFile: string;
  process: ReturnType<typeof spawn> | null;
  killed: boolean;
}

interface BgState {
  processes: Record<string, Omit<BackgroundProcess, "process">>;
}

// Get a persistent directory for log files
function getBgDir(): string {
  const base = path.join(os.homedir(), ".pi", "agent", "bg-tools");
  if (!fs.existsSync(base)) {
    fs.mkdirSync(base, { recursive: true });
  }
  return base;
}

// Load persisted state from session entries
function loadState(ctx: ExtensionContext): Record<string, Omit<BackgroundProcess, "process">> {
  const entries = ctx.sessionManager.getBranch();
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].type === "custom" && entries[i].customType === "bg-state") {
      const data = entries[i].data as BgState | undefined;
      if (data?.processes) {
        return data.processes;
      }
    }
  }
  return {};
}

// Persist state to session — uses pi.appendEntry (not ctx)
let saveStateFn: ((processes: Record<string, Omit<BackgroundProcess, "process">>) => void) | null = null;

function setSaveState(appendEntry: (customType: string, data?: unknown) => void): void {
  saveStateFn = (processes: Record<string, Omit<BackgroundProcess, "process">>) => {
    appendEntry("bg-state", { processes });
  };
}

// Create a log file for a background process
function createLogFile(name: string): string {
  const bgDir = getBgDir();
  const safeName = name.replace(/[^a-zA-Z0-9_-]/g, "_");
  const logFile = path.join(bgDir, `${safeName}.log`);
  // Initialize empty log
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, "", "utf8");
  }
  return logFile;
}

// Read tail of a log file
function readLogTail(logFile: string, lines = 100): string {
  if (!fs.existsSync(logFile)) return "(no log file found)";
  try {
    const content = fs.readFileSync(logFile, "utf8");
    const linesArr = content.split("\n");
    const tail = linesArr.slice(-lines).join("\n");
    return tail || "(no output yet)";
  } catch {
    return "(error reading log file)";
  }
}

// ─── Tool Definitions ──────────────────────────────────────────────────────

const BG_RUN_PARAMS = Type.Object({
  name: Type.String({
    description: "A unique name for this background process (e.g., 'my-app', 'dev-server')",
    minLength: 1,
    maxLength: 64,
  }),
  command: Type.String({
    description: "The shell command to run in the background (e.g., 'electron .', 'npm run dev')",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the command. Defaults to the session's cwd.",
    }),
  ),
});

const BG_LIST_PARAMS = Type.Object({});

const BG_KILL_PARAMS = Type.Object({
  name: Type.String({
    description: "The name of the background process to stop",
    minLength: 1,
    maxLength: 64,
  }),
});

const BG_LOGS_PARAMS = Type.Object({
  name: Type.String({
    description: "The name of the background process to read logs from",
    minLength: 1,
    maxLength: 64,
  }),
  tail: Type.Optional(
    Type.Number({
      description: "Number of lines to read from the end of the log (default: 100)",
      minimum: 1,
      maximum: 10000,
    }),
  ),
});

// ─── Extension ──────────────────────────────────────────────────────────────

export default function bgToolExtension(pi: ExtensionAPI) {
  // In-memory process map — rebuilt from state on each session start
  let processes: Map<string, BackgroundProcess> = new Map();

  // Capture appendEntry from pi for state persistence
  setSaveState(pi.appendEntry.bind(pi));

  // Restore processes from state on session start
  pi.on("session_start", (_event, ctx) => {
    const saved = loadState(ctx);
    processes = new Map();
    for (const [name, meta] of Object.entries(saved)) {
      processes.set(name, {
        ...meta,
        process: null, // Can't restore actual process handles — they were from a previous session
        killed: meta.killed || false,
      });
    }
  });

  // ── bg_run ──────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_run",
    label: "Run Background Process",
    description:
      "Start a long-running process in the background. The process runs independently and its stdout/stderr are captured to a log file. Useful for debugging GUI apps, running dev servers, or any persistent process. Returns the PID and log file path.",
    promptSnippet: "Start a persistent background process and capture its output to a log file.",
    promptGuidelines: [
      "Use bg_run when you need a process to stay alive across multiple turns.",
      "Give processes meaningful names so you can reference them later.",
      "Use bg_logs to check output and bg_kill to stop when done.",
    ],
    parameters: BG_RUN_PARAMS,
    execute: async (
      _toolCallId: string,
      params: { name: string; command: string; cwd?: string },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> => {
      const existing = processes.get(params.name);
      if (existing && !existing.killed) {
        return {
          content: [
            {
              type: "text",
              text: `Process "${params.name}" is already running (PID: ${existing.pid}). Use bg_kill first to stop it.`,
            },
          ],
          details: { tool: "bg_run", error: "already_running" },
        };
      }

      const cwd = params.cwd || ctx.cwd;
      const logFile = createLogFile(params.name);

      // Spawn the process
      const proc = spawn(params.command, [], {
        shell: true,
        cwd,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      });

      const logStream = fs.createWriteStream(logFile, { flags: "a" });

      proc.stdout.on("data", (data: Buffer) => {
        logStream.write(data);
      });

      proc.stderr.on("data", (data: Buffer) => {
        logStream.write(data);
      });

      proc.on("exit", (code, signal) => {
        logStream.write(`\n[Process exited: code=${code}, signal=${signal}]\n`);
        logStream.end();
        const p = processes.get(params.name);
        if (p) {
          p.killed = true;
          p.process = null;
          saveStateFn!(Object.fromEntries(processes));
        }
      });

      proc.on("error", (err) => {
        logStream.write(`\n[Process error: ${err.message}]\n`);
        logStream.end();
      });

      const bgProc: BackgroundProcess = {
        name: params.name,
        command: params.command,
        pid: proc.pid!,
        cwd,
        startTime: Date.now(),
        logFile,
        process: proc,
        killed: false,
      };

      processes.set(params.name, bgProc);
      saveStateFn!(Object.fromEntries(processes));

      const uptime = formatUptime(Date.now() - bgProc.startTime);

      return {
        content: [
          {
            type: "text",
            text: `✅ Background process "${params.name}" started.\n` +
              `   PID: ${bgProc.pid}\n` +
              `   Command: ${params.command}\n` +
              `   Working dir: ${cwd}\n` +
              `   Log file: ${logFile}\n` +
              `   Uptime: ${uptime}\n\n` +
              `Use \`bg_logs(name="${params.name}")\` to check output,\n` +
              `or \`bg_kill(name="${params.name}")\` to stop it.`,
          },
        ],
        details: { tool: "bg_run", pid: bgProc.pid, logFile },
      };
    },
  });

  // ── bg_list ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_list",
    label: "List Background Processes",
    description:
      "List all currently running background processes managed by this tool. Shows name, PID, command, uptime, and status.",
    promptSnippet: "List all active background processes.",
    parameters: BG_LIST_PARAMS,
    execute: async (
      _toolCallId: string,
      _params: {},
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> => {
      const running: BackgroundProcess[] = [];
      for (const [, p] of processes) {
        if (!p.killed) {
          // Check if process is still alive
          try {
            process.kill(p.pid, 0);
            running.push(p);
          } catch {
            // Process is dead
            p.killed = true;
            p.process = null;
            saveStateFn!(Object.fromEntries(processes));
          }
        }
      }

      if (running.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No background processes are currently running.\n\nStart one with \`bg_run(name=\"my-app\", command=\"...\")\`.",
            },
          ],
          details: { tool: "bg_list", count: 0 },
        };
      }

      let output = `📋 ${running.length} background process(es):\n\n`;
      for (const p of running) {
        const uptime = formatUptime(Date.now() - p.startTime);
        output += `  🟢 ${p.name}\n` +
          `     PID: ${p.pid}\n` +
          `     Command: ${p.command}\n` +
          `     Uptime: ${uptime}\n` +
          `     Log: ${p.logFile}\n\n`;
      }

      output += `Use \`bg_logs(name="...")\` to check output, or \`bg_kill(name="...")\` to stop.`;

      return {
        content: [{ type: "text", text: output }],
        details: { tool: "bg_list", count: running.length },
      };
    },
  });

  // ── bg_kill ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_kill",
    label: "Kill Background Process",
    description:
      "Stop a running background process by name. Sends SIGTERM to the process. If the process doesn't respond, use a second call with force=true to send SIGKILL.",
    promptSnippet: "Stop a background process that was started with bg_run.",
    parameters: Type.Object({
      name: Type.String({
        description: "The name of the background process to stop",
        minLength: 1,
        maxLength: 64,
      }),
      force: Type.Optional(
        Type.Boolean({
          description: "If true, send SIGKILL instead of SIGTERM (use if process doesn't respond to SIGTERM)",
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { name: string; force?: boolean },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<AgentToolResult> => {
      const proc = processes.get(params.name);
      if (!proc || proc.killed) {
        return {
          content: [
            {
              type: "text",
              text: `Process "${params.name}" is not running (or doesn't exist).`,
            },
          ],
          details: { tool: "bg_kill", error: "not_found" },
        };
      }

      try {
        const signal = params.force ? "SIGKILL" : "SIGTERM";
        process.kill(proc.pid, signal as NodeJS.Signals);
        proc.killed = true;
        proc.process = null;
        saveStateFn!(Object.fromEntries(processes));

        return {
          content: [
            {
              type: "text",
              text: `🛑 Process "${params.name}" (PID: ${proc.pid}) sent ${signal}.`,
            },
          ],
          details: { tool: "bg_kill", name: params.name, signal },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("no such process") || message.includes("ESRCH")) {
          proc.killed = true;
          proc.process = null;
          saveStateFn!(Object.fromEntries(processes));
          return {
            content: [
              {
                type: "text",
                text: `Process "${params.name}" (PID: ${proc.pid}) is no longer running. Marked as stopped.`,
              },
            ],
            details: { tool: "bg_kill", name: params.name, error: "already_dead" },
          };
        }
        return {
          content: [
            {
              type: "text",
              text: `❌ Failed to kill "${params.name}": ${message}`,
            },
          ],
          details: { tool: "bg_kill", name: params.name, error: "kill_failed" },
        };
      }
    },
  });

  // ── bg_logs ─────────────────────────────────────────────────────────────

  pi.registerTool({
    name: "bg_logs",
    label: "Read Background Process Logs",
    description:
      "Read the captured stdout/stderr output from a background process. The process's output is continuously written to a log file as it runs.",
    promptSnippet: "Check the output/logs of a background process.",
    parameters: BG_LOGS_PARAMS,
    execute: async (
      _toolCallId: string,
      params: { name: string; tail?: number },
      _signal: AbortSignal | undefined,
      _onUpdate: unknown,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult> => {
      const proc = processes.get(params.name);
      const tailLines = params.tail ?? 100;

      if (!proc) {
        return {
          content: [
            {
              type: "text",
              text: `No process named "${params.name}" found.\n\nUse \`bg_list()\` to see all processes.`,
            },
          ],
          details: { tool: "bg_logs", error: "not_found" },
        };
      }

      const logContent = readLogTail(proc.logFile, tailLines);
      const status = proc.killed ? "stopped" : "running";
      const uptime = formatUptime(Date.now() - proc.startTime);

      return {
        content: [
          {
            type: "text",
            text: `📄 Logs for "${params.name}" (${status}, uptime: ${uptime})\n` +
              `───────────────────────────────────────\n` +
              `${logContent}\n` +
              `───────────────────────────────────────\n` +
              `(${tailLines} lines from end of ${proc.logFile})`,
          },
        ],
        details: { tool: "bg_logs", name: params.name, logFile: proc.logFile, status, uptime },
      };
    },
  });

  // ─── /bg Command ────────────────────────────────────────────────────────

  pi.registerCommand("bg", {
  description: "Interactive background process manager",
  handler: async (_args: string, ctx) => {
    if (!ctx.hasUI) {
      ctx.ui.notify("Background manager requires interactive mode", "warning");
      return;
    }

    // Refresh process state
    const saved = loadState(ctx);
    const procMap = new Map<string, Omit<BackgroundProcess, "process">>();
    for (const [name, meta] of Object.entries(saved)) {
      procMap.set(name, meta);
    }

    // Check which are actually alive
    const alive = new Set<string>();
    for (const [name, meta] of procMap) {
      if (!meta.killed) {
        try {
          process.kill(meta.pid, 0);
          alive.add(name);
        } catch {
          meta.killed = true;
        }
      }
    }
    // Re-save if we cleaned up dead entries
    if (alive.size !== procMap.size) {
      saveStateFn!(Object.fromEntries(procMap));
    }

    const runningNames = Array.from(alive);

    await ctx.ui.custom(async (tui, theme, _kb, done) => {
      let selected = 0;
      let action: "none" | "kill" | "logs" | "back" = "none";
      let logOutput = "";

      const render = () => {
        if (action === "logs") {
          return theme.panel([
            theme.fg("accent", theme.bold("📄 Process Logs")),
            "",
            theme.fg("dim", `(press ${theme.fg("key", "Esc")} to go back)`),
            "",
            ...logOutput.split("\n").slice(0, tui.height - 6).map((line) => theme.fg("dim", line)),
            "",
            theme.fg("dim", `[${logOutput.split("\n").length} lines]`),
          ]);
        }

        const header = [
          theme.fg("accent", theme.bold("🔧 Background Process Manager")),
          "",
          theme.fg("dim", `Running: ${runningNames.length}  |  `),
          theme.fg("dim", `Total started: ${procMap.size}`),
          "",
        ];

        if (runningNames.length === 0 && procMap.size === 0) {
          return theme.panel([
            ...header,
            theme.fg("info", "No background processes yet."),
            "",
            theme.fg("dim", 'Use the tools directly: bg_run(name="app", command="...")'),
            "",
          ]);
        }

        const items: string[] = [];
        const allNames = Array.from(procMap.keys());

        for (let i = 0; i < allNames.length; i++) {
          const p = procMap[allNames[i]];
          const isAlive = alive.has(allNames[i]);
          const isSelected = i === selected;
          const uptime = formatUptime(Date.now() - p.startTime);
          const status = isAlive ? "🟢" : "⚫";
          const line = `${isSelected ? theme.fg("accent", "▸ ") : "  "}${status} ${allNames[i]} (PID: ${p.pid}) — ${uptime}`;
          items.push(line);
        }

        const footer = [
          "",
          theme.fg("dim", "↑↓ navigate  l:logs  k:kill  Esc:back"),
        ];

        return theme.panel([...header, ...items, ...footer]);
      };

      return {
        render,
        invalidate: () => tui.requestRender(),
        handleInput: (data: string) => {
          if (action === "logs") {
            if (data === "\x1b" || data === "q") {
              action = "none";
              tui.requestRender();
            }
            return;
          }

          const allNames = Array.from(procMap.keys());

          if (data === "\x1b" || data === "q") {
            done(undefined);
            return;
          }

          if (data === "\u001b[A" || data === "k") {
            // Up
            selected = Math.max(0, selected - 1);
            tui.requestRender();
            return;
          }

          if (data === "\u001b[B" || data === "j") {
            // Down
            selected = Math.min(allNames.length - 1, selected + 1);
            tui.requestRender();
            return;
          }

          const name = allNames[selected];
          if (!name) return;

          if (data === "l") {
            // Show logs
            const proc = procMap[name];
            logOutput = readLogTail(proc.logFile, 200);
            action = "logs";
            tui.requestRender();
            return;
          }

          if (data === "k") {
            // Kill
            const proc = procMap[name];
            if (!proc.killed) {
              try {
                process.kill(proc.pid, "SIGTERM");
                proc.killed = true;
                saveStateFn!(Object.fromEntries(procMap));
                alive.delete(name);
                ctx.ui.notify(`Killed "${name}"`, "info");
                tui.requestRender();
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                if (!msg.includes("ESRCH")) {
                  ctx.ui.notify(`Failed to kill "${name}": ${msg}`, "error");
                } else {
                  ctx.ui.notify(`"${name}" was already dead`, "warning");
                }
              }
            }
            return;
          }
        },
      };
    });
  },
});
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  }
  return `${seconds}s`;
}
