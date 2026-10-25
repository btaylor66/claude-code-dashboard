#!/bin/sh
# Pull another machine's Claude Code session logs into a local directory for the dashboard
# and stamp the result so the dashboard can show sync freshness.
#
# Usage: sync-remote-sessions.sh <user@host> <dest-dir> [log-file]
#
#   <user@host>  SSH target; key-based auth, no prompts (BatchMode).
#   <dest-dir>   Local directory to mirror ~/.claude/projects into. Point the dashboard at it
#                with CLAUDE_PROJECT_DIRS=<label>=<dest-dir>.
#   [log-file]   Where failures are appended. Default: <dest-dir>/../sync.log
#
# On success:  touches <dest-dir>/.sync-ok and removes .sync-error.
# On failure:  writes the error to <dest-dir>/.sync-error and appends it to the log.
# Both stamp files match rsync's exclude pattern, so --delete leaves them alone.
#
# Cron example (every minute):
#   * * * * * /path/to/sync-remote-sessions.sh me@10.0.0.5 /home/me/claude-sessions/laptop/projects
set -u

SRC="${1:?usage: $0 <user@host> <dest-dir> [log-file]}"
DEST="${2:?usage: $0 <user@host> <dest-dir> [log-file]}"
LOG="${3:-$(dirname "$DEST")/sync.log}"
MAX_LOG_LINES=500

mkdir -p "$DEST"

OUT=$(rsync -a --delete \
  --include='*/' --include='*.jsonl' --exclude='*' --prune-empty-dirs \
  -e 'ssh -o BatchMode=yes -o ConnectTimeout=10' \
  "$SRC:.claude/projects/" "$DEST/" 2>&1)
RC=$?

if [ "$RC" -eq 0 ]; then
  touch "$DEST/.sync-ok"
  rm -f "$DEST/.sync-error"
  exit 0
fi

MSG=$(printf '%s\n' "$OUT" | tr -d '\r' | grep -v '^[[:space:]]*$' | head -n 2 | tr '\n' ' ')
LINE="$(date '+%Y-%m-%dT%H:%M:%S%z') rc=$RC $SRC: $MSG"
printf '%s\n' "$LINE" > "$DEST/.sync-error"
printf '%s\n' "$LINE" >> "$LOG"

# Keep the log bounded; a dead host would otherwise add 1440 lines a day.
if [ "$(wc -l < "$LOG")" -gt "$MAX_LOG_LINES" ]; then
  tail -n "$MAX_LOG_LINES" "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi
exit "$RC"
