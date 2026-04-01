const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const chokidar = require('chokidar');
const fs = require('fs');
const path = require('path');
const { execSync, exec, execFileSync } = require('child_process');
const readline = require('readline');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PORT = 3456;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');
const SESSIONS_DIR = path.join(CLAUDE_DIR, 'sessions');
const TODOS_DIR = path.join(CLAUDE_DIR, 'todos');
const CONFIG_PATH = path.join(CLAUDE_DIR, 'dashboard-config.json');

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}
function writeConfig(data) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify({ ...readConfig(), ...data }, null, 2));
}

// Track file positions for incremental JSONL reading
const filePositions = new Map();

// Cache: sessionId -> session metadata
const sessionMetaCache = new Map();

// ─── Utility Functions ───────────────────────────────────────────────────────

function safeReadJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

// Session files are named by PID (e.g., 75571.json), not sessionId.
// Build an index mapping sessionId -> metadata.
function buildSessionIndex() {
  sessionMetaCache.clear();
  if (!fs.existsSync(SESSIONS_DIR)) return;

  const files = fs.readdirSync(SESSIONS_DIR).filter(f => f.endsWith('.json'));
  for (const file of files) {
    const meta = safeReadJSON(path.join(SESSIONS_DIR, file));
    if (meta?.sessionId) {
      sessionMetaCache.set(meta.sessionId, meta);
    }
  }
}

function getSessionMeta(sessionId) {
  // Rebuild index if cache miss (new sessions may have appeared)
  if (!sessionMetaCache.has(sessionId)) {
    buildSessionIndex();
  }
  return sessionMetaCache.get(sessionId) || null;
}

// Initial build
buildSessionIndex();

function projectPathToName(dirName) {
  // Prefer the real path basename from JSONL cwd (handles hyphenated project names)
  const fullPath = projectPathToFullPath(dirName);
  if (fullPath && fullPath !== '/' + dirName.replace(/^-/, '').split('-').join('/')) {
    return path.basename(fullPath) || fullPath;
  }
  // Fallback: strip the home directory prefix from the dir name
  const parts = dirName.split('-').filter(Boolean);
  const homeParts = os.homedir().split('/').filter(Boolean);
  let idx = 0;
  for (const hp of homeParts) {
    if (parts[idx] && parts[idx].toLowerCase() === hp.toLowerCase()) idx++;
  }
  const name = parts.slice(idx).join('-');
  return name || path.basename(os.homedir());
}

// Resolve the real filesystem path for a project by reading cwd from its JSONL files.
// The directory names in ~/.claude/projects/ use '-' for ALL separators including
// hyphens in project names, so naive replacement is wrong for "my-project-name".
const _projectPathCache = new Map();
function projectPathToFullPath(dirName) {
  if (_projectPathCache.has(dirName)) return _projectPathCache.get(dirName);

  // Try to read cwd from any JSONL in the project dir
  // First few lines may be queue-operations with no cwd — scan until found
  try {
    const projectDir = path.join(PROJECTS_DIR, dirName);
    const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const lines = fs.readFileSync(path.join(projectDir, f), 'utf8').split('\n').slice(0, 20);
      for (const line of lines) {
        try {
          const record = JSON.parse(line);
          if (record.cwd) {
            _projectPathCache.set(dirName, record.cwd);
            return record.cwd;
          }
        } catch {}
      }
    }
  } catch {}

  // Fallback: naive conversion (works for paths without hyphens in folder names)
  const fallback = '/' + dirName.replace(/^-/, '').split('-').join('/');
  _projectPathCache.set(dirName, fallback);
  return fallback;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isProcessPaused(pid) {
  try {
    const state = execSync(`ps -o state= -p ${pid}`, { encoding: 'utf8' }).trim();
    // 'T' = stopped by job control (SIGTSTP), 'T+' = stopped in foreground
    return state.startsWith('T');
  } catch {
    return false;
  }
}

function getProcessTTY(pid) {
  try {
    const tty = execSync(`ps -o tty= -p ${pid}`, { encoding: 'utf8' }).trim();
    if (tty && tty !== '??') {
      return `/dev/${tty}`;
    }
  } catch {}
  return null;
}

// Inject characters into a TTY's input queue using TIOCSTI.
// Writing to the slave device only affects display output; TIOCSTI is the
// correct mechanism to send characters to the process reading from that TTY.
function injectInputToTTY(ttyPath, text) {
  const script = [
    'import sys, fcntl',
    'try:',
    '    from termios import TIOCSTI',
    'except (ImportError, AttributeError):',
    '    TIOCSTI = 0x80017472  # macOS Darwin fallback',
    'fd = open(sys.argv[1], "r")',
    'for c in sys.argv[2]:',
    '    fcntl.ioctl(fd.fileno(), TIOCSTI, c.encode("latin-1"))',
    'fd.close()'
  ].join('\n');
  execFileSync('python3', ['-c', script, ttyPath, text], { timeout: 4000 });
}

function isClaudeProcess(pid) {
  try {
    const cmd = execSync(`ps -o command= -p ${pid}`, { encoding: 'utf8' }).trim();
    return cmd.includes('claude') || cmd.includes('Claude');
  } catch {
    return false;
  }
}

// ─── JSONL Parsing ───────────────────────────────────────────────────────────

function readLastNLines(filePath, n = 50) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.trim().split('\n').slice(-n);
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
    return records;
  } catch {
    return [];
  }
}

function readNewLines(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const prevPos = filePositions.get(filePath) || 0;
    if (stats.size <= prevPos) return [];

    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(stats.size - prevPos);
    fs.readSync(fd, buf, 0, buf.length, prevPos);
    fs.closeSync(fd);
    filePositions.set(filePath, stats.size);

    const lines = buf.toString('utf8').trim().split('\n');
    const records = [];
    for (const line of lines) {
      try {
        records.push(JSON.parse(line));
      } catch {}
    }
    return records;
  } catch {
    return [];
  }
}

