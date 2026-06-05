# Background Process Manager (`bg-tool.ts`)

A pi extension that adds tools for managing persistent background processes — inspired by Claude Code's `bg` command. Lets the agent spawn, monitor, and manage long-running processes across turns.

## Tools

| Tool | Description |
|------|-------------|
| `bg_run` | Start a background process (captures stdout/stderr to a log file) |
| `bg_list` | List all running background processes |
| `bg_kill` | Stop a background process (SIGTERM, or SIGKILL with `force=true`) |
| `bg_logs` | Read captured output/logs from a background process |

## Usage

### As an extension

Copy `bg-tool.ts` to your extensions directory:

```bash
# For all sessions
cp bg-tool.ts ~/.pi/agent/extensions/

# Or for this project only
cp bg-tool.ts .pi/extensions/
```

Then start pi with:

```bash
pi -e ./bg-tool.ts
# or if installed globally
pi -e ~/.pi/agent/extensions/bg-tool.ts
```

### Interactive `/bg` command

Type `/bg` in interactive mode to open a TUI panel showing all background processes. Navigate with `↑`/`↓`, view logs with `l`, kill with `k`, and exit with `Esc`.

## Example Flows

### Debug a GUI application

```
bg_run(name="electron-app", command="electron .")
→ ✅ Background process "electron-app" started. PID: 12345
   Log file: C:\Users\corpo\.pi\agent\bg-tools\electron-app.log

bg_logs(name="electron-app", tail=20)
→ 📄 Logs for "electron-app" (running, uptime: 30s)
   [window created, rendering frame, etc.]

# ... debug the issue ...

bg_kill(name="electron-app")
→ 🛑 Process "electron-app" (PID: 12345) sent SIGTERM.
```

### Run a dev server

```
bg_run(name="vite-dev", command="npm run dev", cwd="C:/Users/corpo/my-project")
bg_logs(name="vite-dev")
# Check that the server started successfully
# ... do other work while server runs ...
bg_logs(name="vite-dev", tail=50)  # Check for errors
bg_kill(name="vite-dev")
```

### Check what's running

```
bg_list()
→ 📋 2 background process(es):
     🟢 electron-app
        PID: 12345
        Command: electron .
        Uptime: 5m 32s
        Log: C:\Users\corpo\.pi\agent\bg-tools\electron-app.log

     🟢 vite-dev
        PID: 12346
        Command: npm run dev
        Uptime: 12m 8s
        Log: C:\Users\corpo\.pi\agent\bg-tools\vite-dev.log
```

## Architecture

- **Process management**: Uses Node.js `child_process.spawn` with `detached: true` so processes survive after pi exits
- **Log capture**: stdout/stderr are piped to individual log files in `~/.pi/agent/bg-tools/`
- **State persistence**: Process metadata is saved to the session via `appendEntry("bg-state", ...)` so it survives session reloads
- **Process detection**: `bg_list` checks if processes are alive using `process.kill(pid, 0)` (no-op signal)

## Files

- `bg-tool.ts` — The extension (copy to `~/.pi/agent/extensions/` or `.pi/extensions/`)
