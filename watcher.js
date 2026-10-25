const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const chokidar = require('chokidar');

// --- Pricing ---
// USD per million tokens. Source: https://platform.claude.com/docs/en/about-claude/pricing (2026-10-10)
// cacheWrite = 5-minute cache write rate; cacheRead = cache hit rate.
const PRICING = {
  'claude-fable-5-1':  { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 0.25 },
  'claude-fable-5':    { input: 10.00, output: 50.00, cacheWrite: 12.50, cacheRead: 1.00 },
  'claude-opus-5-5':   { input: 4.00,  output: 20.00, cacheWrite: 5.00,  cacheRead: 0.20 },
  'claude-opus-5':     { input: 5.00,  output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-8':   { input: 5.00,  output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-7':   { input: 5.00,  output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-opus-4-6':   { input: 5.00,  output: 25.00, cacheWrite: 6.25,  cacheRead: 0.50 },
  'claude-sonnet-5-5': { input: 2.00,  output: 10.00, cacheWrite: 2.50,  cacheRead: 0.10 },
  'claude-sonnet-5':   { input: 2.00,  output: 10.00, cacheWrite: 2.50,  cacheRead: 0.20 },
  'claude-sonnet-4-6': { input: 3.00,  output: 15.00, cacheWrite: 3.75,  cacheRead: 0.30 },
  'claude-haiku-5-5':  { input: 0.10,  output: 0.50,  cacheWrite: 0.125, cacheRead: 0.01 },
  'claude-haiku-4-5':  { input: 1.00,  output: 5.00,  cacheWrite: 1.25,  cacheRead: 0.10 },
};
const FREE = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
// Longest key first so 'claude-opus-5-5' wins over 'claude-opus-5'.
const PRICING_KEYS = Object.keys(PRICING).sort((a, b) => b.length - a.length);

function getPricing(model) {
  if (!model) return PRICING['claude-opus-5-5'];
  if (model === '<synthetic>') return FREE;
  for (const key of PRICING_KEYS) {
    if (model.startsWith(key)) return PRICING[key];
  }
  console.warn(`Unknown model ${model}; using Opus 5.5 pricing`);
  return PRICING['claude-opus-5-5'];
}

// --- Session State ---
const sessions = new Map();
const fileOffsets = new Map(); // path -> byte offset
const seenMessageIds = new Map(); // sessionId -> Set of message.id

function getOrCreateSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      sessionId,
      host: '',
      projectHash: '',
      cwd: '',
      label: '',
      model: '',
      gitBranch: '',
      status: 'idle',
      tokensIn: 0,
      tokensOut: 0,
      cacheCreationIn: 0,
      cacheReadIn: 0,
      costUSD: 0,
      turnCount: 0,
      activeFiles: [],
      recentLog: [],
      startedAt: null,
      lastEventAt: null,
      lastEventType: '',
      lastContentTypes: [],
      lastTurnInputTotal: 0, // input + cache for context window estimate
      permissionMode: '',
      version: '',
      subagents: {}, // agentId -> { task, status, tokensOut, lastEventAt }
    });
    seenMessageIds.set(sessionId, new Map()); // messageId -> {in, out, cacheCreate, cacheRead}
  }
  return sessions.get(sessionId);
}

function addToRecentLog(session, entry) {
  session.recentLog.push(entry);
  if (session.recentLog.length > 30) {
    session.recentLog = session.recentLog.slice(-30);
  }
}

function extractActiveFiles(content) {
  const files = [];
  if (!Array.isArray(content)) return files;
  for (const block of content) {
    if (block.type === 'tool_use' && block.input) {
      const fp = block.input.file_path || block.input.path || block.input.command;
      if (fp && typeof fp === 'string' && !fp.includes(' ')) {
        files.push(path.basename(fp));
      }
    }
  }
  return files;
}