// ─── Session Status Detection ────────────────────────────────────────────────

function getSessionStatus(sessionId, sessionMeta, jsonlPath) {
  const pid = sessionMeta?.pid;
  const running = pid ? isProcessRunning(pid) : false;

  if (!running) {
    return { status: 'completed', detail: 'Process ended', pid };
  }

  if (isProcessPaused(pid)) {
    return { status: 'paused', detail: 'Agent paused (SIGTSTP)', pid };
  }

  const records = readLastNLines(jsonlPath, 30);
  if (records.length === 0) {
    return { status: 'active', detail: 'Session started', pid };
  }

  // Find pending approvals — only meaningful for CLI sessions with a TTY.
  // Desktop App sessions (TTY=??) handle permissions internally; unresolved
  // tool_use entries just mean the tool is mid-execution, not waiting for input.
  const pendingApprovals = findPendingApprovals(records);
  if (pendingApprovals.length > 0 && getProcessTTY(pid)) {
    const toolNames = pendingApprovals.map(a => a.toolName).join(', ');
    return {
      status: 'waiting_for_approval',
      detail: `Waiting for approval: ${toolNames}`,
      pid,
      pendingApprovals
    };
  }

  // Check last message timestamp
  const lastRecord = records[records.length - 1];
  const lastTimestamp = lastRecord?.timestamp ? new Date(lastRecord.timestamp) : null;
  const now = new Date();
  const ageMs = lastTimestamp ? now - lastTimestamp : Infinity;

  // Check if last message is a user queue-operation (agent is processing)
  if (lastRecord?.type === 'queue-operation' && lastRecord?.operation === 'enqueue') {
    return { status: 'processing', detail: 'Processing request...', pid };
  }

  // Check for active assistant response in progress
  const lastAssistant = [...records].reverse().find(r => r.type === 'assistant');
  if (lastAssistant?.message?.stop_reason === null) {
    return { status: 'active', detail: 'Generating response...', pid };
  }

  if (ageMs < 30000) {
    return { status: 'active', detail: 'Recently active', pid };
  } else if (ageMs < 300000) {
    return { status: 'idle', detail: 'Idle', pid };
  } else {
    return { status: 'idle', detail: 'Idle (no recent activity)', pid };
  }
}

function findPendingApprovals(records) {
  const pending = [];
  const resolvedToolIds = new Set();

  // Collect all tool_result IDs
  for (const record of records) {
    if (record.type === 'user' && record.message?.content) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      for (const block of content) {
        if (block.type === 'tool_result' && block.tool_use_id) {
          resolvedToolIds.add(block.tool_use_id);
        }
      }
    }
  }

  // Find unresolved tool_use blocks from the most recent assistant message
  for (let i = records.length - 1; i >= 0; i--) {
    const record = records[i];
    if (record.type === 'assistant' && record.message?.content) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      for (const block of content) {
        if (block.type === 'tool_use' && !resolvedToolIds.has(block.id)) {
          pending.push({
            toolUseId: block.id,
            toolName: block.name,
            input: block.input,
            timestamp: record.timestamp,
            sessionId: record.sessionId,
            messageUuid: record.uuid
          });
        }
      }
      // Only check the most recent assistant message
      if (content.some(b => b.type === 'tool_use')) break;
    }
  }

  return pending;
}

// ─── Extract session summary from messages ───────────────────────────────────

function getSessionSummary(records) {
  // Find what the agent is working on from recent messages
  const recentAssistant = [...records].reverse().find(r =>
    r.type === 'assistant' && r.message?.content
  );

  if (recentAssistant?.message?.content) {
    const content = Array.isArray(recentAssistant.message.content)
      ? recentAssistant.message.content
      : [];
    const textBlock = content.find(b => b.type === 'text');
    if (textBlock?.text) {
      // Return first 150 chars of the most recent text
      return textBlock.text.substring(0, 150).replace(/\n/g, ' ');
    }
    const toolBlock = content.find(b => b.type === 'tool_use');
    if (toolBlock) {
      return `Using tool: ${toolBlock.name}`;
    }
  }

  // Fall back to user's last message
  const recentUser = [...records].reverse().find(r =>
    r.type === 'user' && typeof r.message?.content === 'string'
  );
  if (recentUser?.message?.content) {
    return `User: ${recentUser.message.content.substring(0, 150).replace(/\n/g, ' ')}`;
  }

  return 'No recent activity';
}

// ─── Format messages for API response ────────────────────────────────────────

function formatMessages(records, limit = 50) {
  const messages = [];
  for (const record of records.slice(-limit)) {
    if (record.type === 'user' && typeof record.message?.content === 'string') {
      messages.push({
        type: 'user',
        text: record.message.content,
        timestamp: record.timestamp,
        uuid: record.uuid
      });
    } else if (record.type === 'assistant' && record.message?.content) {
      const content = Array.isArray(record.message.content) ? record.message.content : [];
      const texts = [];
      const tools = [];

      for (const block of content) {
        if (block.type === 'text') texts.push(block.text);
        if (block.type === 'tool_use') {
          tools.push({
            id: block.id,
            name: block.name,
            input: summarizeToolInput(block.name, block.input)
          });
        }
      }

      messages.push({
        type: 'assistant',
        text: texts.join('\n'),
        tools,
        model: record.message.model,
        timestamp: record.timestamp,
        uuid: record.uuid,
        usage: record.message.usage
      });
    } else if (record.type === 'user' && Array.isArray(record.message?.content)) {
      // Tool results
      for (const block of record.message.content) {
        if (block.type === 'tool_result') {
          const resultText = typeof block.content === 'string'
            ? block.content.substring(0, 300)
            : JSON.stringify(block.content).substring(0, 300);
          messages.push({
            type: 'tool_result',
            toolUseId: block.tool_use_id,
            text: resultText,
            isError: block.is_error || false,
            timestamp: record.timestamp,
            uuid: record.uuid
          });
        }
      }
    } else if (record.type === 'system' && record.subtype === 'turn_duration') {
      messages.push({
        type: 'system',
        text: `Turn completed in ${(record.durationMs / 1000).toFixed(1)}s (${record.messageCount} messages)`,
        timestamp: record.timestamp,
        uuid: record.uuid
      });
    }
  }
  return messages;
}

