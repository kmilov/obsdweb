import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// Minimal zero-dependency .env loader (real env vars take precedence).
function loadEnvFile(file) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch {}
}
loadEnvFile(path.join(__dirname, '.env'));

const DEFAULT_VAULT = path.join(
  process.env.HOME,
  'Library/Mobile Documents/iCloud~md~obsidian/Documents/me'
);

// Parse CLI args: node server.mjs [vault-path] [--vault <path>] [--port <n>]
function parseArgs(argv) {
  const args = { vault: null, port: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--vault' || a === '-v') {
      args.vault = argv[++i];
    } else if (a === '--port' || a === '-p') {
      args.port = argv[++i];
    } else if (!a.startsWith('-')) {
      args.vault = a;
    }
  }
  return args;
}

const args = parseArgs(process.argv.slice(2));
const VAULT_ROOT = path.resolve(args.vault || process.env.VAULT_PATH || DEFAULT_VAULT);
const PORT = Number(args.port || process.env.PORT || 8787);

// ---- Authentication (optional password gate) ----

const APP_PASSWORD = process.env.APP_PASSWORD || null;
const APP_PASSWORD_HASH = process.env.APP_PASSWORD_HASH || null;
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const SESSION_TTL_HOURS = Number(process.env.SESSION_TTL_HOURS || 24 * 7);
const SESSION_TTL_MS = SESSION_TTL_HOURS * 3600 * 1000;
const COOKIE_NAME = 'obsidian_web_session';
const AUTH_ENABLED = Boolean(APP_PASSWORD || APP_PASSWORD_HASH);

function verifyPassword(input) {
  if (APP_PASSWORD_HASH) {
    const [saltHex, hashHex] = APP_PASSWORD_HASH.split(':');
    if (!saltHex || !hashHex) return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(input, salt, expected.length);
    return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
  }
  if (APP_PASSWORD) {
    const a = Buffer.from(input, 'utf8');
    const b = Buffer.from(APP_PASSWORD, 'utf8');
    const len = Math.max(a.length, b.length);
    const A = Buffer.alloc(len); a.copy(A);
    const B = Buffer.alloc(len); b.copy(B);
    return crypto.timingSafeEqual(A, B);
  }
  return false;
}

function makeSessionToken() {
  const payload = String(Date.now() + SESSION_TTL_MS);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

function validSession(token) {
  if (!token) return false;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(sig, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  const expiry = Number(payload);
  return Number.isFinite(expiry) && expiry > Date.now();
}

function getCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

function setSessionCookie(res, token, maxAgeMs) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(maxAgeMs / 1000)}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 10_000_000) {
        reject(new Error('payload too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Resolve a vault-relative path, reject any traversal outside the vault.
function safePath(rel) {
  if (typeof rel !== 'string' || rel.includes('\0') || rel === '') {
    throw new Error('invalid path');
  }
  const root = path.resolve(VAULT_ROOT);
  const target = path.resolve(root, rel);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('path outside vault');
  }
  return target;
}

async function buildTree(dir, rel = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const nodes = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // skip .obsidian, .DS_Store, hidden
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = await buildTree(path.join(dir, e.name), childRel);
      if (children.length) {
        nodes.push({ name: e.name, path: childRel, type: 'dir', children });
      }
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      nodes.push({ name: e.name, path: childRel, type: 'file' });
    }
  }
  nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1
  );
  return nodes;
}

async function collectMarkdownFiles(dir, rel = '') {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      files.push(...await collectMarkdownFiles(path.join(dir, e.name), childRel));
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      files.push(childRel);
    }
  }
  return files;
}

async function searchVault(query) {
  const q = query.toLowerCase();
  const files = await collectMarkdownFiles(VAULT_ROOT);
  const results = [];
  for (const rel of files) {
    const content = await fsp.readFile(path.join(VAULT_ROOT, rel), 'utf8');
    if (!content.toLowerCase().includes(q)) continue;
    const snippets = [];
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(q)) {
        snippets.push({ line: i + 1, text: lines[i].trim().slice(0, 160) });
        if (snippets.length >= 3) break;
      }
    }
    results.push({ path: rel, name: path.basename(rel), snippets });
    if (results.length >= 30) break;
  }
  return results;
}