function processEvent(event, projectHash, source) {
  if (!event || !event.sessionId) return;
  if (event.type === 'file-history-snapshot' || event.type === 'queue-operation' || event.type === 'last-prompt') return;

  const session = getOrCreateSession(event.sessionId);
  if (!event.timestamp) return; // skip events without timestamps
  const ts = event.timestamp;

  if (!session.startedAt) session.startedAt = ts;
  session.lastEventAt = ts;
  session.lastEventType = event.type;
  session.projectHash = projectHash;
  if (source) {
    session.host = source.label;
    if (!source.lastEventAt || ts > source.lastEventAt) source.lastEventAt = ts;
  }

  if (event.cwd && !session.cwd) {
    session.cwd = event.cwd;
    const parts = event.cwd.split('/').filter(Boolean);
    session.label = parts.slice(-2).join('/');
  }
  if (event.gitBranch && !session.gitBranch) {
    session.gitBranch = event.gitBranch;
  }
  if (event.version) session.version = event.version;
  if (event.permissionMode) session.permissionMode = event.permissionMode;

  const msg = event.message || {};
  const content = msg.content;
  const contentTypes = Array.isArray(content)
    ? content.map(c => c.type)
    : (typeof content === 'string' ? ['text'] : []);
  session.lastContentTypes = contentTypes;

  if (event.type === 'assistant' && msg.usage) {
    const msgId = msg.id;
    const usage = msg.usage;
    const seen = seenMessageIds.get(event.sessionId);

    if (msg.model) session.model = msg.model;

    // Track per-message-id usage, only count the delta
    const prev = seen.get(msgId) || { in: 0, out: 0, cacheCreate: 0, cacheRead: 0 };
    const curr = {
      in: usage.input_tokens || 0,
      out: usage.output_tokens || 0,
      cacheCreate: usage.cache_creation_input_tokens || 0,
      cacheRead: usage.cache_read_input_tokens || 0,
    };

    // Add only the difference (later events for same msgId have cumulative values)
    session.tokensIn += Math.max(0, curr.in - prev.in);
    session.tokensOut += Math.max(0, curr.out - prev.out);
    session.cacheCreationIn += Math.max(0, curr.cacheCreate - prev.cacheCreate);
    session.cacheReadIn += Math.max(0, curr.cacheRead - prev.cacheRead);

    seen.set(msgId, curr);

    // Track last turn's total input for context window estimate
    session.lastTurnInputTotal = curr.in + curr.cacheCreate + curr.cacheRead;

    // Recalculate cost
    const pricing = getPricing(session.model);
    session.costUSD =
      (session.tokensIn * pricing.input / 1_000_000) +
      (session.tokensOut * pricing.output / 1_000_000) +
      (session.cacheCreationIn * pricing.cacheWrite / 1_000_000) +
      (session.cacheReadIn * pricing.cacheRead / 1_000_000);

    // Log tool use
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_use') {
          addToRecentLog(session, {
            time: ts,
            type: 'tool',
            msg: block.name + (block.input?.file_path ? `: ${path.basename(block.input.file_path)}` : ''),
          });
        } else if (block.type === 'text' && block.text) {
          const snippet = block.text.substring(0, 120);
          addToRecentLog(session, { time: ts, type: 'think', msg: snippet });
        }
      }
      // Track active files
      const newFiles = extractActiveFiles(content);
      if (newFiles.length) {
        const fileSet = new Set([...newFiles, ...session.activeFiles]);
        session.activeFiles = [...fileSet].slice(0, 10);
      }
    }

    // Count turns by unique message IDs with stop_reason
    if (msg.stop_reason) {
      session.turnCount++;
    }
  }

  // --- Subagent tracking ---
  if (event.agentId && !event.agentId.startsWith('acompact')) {
    const aid = event.agentId;
    if (!session.subagents[aid]) {
      session.subagents[aid] = { agentId: aid, task: '', status: 'idle', tokensOut: 0, lastEventAt: null };
    }
    const sub = session.subagents[aid];
    sub.lastEventAt = ts;

    // Derive subagent status
    const subElapsed = Date.now() - new Date(ts).getTime();
    sub.status = subElapsed < 15_000 ? 'thinking' : 'idle';

    // Capture task from first user message
    if (!sub.task && event.type === 'user' && msg.role === 'user') {
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text : '');
      if (text) sub.task = text.substring(0, 120);
    }

    // Track subagent output tokens
    if (event.type === 'assistant' && msg.usage && msg.stop_reason) {
      sub.tokensOut += msg.usage.output_tokens || 0;
    }
  }

  if (event.type === 'user' && msg.role === 'user') {
    const text = typeof content === 'string'
      ? content.substring(0, 120)
      : (Array.isArray(content) ? content.find(c => c.type === 'text')?.text?.substring(0, 120) : '');
    if (text) {
      addToRecentLog(session, { time: ts, type: 'user', msg: text });
    }
  }
}

