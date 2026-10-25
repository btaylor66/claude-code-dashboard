# Claude Code Dashboard

A lightweight localhost dashboard that monitors multiple Claude Code sessions in real-time. See token usage, costs, active tools, subagents, and session status across all your terminal instances at a glance.

![Claude Code Dashboard screenshot](Screenshot.png)

## Why?

Claude Code has no cross-session visibility. If you're running two or more sessions in separate terminals, you have to alt-tab to check status, there's no combined token/cost view, and you can't see which session is active vs idle.

This dashboard fixes that.

## Features

- **Live session monitoring** — auto-detects all Claude Code sessions
- **Token and cost tracking** — per-session and combined totals, with correct per-model pricing
- **Status detection** — thinking (green), waiting (yellow), idle (grey/orange), stale (dimmed)
- **Context window usage** — visual progress bar per session
- **Active subagents** — see spawned subagents while they're running
- **Active files** — see which files each session is working on
- **Recent log feed** — expandable per-session activity log
- **Click to open** — click a project name to open its folder
- **Git branch display** — see which branch each session is on
- **Permission mode badges** — YOLO and AUTO-EDIT indicators
- **Cross-platform** — Windows, macOS, and Linux

## Quick Start

```bash
git clone https://github.com/Stargx/claude-code-dashboard.git
cd claude-code-dashboard
npm install
npm start
```

Open **http://localhost:3001** in your browser.

That's it. The dashboard will automatically detect any running Claude Code sessions.

Run this in a separate terminal tab — your Claude Code sessions run in their own terminals as normal, and the dashboard monitors them all from one place.

## How It Works

Claude Code writes JSONL session logs to `~/.claude/projects/`. The dashboard:

1. **Watches** those files for changes using `chokidar`
2. **Parses** new lines as they're appended (tail behaviour)
3. **Serves** aggregated session state via a simple Express API
4. **Renders** a polling dashboard that refreshes every 2 seconds

No WebSockets, no build step, no cloud services. Just a Node.js process reading local files.

## Requirements

- **Node.js** (v18 or later)
- **Claude Code** (any version that writes JSONL session logs)

## Configuration

The dashboard runs on port 3001 by default. To change it, set the `PORT` environment variable:

```bash
PORT=8080 npm start
```

### Watching more than one machine or account

`CLAUDE_PROJECT_DIRS` takes one or more Claude project directories, colon-separated.
Each entry can carry a host label as `label=path`; a bare path is labelled with this
machine's hostname. The label appears on every session card and in a per-host row under the
header, which you can click to filter.

```bash
CLAUDE_PROJECT_DIRS="desktop=$HOME/.claude/projects:laptop=$HOME/claude-sessions/laptop/projects" npm start
```

To include another machine, mirror its `~/.claude/projects` with
`scripts/sync-remote-sessions.sh` from cron. It stamps the destination with `.sync-ok` on
success and `.sync-error` on failure, and the dashboard turns that into a freshness
indicator per host (green under 3 minutes since the last sync, yellow under 15, red beyond
that or when the sync is failing). Failures are also appended to `<dest>/../sync.log`.

```bash
* * * * * /path/to/scripts/sync-remote-sessions.sh me@laptop /home/me/claude-sessions/laptop/projects
```

## Pricing

Token costs are calculated using current Anthropic pricing. The pricing constants are in `watcher.js` — update them if pricing changes:

```js
const PRICING = {
  "claude-sonnet-4-20250514": { input: 3.00, output: 15.00 },
  "claude-opus-4-20250514":   { input: 15.00, output: 75.00 },
  // ... per 1M tokens
};
```

## Tech Stack

- **Backend**: Node.js, Express, chokidar
- **Frontend**: Single HTML file, React via CDN, no build step
- **Styling**: Dark terminal aesthetic, IBM Plex Mono
- **Dependencies**: 2 production packages (`express`, `chokidar`)

## License

MIT