async function getBacklinks(targetPath) {
  if (!targetPath) return [];
  const base = path.basename(targetPath).replace(/\.md$/i, '');
  if (!base) return [];
  const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('\\[\\[' + escaped + '(\\]\\]|[#|])', 'i');
  const files = await collectMarkdownFiles(VAULT_ROOT);
  const results = [];
  for (const rel of files) {
    if (rel === targetPath) continue;
    const content = await fsp.readFile(path.join(VAULT_ROOT, rel), 'utf8');
    if (re.test(content)) {
      results.push({ path: rel, name: path.basename(rel) });
    }
  }
  results.sort((a, b) => a.name.localeCompare(b.name));
  return results;
}

async function handleApi(req, res, url) {
  try {
    if (req.method === 'GET' && url.pathname === '/api/tree') {
      return sendJson(res, 200, await buildTree(VAULT_ROOT));
    }

    if (req.method === 'GET' && url.pathname === '/api/search') {
      const q = (url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { results: [] });
      return sendJson(res, 200, { results: await searchVault(q) });
    }

    if (req.method === 'GET' && url.pathname === '/api/backlinks') {
      const p = url.searchParams.get('path') || '';
      return sendJson(res, 200, { results: await getBacklinks(p) });
    }

    if (req.method === 'GET' && url.pathname === '/api/file') {
      const target = safePath(url.searchParams.get('path'));
      if (!fs.existsSync(target)) {
        return sendJson(res, 404, { ok: false, error: 'not found' });
      }
      const content = await fsp.readFile(target, 'utf8');
      const stat = await fsp.stat(target);
      return sendJson(res, 200, { content, mtime: stat.mtimeMs });
    }

    if (req.method === 'PUT' && url.pathname === '/api/file') {
      const body = JSON.parse(await readBody(req));
      const target = safePath(body.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      // Atomic write: temp file then rename (same volume).
      const tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      await fsp.writeFile(tmp, body.content ?? '', 'utf8');
      await fsp.rename(tmp, target);
      const stat = await fsp.stat(target);
      return sendJson(res, 200, { ok: true, mtime: stat.mtimeMs });
    }

    if (req.method === 'POST' && url.pathname === '/api/file') {
      const body = JSON.parse(await readBody(req));
      const target = safePath(body.path);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      const content = body.content ?? '';
      if (!fs.existsSync(target)) {
        await fsp.writeFile(target, content, 'utf8');
        return sendJson(res, 201, { ok: true, created: true });
      }
      return sendJson(res, 409, { ok: false, error: 'already exists' });
    }

    if (req.method === 'DELETE' && url.pathname === '/api/file') {
      const target = safePath(url.searchParams.get('path'));
      await fsp.unlink(target);
      return sendJson(res, 200, { ok: true });
    }

    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (err) {
    const status = /outside vault|invalid path/.test(err.message) ? 400 : 500;
    return sendJson(res, status, { ok: false, error: err.message });
  }
}

async function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.resolve(PUBLIC_DIR, '.' + p);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await fsp.readFile(file);
    const ext = path.extname(file).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderLogin(next, error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>vault — sign in</title>
<style>
  :root { --bg:#1e1e1e; --bg2:#252526; --bg3:#2d2d30; --border:#333; --fg:#d4d4d4; --accent:#6b9fff; }
  * { box-sizing:border-box; }
  body { margin:0; height:100vh; display:flex; align-items:center; justify-content:center; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { width:320px; background:var(--bg2); border:1px solid var(--border); border-radius:10px; padding:28px; }
  h1 { margin:0 0 6px; font-size:20px; }
  .sub { margin:0 0 18px; color:#8a8a8a; font-size:13px; }
  input[type=password] { width:100%; padding:10px 12px; background:var(--bg); color:var(--fg); border:1px solid var(--border); border-radius:6px; font-size:14px; }
  input[type=password]:focus { outline:none; border-color:var(--accent); }
  button { width:100%; margin-top:12px; padding:10px; background:var(--accent); color:#fff; border:none; border-radius:6px; font-size:14px; font-weight:600; cursor:pointer; }
  button:hover { filter:brightness(1.1); }
  .err { color:#ff6b6b; margin:0 0 12px; font-size:13px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/login">
    <h1>vault</h1>
    <p class="sub">Enter your password to continue.</p>
    ${error ? `<p class="err">${esc(error)}</p>` : ''}
    <input type="hidden" name="next" value="${esc(next)}">
    <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
</body>
</html>`;
}

const loginAttempts = new Map(); // ip -> { count, firstAt }
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;

function tooManyAttempts(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec) return false;
  if (Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return rec.count >= LOGIN_MAX_FAILURES;
}

function recordLoginFailure(ip) {
  const rec = loginAttempts.get(ip);
  if (!rec || Date.now() - rec.firstAt > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, firstAt: Date.now() });
  } else {
    rec.count++;
  }
}

function resetLoginFailures(ip) {
  loginAttempts.delete(ip);
}

// ---- File watching (Server-Sent Events) ----

const sseClients = new Set();
let watchTimer = null;

function broadcastVaultChange() {
  for (const res of sseClients) {
    try { res.write('data: {}\n\n'); } catch {}
  }
}

function scheduleBroadcast() {
  clearTimeout(watchTimer);
  watchTimer = setTimeout(broadcastVaultChange, 300);
}

function watchVault() {
  try {
    const watcher = fs.watch(VAULT_ROOT, { recursive: true }, (_event, filename) => {
      if (!filename) return scheduleBroadcast();
      if (filename.includes('.tmp-')) return;
      if (filename.split(path.sep).some((p) => p.startsWith('.'))) return;
      scheduleBroadcast();
    });
    watcher.on('error', () => {});
  } catch {}
}

function handleEvents(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write(': connected\n\n');
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
}

async function handleLogin(req, res, url) {
  if (req.method === 'GET') {
    const next = url.searchParams.get('next') || '/';
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(renderLogin(next));
    return;
  }
  if (req.method === 'POST') {
    const ip = req.socket.remoteAddress || 'unknown';
    if (tooManyAttempts(ip)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Too many attempts. Try again later.');
    }
    const params = new URLSearchParams(await readBody(req));
    const password = params.get('password') || '';
    const next = params.get('next') || '/';
    if (verifyPassword(password)) {
      resetLoginFailures(ip);
      setSessionCookie(res, makeSessionToken(), SESSION_TTL_MS);
      const target = next.startsWith('/') && !next.startsWith('//') ? next : '/';
      res.writeHead(302, { Location: target });
      return res.end();
    }
    recordLoginFailure(ip);
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderLogin(next, 'Wrong password'));
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (AUTH_ENABLED) {
    if (url.pathname === '/login') return handleLogin(req, res, url);
    if (url.pathname === '/logout') {
      clearSessionCookie(res);
      res.writeHead(302, { Location: '/login' });
      return res.end();
    }
    if (!validSession(getCookie(req, COOKIE_NAME))) {
      if (url.pathname.startsWith('/api/')) {
        return sendJson(res, 401, { ok: false, error: 'unauthorized' });
      }
      const next = url.pathname + url.search;
      res.writeHead(302, { Location: '/login?next=' + encodeURIComponent(next) });
      return res.end();
    }
  }

  if (url.pathname === '/api/events') {
    return handleEvents(req, res);
  }

  if (url.pathname.startsWith('/api/')) {
    return handleApi(req, res, url);
  }
  return serveStatic(req, res, url);
});

server.listen(PORT, () => {
  console.log(`obsidian-web running at http://localhost:${PORT}`);
  console.log(`vault: ${VAULT_ROOT}`);
  watchVault();
  console.log(AUTH_ENABLED ? 'auth: password gate ENABLED' : 'auth: DISABLED (set APP_PASSWORD or APP_PASSWORD_HASH in .env)');
});
