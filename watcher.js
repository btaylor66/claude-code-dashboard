const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const crypto = require('crypto');
const chokidar = require('chokidar');

// --- Identity / central-view settings ---
// HOST labels where sessions run. Remote shippers send their own HOST.
const HOST = (process.env.DASHBOARD_HOST || os.hostname()).slice(0, 64);
// Shared secret for POST /api/ingest (server) and for shipping (client). Ingest is disabled without it.
const TOKEN = process.env.DASHBOARD_TOKEN || '';
// Shipper mode: `node watcher.js --ship http://server:3001` (or DASHBOARD_SHIP_URL).
const shipArgIdx = process.argv.indexOf('--ship');
const SHIP_URL = (shipArgIdx > -1 ? process.argv[shipArgIdx + 1] : process.env.DASHBOARD_SHIP_URL) || '';
const SHIP_MAX_AGE_MS = (Number(process.env.SHIP_MAX_AGE_DAYS) || 7) * 86_400_000;

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

function newSession(sessionId) {
  return {
      sessionId,
      key: '',
      host: HOST,
      account: '',
      remote: false,
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
  };
}

// Sessions are keyed by host + sessionId so the same id on two machines never collides.
function getOrCreateSession(sessionId, ctx) {
  const key = `${ctx.host}/${sessionId}`;
  if (!sessions.has(key)) {
    const s = newSession(sessionId);
    s.key = key;
    s.host = ctx.host;
    s.account = ctx.account;
    sessions.set(key, s);
    seenMessageIds.set(key, new Map()); // messageId -> {in, out, cacheCreate, cacheRead}
  }
  return sessions.get(key);
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

function processEvent(event, projectHash, ctx) {
  if (!event || !event.sessionId) return;
  if (event.type === 'file-history-snapshot' || event.type === 'queue-operation' || event.type === 'last-prompt') return;

  const session = getOrCreateSession(event.sessionId, ctx);
  if (!event.timestamp) return; // skip events without timestamps
  const ts = event.timestamp;

  if (!session.startedAt) session.startedAt = ts;
  session.lastEventAt = ts;
  session.lastEventType = event.type;
  session.projectHash = projectHash;

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
    const seen = seenMessageIds.get(session.key);

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
  const root = ROOTS.find(r => filePath.startsWith(r.dir + path.sep));
  const ctx = { host: HOST, account: root ? root.name : 'default' };
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
        processEvent(event, projectHash, ctx);
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
  // Dedupe per host + account + project so machines/accounts never hide each other.
  const groupKey = (s) => `${s.host}|${s.account}|${s.label}`;
  const activeLabels = new Set(active.map(groupKey));
  const latestIdleByLabel = new Map();
  for (const s of idle) {
    // Skip idle sessions if that project already has an active session
    if (activeLabels.has(groupKey(s))) continue;
    const existing = latestIdleByLabel.get(groupKey(s));
    if (!existing || new Date(s.lastEventAt || 0) > new Date(existing.lastEventAt || 0)) {
      latestIdleByLabel.set(groupKey(s), s);
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

// --- Central ingest: other machines POST their session state here ---
function tokenOk(header) {
  if (!TOKEN || typeof header !== 'string') return false;
  const a = crypto.createHash('sha256').update(header).digest();
  const b = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

// Copy only known fields of the expected type from an untrusted payload.
function sanitizeRemote(raw, host, key) {
  const base = newSession(String(raw.sessionId || '').slice(0, 128));
  for (const k of Object.keys(base)) {
    const v = raw[k];
    if (v === undefined || v === null) continue;
    if (Array.isArray(base[k])) { if (Array.isArray(v)) base[k] = v.slice(0, 30); }
    else if (typeof v === typeof base[k]) base[k] = v;
  }
  if (typeof raw.lastEventAt === 'string') base.lastEventAt = raw.lastEventAt;
  if (typeof raw.startedAt === 'string') base.startedAt = raw.startedAt;
  base.host = host;
  base.account = String(raw.account || 'default').slice(0, 64);
  base.key = key;
  base.remote = true;
  return base;
}

app.post('/api/ingest', express.json({ limit: '5mb' }), (req, res) => {
  if (!TOKEN) return res.status(403).json({ error: 'Ingest disabled: set DASHBOARD_TOKEN on the server' });
  if (!tokenOk(req.get('x-dashboard-token'))) return res.status(401).json({ error: 'Bad token' });
  const host = String((req.body && req.body.host) || '').slice(0, 64);
  const list = req.body && req.body.sessions;
  if (!host || !Array.isArray(list)) return res.status(400).json({ error: 'Need host and sessions[]' });
  if (host === HOST) return res.status(400).json({ error: 'host collides with the server host; set DASHBOARD_HOST on the shipper' });
  let n = 0;
  for (const raw of list.slice(0, 500)) {
    if (!raw || typeof raw.sessionId !== 'string' || !raw.sessionId) continue;
    const key = `${host}/${raw.sessionId}`;
    sessions.set(key, sanitizeRemote(raw, host, key));
    n++;
  }
  res.json({ ok: true, accepted: n });
});

// --- Watch roots: explicit + auto-discovered Claude config dirs ---
// CLAUDE_PROJECT_DIRS: colon-separated, each `path` or `name=path` (name = account label).
// Auto-discovery (disable with CLAUDE_DISCOVER=0): ~/.claude*/projects and ~/.config/claude*/projects.
const ROOTS = [];
function accountNameFor(dir) {
  const parent = path.basename(path.dirname(dir)).replace(/^\./, '');
  const n = parent.replace(/^claude[-_]?/, '');
  return n || 'default';
}
function addRoot(dir, name) {
  dir = path.resolve(dir);
  if (ROOTS.some(r => r.dir === dir)) return false;
  ROOTS.push({ dir, name: name || accountNameFor(dir) });
  return true;
}
function discoverRoots() {
  if (process.env.CLAUDE_DISCOVER === '0') return [];
  const found = [];
  const home = os.homedir();
  for (const base of [home, path.join(home, '.config')]) {
    let entries = [];
    try { entries = fs.readdirSync(base, { withFileTypes: true }); } catch { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory() || !/^\.?claude/.test(ent.name)) continue;
      const dir = path.join(base, ent.name, 'projects');
      try { if (fs.statSync(dir).isDirectory()) found.push(dir); } catch {}
    }
  }
  return found;
}
for (const entry of (process.env.CLAUDE_PROJECT_DIRS || '').split(':').filter(Boolean)) {
  const eq = entry.indexOf('=');
  if (eq > 0) addRoot(entry.slice(eq + 1), entry.slice(0, eq));
  else addRoot(entry);
}
for (const d of discoverRoots()) addRoot(d);
if (ROOTS.length === 0) addRoot(path.join(os.homedir(), '.claude', 'projects'));

// --- Start ---
const WATCH_DIRS = ROOTS.map(r => r.dir);
const PORT = Number(process.env.PORT) || 3001;

console.log(`Host: ${HOST}`);
console.log(`Watching: ${ROOTS.map(r => `${r.name}=${r.dir}`).join(', ')}`);
if (!SHIP_URL) console.log(`Dashboard: http://localhost:${PORT}`);

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

// Pick up config dirs created after startup (e.g. a newly logged-in account).
setInterval(() => {
  for (const d of discoverRoots()) {
    if (addRoot(d)) {
      console.log(`Discovered: ${ROOTS[ROOTS.length - 1].name}=${d}`);
      watcher.add(d);
    }
  }
}, 60_000).unref();

if (SHIP_URL) {
  // --- Shipper mode: no web server, push local session state to the central dashboard ---
  if (!TOKEN) { console.error('Shipper needs DASHBOARD_TOKEN'); process.exit(1); }
  const endpoint = SHIP_URL.replace(/\/+$/, '') + '/api/ingest';
  const sent = new Map(); // key -> signature of last shipped state
  const sig = (s) => `${s.lastEventAt}|${s.tokensIn}|${s.tokensOut}|${s.cacheReadIn}|${s.turnCount}|${s.model}`;
  let busy = false;
  setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const cutoff = Date.now() - SHIP_MAX_AGE_MS;
      const dirty = [];
      for (const s of sessions.values()) {
        if (s.lastEventAt && new Date(s.lastEventAt).getTime() < cutoff) continue;
        if (sent.get(s.key) !== sig(s)) dirty.push(s);
      }
      for (let i = 0; i < dirty.length; i += 50) {
        const batch = dirty.slice(i, i + 50);
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dashboard-token': TOKEN },
          body: JSON.stringify({ host: HOST, sessions: batch }),
        });
        if (!r.ok) { console.error(`Ship failed: HTTP ${r.status} ${await r.text()}`); break; }
        for (const s of batch) sent.set(s.key, sig(s));
      }
    } catch (e) {
      console.error(`Ship error: ${e.message}`);
    } finally {
      busy = false;
    }
  }, 2000);
  console.log(`Shipping to ${endpoint} as host "${HOST}"`);
} else {
  const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (!TOKEN) console.log('Ingest disabled (set DASHBOARD_TOKEN to accept remote shippers)');
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} already in use. Kill the existing process or use a different port.`);
      process.exit(1);
    }
    throw err;
  });
}