function deriveStatus(session) {
  if (!session.lastEventAt) return 'idle';
  const elapsed = Date.now() - new Date(session.lastEventAt).getTime();

  if (elapsed > 60_000) return 'idle';

  // Check for error in recent log
  const lastLogs = session.recentLog.slice(-3);
  if (lastLogs.some(l => l.type === 'error')) return 'error';

  if (elapsed < 15_000) {
    if (session.lastEventType === 'assistant') {
      if (session.lastContentTypes.includes('tool_use')) return 'thinking';
      if (session.lastContentTypes.includes('text')) return 'waiting';
      if (session.lastContentTypes.includes('thinking')) return 'thinking';
    }
    if (session.lastEventType === 'progress') return 'thinking';
    if (session.lastEventType === 'user') return 'thinking'; // just sent input, waiting for response
  }

  return 'idle';
}

// --- JSONL File Processing ---
function processFile(filePath) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return; }
  const offset = fileOffsets.get(filePath) || 0;
  if (stat.size <= offset) return;

  const projectHash = path.basename(path.dirname(filePath));
  const source = sourceForFile(filePath);
  if (source) {
    const mtime = stat.mtime.toISOString();
    if (!source.lastFileChangeAt || mtime > source.lastFileChangeAt) source.lastFileChangeAt = mtime;
  }
  const stream = fs.createReadStream(filePath, { start: offset, encoding: 'utf8' });
  let buffer = '';

  stream.on('data', (chunk) => { buffer += chunk; });
  stream.on('end', () => {
    fileOffsets.set(filePath, stat.size);
    const lines = buffer.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        processEvent(event, projectHash, source);
      } catch (e) {
        // Skip malformed lines (partial writes)
      }
    }
  });
}

// --- Express Server ---
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