function summarizeToolInput(toolName, input) {
  if (!input) return '';
  switch (toolName) {
    case 'Bash':
      return input.command || '';
    case 'Read':
      return input.file_path || '';
    case 'Write':
      return input.file_path || '';
    case 'Edit':
      return input.file_path || '';
    case 'Grep':
      return `${input.pattern || ''} in ${input.path || '.'}`;
    case 'Glob':
      return input.pattern || '';
    case 'Agent':
      return input.description || input.prompt?.substring(0, 80) || '';
    case 'TodoWrite':
      return `${(input.todos || []).length} tasks`;
    default:
      return JSON.stringify(input).substring(0, 100);
  }
}

// ─── API Endpoints ───────────────────────────────────────────────────────────

app.use(express.static('public'));
app.use(express.json({ limit: '25mb' }));

// GET /api/projects - List all projects
app.get('/api/projects', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      return res.json({ projects: [] });
    }
    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    const projects = dirs.map(dir => {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const jsonlFiles = fs.readdirSync(projectDir)
        .filter(f => f.endsWith('.jsonl'));

      // Get last modified time from JSONL files
      let lastActivity = 0;
      for (const f of jsonlFiles) {
        try {
          const stat = fs.statSync(path.join(projectDir, f));
          if (stat.mtimeMs > lastActivity) lastActivity = stat.mtimeMs;
        } catch {}
      }

      return {
        dirName: dir.name,
        name: projectPathToName(dir.name),
        fullPath: projectPathToFullPath(dir.name),
        sessionCount: jsonlFiles.length,
        lastActivity: lastActivity || null
      };
    });

    // Sort by last activity (most recent first)
    projects.sort((a, b) => (b.lastActivity || 0) - (a.lastActivity || 0));
    res.json({ projects });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects/:projectPath/sessions - List sessions for a project
