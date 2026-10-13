# Central view: multiple accounts and machines

## Accounts on one machine
The watcher auto-discovers `~/.claude*/projects` and `~/.config/claude*/projects` at
startup and re-scans every 60s. The account label comes from the directory name
(`~/.claude-work` -> `work`, `~/.claude` -> `default`). Disable with `CLAUDE_DISCOVER=0`.

Explicit dirs (colon-separated, optional `name=` prefix):

    CLAUDE_PROJECT_DIRS=personal=$HOME/.claude/projects:work=$HOME/.claude-work/projects node watcher.js

## Many machines -> one dashboard
Server (the box that serves the page):

    DASHBOARD_TOKEN=<secret> node watcher.js

Each other machine runs a shipper (no web server; pushes parsed session state every 2s):

    DASHBOARD_TOKEN=<secret> DASHBOARD_HOST=laptop node watcher.js --ship http://10.23.4.195:3001

- `DASHBOARD_HOST` labels the machine (default: hostname). It must differ from the server's host.
- `SHIP_MAX_AGE_DAYS` (default 7) limits how much history is shipped.
- Ingest is disabled unless the server has `DASHBOARD_TOKEN`. Traffic is plain HTTP: keep it on the LAN.
- Raw transcripts never leave the machine; only derived session state (file names, short prompt snippets, token counts).
- Remote sessions are kept in server memory only; after a server restart, restart the shippers to resend them.