app.post('/api/open-folder', express.json(), (req, res) => {
  const folder = req.body.path;
  if (!folder || typeof folder !== 'string') return res.status(400).json({ error: 'No path' });
  if (!fs.existsSync(folder)) return res.status(404).json({ error: 'Folder not found' });
  const { execFile } = require('child_process');
  const plat = process.platform;
  if (plat === 'win32') {
    execFile('explorer', [folder.replace(/\//g, '\\')], () => {});
  } else if (plat === 'darwin') {
    execFile('open', [folder], () => {});
  } else {
    execFile('xdg-open', [folder], () => {});
  }
  res.json({ ok: true });
});

app.get('/api/sessions', (req, res) => {
  // Build list with derived status
  const all = [];
  for (const session of sessions.values()) {
    const status = deriveStatus(session);
    // Convert subagents object to sorted array, only include active ones
    const subagentList = Object.values(session.subagents)
      .filter(s => s.status === 'thinking')
      .sort((a, b) => new Date(b.lastEventAt || 0) - new Date(a.lastEventAt || 0));
    all.push({
      ...session,
      status,
      costUSD: Math.round(session.costUSD * 10000) / 10000,
      subagents: subagentList,
    });
  }

  // Active sessions (thinking/waiting/error) always shown individually.
  // Idle sessions: only show the most recent per project label.
  const active = all.filter(s => s.status !== 'idle');
  const idle = all.filter(s => s.status === 'idle');
  // Collect labels that already have an active session
  const activeLabels = new Set(active.map(s => s.label));
  const latestIdleByLabel = new Map();
  for (const s of idle) {
    // Skip idle sessions if that project already has an active session
    if (activeLabels.has(s.label)) continue;
    const existing = latestIdleByLabel.get(s.label);
    if (!existing || new Date(s.lastEventAt || 0) > new Date(existing.lastEventAt || 0)) {
      latestIdleByLabel.set(s.label, s);
    }
  }

  const result = [...active, ...latestIdleByLabel.values()];
  // Sort: active today first (alphabetical), then inactive today (alphabetical)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  // Mark idle sessions not active today as 'idle-stale'
  for (const s of result) {
    if (s.status === 'idle' && (!s.lastEventAt || new Date(s.lastEventAt) < todayStart)) {
      s.status = 'idle-stale';
    }
  }
  result.sort((a, b) => {
    const aToday = a.lastEventAt && new Date(a.lastEventAt) >= todayStart ? 1 : 0;
    const bToday = b.lastEventAt && new Date(b.lastEventAt) >= todayStart ? 1 : 0;
    if (aToday !== bToday) return bToday - aToday; // active today first
    return (a.label || '').localeCompare(b.label || '');
  });
  res.json(result);
});

// --- Sources ---
// One or more Claude project dirs, colon-separated. Each entry is `label=path` or a bare
// path (label defaults to this machine's hostname). The label is shown as the session's
// host. A directory that is rsynced from another machine can carry two stamp files written
// by scripts/sync-remote-sessions.sh: `.sync-ok` (mtime = last successful sync) and
// `.sync-error` (text of the last failure, removed on the next success).
const SYNC_OK_FILE = '.sync-ok';
const SYNC_ERROR_FILE = '.sync-error';
const SYNC_STALE_MS = 3 * 60_000;   // yellow after 3 minutes without a successful sync
const SYNC_DOWN_MS = 15 * 60_000;   // red after 15 minutes

function parseSources(spec) {
  const entries = (spec || path.join(os.homedir(), '.claude', 'projects')).split(':').filter(Boolean);
  return entries.map(entry => {
    const eq = entry.indexOf('=');
    const label = eq > 0 ? entry.slice(0, eq) : os.hostname();
    const dir = path.resolve(eq > 0 ? entry.slice(eq + 1) : entry);
    return {
      label, dir,
      lastEventAt: null,      // newest event timestamp parsed from this dir
      lastFileChangeAt: null, // newest jsonl mtime seen in this dir
      syncedAt: null,         // mtime of .sync-ok, remote sources only
      syncError: null,        // { at, message } from .sync-error, if newer than .sync-ok
      remote: false,
    };
  });
}

const SOURCES = parseSources(process.env.CLAUDE_PROJECT_DIRS);
// Longest dir first so nested watch dirs resolve to the most specific source.
const SOURCES_BY_DEPTH = SOURCES.slice().sort((a, b) => b.dir.length - a.dir.length);

function sourceForFile(filePath) {
  for (const src of SOURCES_BY_DEPTH) {
    if (filePath === src.dir || filePath.startsWith(src.dir + path.sep)) return src;
  }
  return null;
}

function readSyncStamps() {
  for (const src of SOURCES) {
    let okStat = null;
    try { okStat = fs.statSync(path.join(src.dir, SYNC_OK_FILE)); } catch {}
    let errStat = null;
    try { errStat = fs.statSync(path.join(src.dir, SYNC_ERROR_FILE)); } catch {}
    src.remote = Boolean(okStat || errStat);
    src.syncedAt = okStat ? okStat.mtime.toISOString() : null;
    if (errStat && (!okStat || errStat.mtime > okStat.mtime)) {
      let message = '';
      try { message = fs.readFileSync(path.join(src.dir, SYNC_ERROR_FILE), 'utf8').trim().slice(0, 300); } catch {}
      src.syncError = { at: errStat.mtime.toISOString(), message };
    } else {
      src.syncError = null;
    }
  }
}

// Freshness state for the UI: 'local' (watched directly), 'ok', 'stale', 'down'.
function sourceState(src) {
  if (!src.remote) return 'local';
  if (src.syncError) return 'down';
  if (!src.syncedAt) return 'down';
  const age = Date.now() - new Date(src.syncedAt).getTime();
  if (age < SYNC_STALE_MS) return 'ok';
  if (age < SYNC_DOWN_MS) return 'stale';
  return 'down';
}

app.get('/api/sources', (req, res) => {
  res.json(SOURCES.map(src => ({
    label: src.label,
    dir: src.dir,
    remote: src.remote,
    state: sourceState(src),
    syncedAt: src.syncedAt,
    syncError: src.syncError,
    lastEventAt: src.lastEventAt,
    lastFileChangeAt: src.lastFileChangeAt,
  })));
});

// --- Start ---
const WATCH_DIRS = SOURCES.map(s => s.dir);
const PORT = Number(process.env.PORT) || 3001;

console.log(`Watching: ${SOURCES.map(s => `${s.label}=${s.dir}`).join(', ')}`);
console.log(`Dashboard: http://localhost:${PORT}`);

readSyncStamps();
setInterval(readSyncStamps, 15_000);

// Watch the projects directory (chokidar v5 needs directory, not glob)
const watcher = chokidar.watch(WATCH_DIRS, {
  persistent: true,
  ignoreInitial: false,
  depth: 4, // reach projects/hash/session/subagents/*.jsonl
  awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
});

function shouldProcessFile(filePath) {
  return filePath.endsWith('.jsonl') && !path.basename(filePath).includes('compact');
}
watcher.on('add', (filePath) => {
  if (shouldProcessFile(filePath)) processFile(filePath);
});
watcher.on('change', (filePath) => {
  if (shouldProcessFile(filePath)) processFile(filePath);
});

const server = app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} already in use. Kill the existing process or use a different port.`);
    process.exit(1);
  }
  throw err;
});