app.get('/api/projects/:projectPath/sessions', (req, res) => {
  try {
    const projectDir = path.join(PROJECTS_DIR, req.params.projectPath);
    if (!fs.existsSync(projectDir)) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const jsonlFiles = fs.readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'));

    const sessions = jsonlFiles.map(f => {
      const sessionId = f.replace('.jsonl', '');
      const jsonlPath = path.join(projectDir, f);
      const meta = getSessionMeta(sessionId);

      const records = readLastNLines(jsonlPath, 30);
      const status = getSessionStatus(sessionId, meta, jsonlPath);
      const summary = getSessionSummary(records);

      // Extract slug from records
      const slug = records.find(r => r.slug)?.slug || null;
      const entrypoint = records.find(r => r.entrypoint)?.entrypoint || meta?.entrypoint || 'unknown';

      // Get file stats
      let fileSize = 0;
      let lastModified = null;
      try {
        const stat = fs.statSync(jsonlPath);
        fileSize = stat.size;
        lastModified = stat.mtimeMs;
      } catch {}

      const tokenStats = getSessionTokenStats(jsonlPath);

      return {
        sessionId,
        slug,
        entrypoint,
        startedAt: meta?.startedAt || null,
        cwd: meta?.cwd || null,
        status: status.status,
        statusDetail: status.detail,
        pid: status.pid,
        pendingApprovals: status.pendingApprovals || [],
        summary,
        fileSize,
        lastModified,
        messageCount: records.length,
        cost: tokenStats.estimated_cost,
        totalTokens: tokenStats.total_tokens
      };
    });

    // Sort by last modified (most recent first)
    sessions.sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
    res.json({ sessions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId - Full session details
app.get('/api/sessions/:sessionId', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const meta = getSessionMeta(sessionId);

    // Find the JSONL file
    const jsonlPath = findJsonlPath(sessionId);
    if (!jsonlPath) {
      return res.status(404).json({ error: 'Session JSONL not found' });
    }

    const records = readLastNLines(jsonlPath, 100);
    const status = getSessionStatus(sessionId, meta, jsonlPath);
    const messages = formatMessages(records);
    const summary = getSessionSummary(records);
    const slug = records.find(r => r.slug)?.slug || null;
    const entrypoint = records.find(r => r.entrypoint)?.entrypoint || meta?.entrypoint || 'unknown';
    const version = records.find(r => r.version)?.version || null;
    const gitBranch = records.find(r => r.gitBranch)?.gitBranch || null;

    const tokenStats = getSessionTokenStats(jsonlPath);

    res.json({
      sessionId,
      slug,
      entrypoint,
      version,
      gitBranch,
      startedAt: meta?.startedAt || null,
      cwd: meta?.cwd || null,
      status: status.status,
      statusDetail: status.detail,
      pid: status.pid,
      pendingApprovals: status.pendingApprovals || [],
      summary,
      messages,
      tokenStats
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId/messages
app.get('/api/sessions/:sessionId/messages', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const limit = parseInt(req.query.limit) || 50;
    const jsonlPath = findJsonlPath(sessionId);
    if (!jsonlPath) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const records = readLastNLines(jsonlPath, limit * 2); // Read more to account for non-message records
    const messages = formatMessages(records, limit);
    res.json({ messages });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId/status
app.get('/api/sessions/:sessionId/status', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const meta = getSessionMeta(sessionId);
    const jsonlPath = findJsonlPath(sessionId);

    if (!jsonlPath) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const status = getSessionStatus(sessionId, meta, jsonlPath);
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId/pending-approvals
app.get('/api/sessions/:sessionId/pending-approvals', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const jsonlPath = findJsonlPath(sessionId);
    if (!jsonlPath) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const records = readLastNLines(jsonlPath, 30);
    const approvals = findPendingApprovals(records);
    res.json({ approvals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:sessionId/approve
app.post('/api/sessions/:sessionId/approve', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const meta = getSessionMeta(sessionId);

    if (!meta?.pid) {
      return res.status(400).json({ error: 'No PID for session' });
    }

    if (!isProcessRunning(meta.pid)) {
      return res.status(400).json({ error: 'Process is not running' });
    }

    if (!isClaudeProcess(meta.pid)) {
      return res.status(400).json({ error: 'PID does not belong to a Claude process' });
    }

    const tty = getProcessTTY(meta.pid);
    if (!tty) {
      return res.status(400).json({ error: 'This session was launched by Claude Desktop — approve the permission directly in the Claude app window.' });
    }

    // Inject approval into TTY input queue via TIOCSTI
    try {
      injectInputToTTY(tty, 'y\n');
      broadcast({ type: 'approval:resolved', sessionId, action: 'approved' });
      res.json({ success: true, message: 'Approval sent', tty });
    } catch (writeErr) {
      res.status(500).json({ error: `Failed to inject into TTY: ${writeErr.message}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:sessionId/deny
app.post('/api/sessions/:sessionId/deny', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const meta = getSessionMeta(sessionId);

    if (!meta?.pid) {
      return res.status(400).json({ error: 'No PID for session' });
    }

    if (!isProcessRunning(meta.pid)) {
      return res.status(400).json({ error: 'Process is not running' });
    }

    const tty = getProcessTTY(meta.pid);
    if (!tty) {
      return res.status(400).json({ error: 'This session was launched by Claude Desktop — deny the permission directly in the Claude app window.' });
    }

    try {
      injectInputToTTY(tty, 'n\n');
      broadcast({ type: 'approval:resolved', sessionId, action: 'denied' });
      res.json({ success: true, message: 'Denial sent', tty });
    } catch (writeErr) {
      res.status(500).json({ error: `Failed to inject into TTY: ${writeErr.message}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Agent Control Endpoints ─────────────────────────────────────────────────

// POST /api/sessions/:sessionId/inject - Send a prompt to a running agent
app.post('/api/sessions/:sessionId/inject', (req, res) => {
  try {
    const sessionId = req.params.sessionId;
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    const meta = getSessionMeta(sessionId);
    if (!meta?.pid) return res.status(400).json({ error: 'No PID for session' });
    if (!isProcessRunning(meta.pid)) return res.status(400).json({ error: 'Process not running' });

    const tty = getProcessTTY(meta.pid);
    if (!tty) return res.status(400).json({ error: 'Could not find TTY' });

    try {
      injectInputToTTY(tty, prompt + '\n');
      broadcast({ type: 'session:injected', sessionId, prompt: prompt.substring(0, 100) });
      res.json({ success: true, message: 'Prompt injected' });
    } catch (writeErr) {
      res.status(500).json({ error: `Failed to inject: ${writeErr.message}` });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:sessionId/pause - Pause agent (SIGTSTP)
app.post('/api/sessions/:sessionId/pause', (req, res) => {
  try {
    const meta = getSessionMeta(req.params.sessionId);
    if (!meta?.pid) return res.status(400).json({ error: 'No PID' });
    if (!isProcessRunning(meta.pid)) return res.status(400).json({ error: 'Not running' });

    process.kill(meta.pid, 'SIGTSTP');
    broadcast({ type: 'session:paused', sessionId: req.params.sessionId });
    res.json({ success: true, message: 'Agent paused' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:sessionId/resume - Resume agent (SIGCONT)
app.post('/api/sessions/:sessionId/resume', (req, res) => {
  try {
    const meta = getSessionMeta(req.params.sessionId);
    if (!meta?.pid) return res.status(400).json({ error: 'No PID' });

    process.kill(meta.pid, 'SIGCONT');
    broadcast({ type: 'session:resumed', sessionId: req.params.sessionId });
    res.json({ success: true, message: 'Agent resumed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/sessions/:sessionId/kill - Terminate agent (SIGTERM)
app.post('/api/sessions/:sessionId/kill', (req, res) => {
  try {
    const meta = getSessionMeta(req.params.sessionId);
    if (!meta?.pid) return res.status(400).json({ error: 'No PID' });
    if (!isProcessRunning(meta.pid)) return res.status(400).json({ error: 'Already stopped' });

    process.kill(meta.pid, 'SIGTERM');
    broadcast({ type: 'session:killed', sessionId: req.params.sessionId });
    res.json({ success: true, message: 'Agent terminated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Token / Cost Tracking ───────────────────────────────────────────────────

const MODEL_PRICING = {
  'claude-opus-4-6':   { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.875 },
  'claude-sonnet-4-6': { input: 3,  output: 15, cacheWrite: 3.75,  cacheRead: 0.375 },
  'claude-haiku-4-5':  { input: 0.8, output: 4, cacheWrite: 1,     cacheRead: 0.08 },
};

function getDefaultPricing() {
  return MODEL_PRICING['claude-opus-4-6']; // Default to Opus
}

function calculateTokenCost(usage, model) {
  const pricing = MODEL_PRICING[model] || getDefaultPricing();
  const inputCost = ((usage.input_tokens || 0) / 1_000_000) * pricing.input;
  const outputCost = ((usage.output_tokens || 0) / 1_000_000) * pricing.output;
  const cacheWriteCost = ((usage.cache_creation_input_tokens || 0) / 1_000_000) * pricing.cacheWrite;
  const cacheReadCost = ((usage.cache_read_input_tokens || 0) / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheWriteCost + cacheReadCost;
}

// Cache keyed by "path:mtime" — invalidated automatically when file changes
const _tokenStatsCache = new Map();

function getSessionTokenStats(jsonlPath) {
  try {
    const mtime = fs.statSync(jsonlPath).mtimeMs;
    const cacheKey = `${jsonlPath}:${mtime}`;
    if (_tokenStatsCache.has(cacheKey)) return _tokenStatsCache.get(cacheKey);
    const result = _computeSessionTokenStats(jsonlPath);
    _tokenStatsCache.set(cacheKey, result);
    // Evict old entries for same path
    for (const k of _tokenStatsCache.keys()) {
      if (k.startsWith(jsonlPath + ':') && k !== cacheKey) _tokenStatsCache.delete(k);
    }
    return result;
  } catch {
    return _computeSessionTokenStats(jsonlPath);
  }
}

function _computeSessionTokenStats(jsonlPath) {
  const records = readLastNLines(jsonlPath, Infinity);
  let totalInput = 0, totalOutput = 0, totalCacheWrite = 0, totalCacheRead = 0;
  let totalCost = 0;
  let messageCount = 0;

  for (const record of records) {
    if (record.type === 'assistant' && record.message?.usage) {
      const u = record.message.usage;
      totalInput += u.input_tokens || 0;
      totalOutput += u.output_tokens || 0;
      totalCacheWrite += u.cache_creation_input_tokens || 0;
      totalCacheRead += u.cache_read_input_tokens || 0;
      totalCost += calculateTokenCost(u, record.message.model);
      messageCount++;
    }
  }

  return {
    input_tokens: totalInput,
    output_tokens: totalOutput,
    cache_write_tokens: totalCacheWrite,
    cache_read_tokens: totalCacheRead,
    total_tokens: totalInput + totalOutput + totalCacheWrite + totalCacheRead,
    estimated_cost: Math.round(totalCost * 10000) / 10000,
    message_count: messageCount
  };
}

// Date-filtered version: reads ALL records and filters by timestamp range
function getSessionTokenStatsByDate(jsonlPath, startDate, endDate) {
  try {
    const content = fs.readFileSync(jsonlPath, 'utf8');
    const lines = content.trim().split('\n');
    let totalCost = 0;
    let totalTokens = 0;

    for (const line of lines) {
      try {
        const record = JSON.parse(line);
        if (record.type === 'assistant' && record.message?.usage && record.timestamp) {
          const ts = new Date(record.timestamp).getTime();
          if (ts >= startDate && ts <= endDate) {
            const u = record.message.usage;
            totalTokens += (u.input_tokens || 0) + (u.output_tokens || 0) +
              (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            totalCost += calculateTokenCost(u, record.message.model);
          }
        }
      } catch {}
    }
    return { cost: Math.round(totalCost * 10000) / 10000, tokens: totalTokens };
  } catch {
    return { cost: 0, tokens: 0 };
  }
}

// GET /api/analytics/filtered?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get('/api/analytics/filtered', (req, res) => {
  try {
    const startStr = req.query.start;
    const endStr = req.query.end;
    const startDate = startStr ? new Date(startStr + 'T00:00:00').getTime() : 0;
    const endDate = endStr ? new Date(endStr + 'T23:59:59').getTime() : Date.now();

    if (!fs.existsSync(PROJECTS_DIR)) return res.json({ projects: [], totalCost: 0, totalTokens: 0 });

    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    const projects = [];
    let totalCost = 0;
    let totalTokens = 0;

    for (const dir of dirs) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

      let projectCost = 0;
      let projectTokens = 0;

      for (const f of jsonlFiles) {
        const stats = getSessionTokenStatsByDate(path.join(projectDir, f), startDate, endDate);
        projectCost += stats.cost;
        projectTokens += stats.tokens;
      }

      if (projectCost > 0) {
        totalCost += projectCost;
        totalTokens += projectTokens;
        projects.push({
          name: projectPathToName(dir.name),
          dirName: dir.name,
          sessionCount: jsonlFiles.length,
          totalCost: Math.round(projectCost * 10000) / 10000,
          totalTokens: projectTokens
        });
      }
    }

    projects.sort((a, b) => b.totalCost - a.totalCost);
    res.json({
      projects,
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalTokens,
      dateRange: { start: startStr || 'all', end: endStr || 'today' }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/sessions/:sessionId/tokens - Token usage for a session
app.get('/api/sessions/:sessionId/tokens', (req, res) => {
  try {
    const jsonlPath = findJsonlPath(req.params.sessionId);
    if (!jsonlPath) return res.status(404).json({ error: 'Session not found' });
    res.json(getSessionTokenStats(jsonlPath));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics - Aggregate cost/token stats across all projects
app.get('/api/analytics', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) return res.json({ projects: [], totalCost: 0 });

    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    const projects = [];
    let totalCost = 0;
    let totalTokens = 0;

    for (const dir of dirs) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

      let projectCost = 0;
      let projectTokens = 0;
      let sessionCount = jsonlFiles.length;

      for (const f of jsonlFiles) {
        const stats = getSessionTokenStats(path.join(projectDir, f));
        projectCost += stats.estimated_cost;
        projectTokens += stats.total_tokens;
      }

      totalCost += projectCost;
      totalTokens += projectTokens;

      projects.push({
        name: projectPathToName(dir.name),
        dirName: dir.name,
        sessionCount,
        totalCost: Math.round(projectCost * 10000) / 10000,
        totalTokens: projectTokens
      });
    }

    projects.sort((a, b) => b.totalCost - a.totalCost);

    res.json({
      projects,
      totalCost: Math.round(totalCost * 10000) / 10000,
      totalTokens
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analytics/insights - Activity trend, tool usage, model distribution, cache stats
let _insightsCache = null;
let _insightsCacheTime = 0;
app.get('/api/analytics/insights', (req, res) => {
  try {
    if (_insightsCache && Date.now() - _insightsCacheTime < 300000) {
      return res.json(_insightsCache);
    }
    if (!fs.existsSync(PROJECTS_DIR)) return res.json({ sessionsByDay: [], toolUsage: [], modelTokens: [], cacheStats: {} });

    const cutoff = Date.now() - 30 * 86400000;
    const sessionsByDay = {};
    for (let i = 0; i < 14; i++) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      sessionsByDay[d] = 0;
    }
    const toolCounts = {};
    const modelTokens = {};
    let totalIn = 0, totalOut = 0, totalCacheWrite = 0, totalCacheRead = 0;

    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    for (const dir of dirs) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const files = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));
      for (const f of files) {
        const fpath = path.join(projectDir, f);
        const stat = fs.statSync(fpath);
        // Sessions by day — use file mtime as proxy for last active day
        const dayKey = new Date(stat.mtimeMs).toISOString().slice(0, 10);
        if (dayKey in sessionsByDay) sessionsByDay[dayKey]++;

        // Scan records only if modified recently
        if (stat.mtimeMs < cutoff) continue;
        try {
          const lines = fs.readFileSync(fpath, 'utf8').trim().split('\n');
          for (const line of lines) {
            try {
              const rec = JSON.parse(line);
              if (rec.type === 'assistant' && rec.message) {
                const u = rec.message.usage;
                if (u) {
                  totalIn += u.input_tokens || 0;
                  totalOut += u.output_tokens || 0;
                  totalCacheWrite += u.cache_creation_input_tokens || 0;
                  totalCacheRead += u.cache_read_input_tokens || 0;
                }
                const model = (rec.message.model || 'unknown').replace(/-\d{8}$/, '');
                modelTokens[model] = (modelTokens[model] || 0) + (u ? (u.input_tokens || 0) + (u.output_tokens || 0) : 0);
                if (Array.isArray(rec.message.content)) {
                  for (const block of rec.message.content) {
                    if (block.type === 'tool_use') {
                      toolCounts[block.name] = (toolCounts[block.name] || 0) + 1;
                    }
                  }
                }
              }
            } catch {}
          }
        } catch {}
      }
    }

    const total = totalIn + totalOut + totalCacheWrite + totalCacheRead;
    const result = {
      sessionsByDay: Object.entries(sessionsByDay).map(([date, count]) => ({ date, count })).reverse(),
      toolUsage: Object.entries(toolCounts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([tool, count]) => ({ tool, count })),
      modelTokens: Object.entries(modelTokens).sort((a, b) => b[1] - a[1]).map(([model, tokens]) => ({ model, tokens })),
      cacheStats: { total, input: totalIn, output: totalOut, cacheWrite: totalCacheWrite, cacheRead: totalCacheRead,
        cacheHitRate: total > 0 ? Math.round(totalCacheRead / total * 100) : 0 }
    };
    _insightsCache = result;
    _insightsCacheTime = Date.now();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/config - Return non-secret config
app.get('/api/config', (req, res) => {
  const cfg = readConfig();
  res.json({ hasAdminKey: !!cfg.anthropicAdminKey, subscriptionCost: cfg.subscriptionCost || 108 });
});

// POST /api/config/plan - Save subscription cost
app.post('/api/config/plan', (req, res) => {
  const { subscriptionCost } = req.body;
  writeConfig({ subscriptionCost: parseFloat(subscriptionCost) || 108 });
  res.json({ success: true });
});

// POST /api/config/admin-key - Save the admin API key
app.post('/api/config/admin-key', (req, res) => {
  const { key } = req.body;
  if (!key || !key.startsWith('sk-ant-admin')) {
    return res.status(400).json({ error: 'Key must start with sk-ant-admin' });
  }
  writeConfig({ anthropicAdminKey: key });
  res.json({ success: true });
});

// DELETE /api/config/admin-key - Remove the saved admin key
app.delete('/api/config/admin-key', (req, res) => {
  const cfg = readConfig();
  delete cfg.anthropicAdminKey;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json({ success: true });
});

// GET /api/billing?start=YYYY-MM-DD&end=YYYY-MM-DD - Fetch actual costs from Anthropic
app.get('/api/billing', async (req, res) => {
  const cfg = readConfig();
  if (!cfg.anthropicAdminKey) {
    return res.status(401).json({ error: 'No admin API key configured' });
  }

  const start = req.query.start || new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
  const end = req.query.end || new Date().toISOString().split('T')[0];

  const startingAt = `${start}T00:00:00Z`;
  const endingAt = `${end}T23:59:59Z`;

  try {
    const params = new URLSearchParams({
      starting_at: startingAt,
      ending_at: endingAt,
      bucket_width: '1d'
    });

    const response = await fetch(
      `https://api.anthropic.com/v1/organizations/cost_report?${params}`,
      {
        headers: {
          'x-api-key': cfg.anthropicAdminKey,
          'anthropic-version': '2023-06-01'
        }
      }
    );

    if (!response.ok) {
      const body = await response.text();
      return res.status(response.status).json({ error: `Anthropic API error: ${response.status} ${body}` });
    }

    const data = await response.json();

    // Aggregate by day — amounts are in USD cents as decimal strings
    const byDay = {};
    let totalCents = 0;

    for (const bucket of (data.data || [])) {
      const day = bucket.starting_at.split('T')[0];
      let dayCents = 0;
      for (const result of (bucket.results || [])) {
        const cents = parseFloat(result.amount || 0);
        dayCents += cents;
        totalCents += cents;
      }
      byDay[day] = (byDay[day] || 0) + dayCents;
    }

    // Convert cents to dollars
    const days = Object.entries(byDay)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, cents]) => ({ date, cost: cents / 100 }));

    res.json({
      totalCost: totalCents / 100,
      days,
      dateRange: { start, end },
      hasMore: data.has_more || false
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Git Operations ──────────────────────────────────────────────────────────

function getProjectCwd(projectPath) {
  return projectPathToFullPath(projectPath);
}

function runGitCommand(cwd, cmd) {
  try {
    return { success: true, output: execSync(cmd, { cwd, encoding: 'utf8', timeout: 15000, shell: true }).trim() };
  } catch (err) {
    return { success: false, error: err.stderr?.trim() || err.message };
  }
}

// GET /api/projects/:projectPath/git/status
app.get('/api/projects/:projectPath/git/status', (req, res) => {
  const cwd = getProjectCwd(req.params.projectPath);
  const status = runGitCommand(cwd, 'git status --porcelain');
  const branch = runGitCommand(cwd, 'git branch --show-current');
  const diff = runGitCommand(cwd, 'git diff --stat');
  const remote = runGitCommand(cwd, 'git remote -v');
  const ahead = runGitCommand(cwd, 'git rev-list --count @{u}..HEAD 2>/dev/null || echo 0');

  if (!status.success) {
    return res.json({ isGitRepo: false, error: status.error });
  }

  const files = (status.output || '').split('\n').filter(Boolean).map(line => ({
    status: line.substring(0, 2).trim(),
    file: line.substring(3)
  }));

  res.json({
    isGitRepo: true,
    branch: branch.output || 'unknown',
    files,
    changedCount: files.length,
    diffStat: diff.output || '',
    remote: remote.output || '',
    commitsAhead: parseInt(ahead.output) || 0
  });
});

// GET /api/projects/:projectPath/git/log
app.get('/api/projects/:projectPath/git/log', (req, res) => {
  const cwd = getProjectCwd(req.params.projectPath);
  const result = runGitCommand(cwd, 'git log --format="%H|%s|%an|%ar" -10');

  if (!result.success) return res.status(400).json({ error: result.error });

  const commits = (result.output || '').split('\n').filter(Boolean).map(line => {
    const [hash, message, author, time] = line.split('|');
    return { hash, message, author, time };
  });

  res.json({ commits });
});

// POST /api/projects/:projectPath/git/commit
app.post('/api/projects/:projectPath/git/commit', (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const cwd = getProjectCwd(req.params.projectPath);
  const add = runGitCommand(cwd, 'git add -A');
  if (!add.success) return res.status(500).json({ error: `git add failed: ${add.error}` });

  const commit = runGitCommand(cwd, `git commit -m "${message.replace(/"/g, '\\"')}"`);
  if (!commit.success) return res.status(500).json({ error: commit.error });

  broadcast({ type: 'git:committed', project: req.params.projectPath, message });
  res.json({ success: true, output: commit.output });
});

// POST /api/projects/:projectPath/git/push
app.post('/api/projects/:projectPath/git/push', (req, res) => {
  const cwd = getProjectCwd(req.params.projectPath);
  const result = runGitCommand(cwd, 'git push');

  if (!result.success) return res.status(500).json({ error: result.error });

  broadcast({ type: 'git:pushed', project: req.params.projectPath });
  res.json({ success: true, output: result.output || 'Pushed successfully' });
});

// ─── Deploy (Netlify) ────────────────────────────────────────────────────────

const NETLIFY_CLI = '/opt/homebrew/bin/netlify';

// POST /api/projects/:projectPath/deploy
app.post('/api/projects/:projectPath/deploy', (req, res) => {
  const cwd = getProjectCwd(req.params.projectPath);

  // Run deploy async and stream status via WebSocket
  broadcast({ type: 'deploy:started', project: req.params.projectPath });

  exec(`${NETLIFY_CLI} deploy --prod --json`, {
    cwd, timeout: 120000, shell: true,
    env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
  }, (err, stdout, stderr) => {
    if (err) {
      broadcast({ type: 'deploy:failed', project: req.params.projectPath, error: stderr || err.message });
      return;
    }

    try {
      const result = JSON.parse(stdout);
      broadcast({
        type: 'deploy:completed',
        project: req.params.projectPath,
        url: result.deploy_url || result.url,
        siteUrl: result.site_url
      });
    } catch {
      broadcast({ type: 'deploy:completed', project: req.params.projectPath, output: stdout });
    }
  });

  res.json({ success: true, message: 'Deploy started - watch for WebSocket updates' });
});

// GET /api/projects/:projectPath/deploy/status
app.get('/api/projects/:projectPath/deploy/status', (req, res) => {
  const cwd = getProjectCwd(req.params.projectPath);
  try {
    const output = execSync(`${NETLIFY_CLI} status --json 2>/dev/null`, {
      cwd, encoding: 'utf8', timeout: 15000, shell: true,
      env: { ...process.env, PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin' }
    }).trim();
    const status = JSON.parse(output);
    res.json({ linked: true, ...status });
  } catch (err) {
    res.json({ linked: false, error: err.stderr?.trim() || err.message });
  }
});

// GET /api/health
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ─── Permissions (reads/writes ~/.claude/settings.json) ──────────────────────

const CLAUDE_SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

function readClaudeSettings() {
  try { return JSON.parse(fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf8')); } catch { return {}; }
}
function writeClaudeSettings(data) {
  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(data, null, 2));
}

app.get('/api/permissions', (req, res) => {
  const s = readClaudeSettings();
  res.json({ allow: s.permissions?.allow || [], deny: s.permissions?.deny || [] });
});

app.post('/api/permissions', (req, res) => {
  try {
    const { allow, deny } = req.body;
    if (!Array.isArray(allow) || !Array.isArray(deny)) {
      return res.status(400).json({ error: 'allow and deny must be arrays' });
    }
    const settings = readClaudeSettings();
    settings.permissions = { allow, deny };
    writeClaudeSettings(settings);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/overview - Dashboard summary
app.get('/api/overview', (req, res) => {
  try {
    if (!fs.existsSync(PROJECTS_DIR)) {
      return res.json({ totalProjects: 0, activeSessions: 0, waitingSessions: 0, completedSessions: 0, allSessions: [] });
    }

    const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'));

    let activeSessions = 0;
    let waitingSessions = 0;
    let completedSessions = 0;
    let processingSessions = 0;
    const allSessions = [];

    for (const dir of dirs) {
      const projectDir = path.join(PROJECTS_DIR, dir.name);
      const jsonlFiles = fs.readdirSync(projectDir).filter(f => f.endsWith('.jsonl'));

      for (const f of jsonlFiles) {
        const sessionId = f.replace('.jsonl', '');
        const jsonlPath = path.join(projectDir, f);
        const meta = getSessionMeta(sessionId);

        const records = readLastNLines(jsonlPath, 20);
        const status = getSessionStatus(sessionId, meta, jsonlPath);
        const slug = records.find(r => r.slug)?.slug || null;
        const entrypoint = records.find(r => r.entrypoint)?.entrypoint || meta?.entrypoint || 'unknown';

        switch (status.status) {
          case 'active': activeSessions++; break;
          case 'processing': processingSessions++; break;
          case 'waiting_for_approval': waitingSessions++; break;
          case 'completed': completedSessions++; break;
          case 'idle': activeSessions++; break; // Count idle as active for overview
        }

        const sessionTokens = getSessionTokenStats(jsonlPath);
        allSessions.push({
          sessionId,
          slug,
          entrypoint,
          projectName: projectPathToName(dir.name),
          projectDirName: dir.name,
          status: status.status,
          statusDetail: status.detail,
          pendingApprovals: status.pendingApprovals || [],
          summary: getSessionSummary(records),
          startedAt: meta?.startedAt || null,
          lastModified: (() => {
            try { return fs.statSync(jsonlPath).mtimeMs; } catch { return null; }
          })(),
          cost: sessionTokens.estimated_cost,
          totalTokens: sessionTokens.total_tokens
        });
      }
    }

    // Sort: waiting > active/processing > idle > completed; within each group by lastModified
    const statusRank = { waiting_for_approval: 0, active: 1, processing: 1, paused: 1, idle: 2, completed: 3 };
    allSessions.sort((a, b) => {
      const ra = statusRank[a.status] ?? 2;
      const rb = statusRank[b.status] ?? 2;
      if (ra !== rb) return ra - rb;
      return (b.lastModified || 0) - (a.lastModified || 0);
    });

    res.json({
      totalProjects: dirs.length,
      activeSessions,
      processingSessions,
      waitingSessions,
      completedSessions,
      allSessions
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/screenshot — saves base64 PNG from browser to assets/ (temp, for screenshot capture)
app.post('/api/screenshot', express.json({ limit: '20mb' }), (req, res) => {
  try {
    const { data, filename } = req.body;
    const base64 = data.replace(/^data:image\/\w+;base64,/, '');
    const outPath = path.join(__dirname, 'assets', filename || 'screenshot.png');
    fs.mkdirSync(path.join(__dirname, 'assets'), { recursive: true });
    fs.writeFileSync(outPath, Buffer.from(base64, 'base64'));
    res.json({ ok: true, path: outPath });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /api/server/restart — exits cleanly; LaunchAgent KeepAlive brings it back
app.post('/api/server/restart', (req, res) => {
  res.json({ success: true, message: 'Restarting...' });
  setTimeout(() => process.exit(0), 300);
});

// ─── Helper: find JSONL path for a session ───────────────────────────────────

function findJsonlPath(sessionId) {
  if (!fs.existsSync(PROJECTS_DIR)) return null;

  const dirs = fs.readdirSync(PROJECTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  for (const dir of dirs) {
    const jsonlPath = path.join(PROJECTS_DIR, dir.name, `${sessionId}.jsonl`);
    if (fs.existsSync(jsonlPath)) {
      return jsonlPath;
    }
  }
  return null;
}

// ─── WebSocket ───────────────────────────────────────────────────────────────

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === 1) { // WebSocket.OPEN
      client.send(msg);
    }
  }
}

wss.on('connection', (ws) => {
  console.log('Dashboard client connected');
  ws.on('close', () => console.log('Dashboard client disconnected'));
});

// ─── File Watchers ───────────────────────────────────────────────────────────

let debounceTimer = null;

function setupWatchers() {
  // Watch session metadata files
  if (fs.existsSync(SESSIONS_DIR)) {
    chokidar.watch(SESSIONS_DIR, {
      persistent: true,
      ignoreInitial: true,
      depth: 0
    }).on('add', (filePath) => {
      if (filePath.endsWith('.json')) {
        const sessionId = path.basename(filePath, '.json');
        console.log(`New session detected: ${sessionId}`);
        broadcast({ type: 'session:new', sessionId });
      }
    }).on('unlink', (filePath) => {
      if (filePath.endsWith('.json')) {
        const sessionId = path.basename(filePath, '.json');
        broadcast({ type: 'session:removed', sessionId });
      }
    });
  }

  // Watch project JSONL files
  if (fs.existsSync(PROJECTS_DIR)) {
    chokidar.watch(path.join(PROJECTS_DIR, '**', '*.jsonl'), {
      persistent: true,
      ignoreInitial: true,
      usePolling: false,
      awaitWriteFinish: { stabilityThreshold: 200 }
    }).on('change', (filePath) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const sessionId = path.basename(filePath, '.jsonl');
        const newRecords = readNewLines(filePath);

        if (newRecords.length > 0) {
          // Check for new pending approvals
          const approvals = findPendingApprovals(newRecords);
          if (approvals.length > 0) {
            broadcast({
              type: 'approval:pending',
              sessionId,
              approvals
            });
          }

          broadcast({
            type: 'session:update',
            sessionId,
            newMessages: formatMessages(newRecords)
          });
        }
      }, 100);
    }).on('add', (filePath) => {
      const sessionId = path.basename(filePath, '.jsonl');
      broadcast({ type: 'session:new', sessionId });
    });
  }
}

// ─── Start Server ────────────────────────────────────────────────────────────

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Conductor`);
  console.log(`  ─────────────────────`);
  console.log(`  Local:   http://localhost:${PORT}`);
  console.log(`  Claude:  ${CLAUDE_DIR}`);
  console.log(`  Projects: ${PROJECTS_DIR}\n`);
  setupWatchers();
});
