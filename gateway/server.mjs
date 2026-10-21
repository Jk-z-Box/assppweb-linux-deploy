import { createServer } from 'node:http';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const equal = (a, b) =>
  typeof a === 'string' &&
  typeof b === 'string' &&
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));

// One gateway process owns this small, bounded session store. Only token hashes go on disk.
export function createGateway({ publicUrl, username, hashFile, dataDir, proxySecret, now = Date.now }) {
  const origin = new URL(publicUrl).origin;
  const secure = origin.startsWith('https://');
  if (!secure && !/^http:\/\/localhost:\d+$/.test(origin)) throw new Error('Public HTTPS is required');
  if (!/^[a-f0-9]{64}$/.test(proxySecret) || !username) throw new Error('Invalid gateway configuration');
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dataDir, 0o700);
  const filename = path.join(dataDir, 'sessions.json');
  let state = { revision: '', sessions: {} };
  if (fs.existsSync(filename)) {
    state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (
      typeof state.revision !== 'string' ||
      !state.sessions ||
      typeof state.sessions !== 'object' ||
      Array.isArray(state.sessions) ||
      Object.keys(state.sessions).length > 50 ||
      Object.entries(state.sessions).some(
        ([id, s]) =>
          !/^[a-f0-9]{64}$/.test(id) ||
          !s ||
          !Number.isFinite(s.expires) ||
          !Number.isFinite(s.lastSeen) ||
          !Number.isFinite(s.idle),
      )
    )
      throw new Error('Invalid session store');
  }
  function save() {
    const temporary = `${filename}.${randomBytes(8).toString('hex')}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temporary, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, filename);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }
  function credentials() {
    const hash = fs.readFileSync(hashFile, 'utf8').trim();
    if (!/^\$2[aby]\$(0[4-9]|1[0-6])\$[./A-Za-z0-9]{53}$/.test(hash)) throw new Error('Invalid password hash');
    const revision = digest(`${origin}\n${username}\n${hash}`);
    if (revision !== state.revision) {
      state = { revision, sessions: {} };
      save();
    }
    return { hash, revision };
  }
  credentials();
  const cookieName = secure ? '__Host-asspp_session' : 'asspp_local_session';
  const cookie = (token, maxAge) =>
    `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}${maxAge === undefined ? '' : `; Max-Age=${maxAge}`}`;
  function sessionKey(req) {
    const matches = (req.headers.cookie || '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(`${cookieName}=`));
    if (matches.length !== 1) return null;
    const token = matches[0].slice(cookieName.length + 1);
    return /^[a-f0-9]{64}$/.test(token) ? digest(token) : null;
  }
  function session(req) {
    credentials();
    const id = sessionKey(req);
    const entry = id && state.sessions[id];
    if (!entry) return null;
    if (entry.expires <= now() || entry.lastSeen + entry.idle <= now()) {
      delete state.sessions[id];
      save();
      return null;
    }
    if (now() - entry.lastSeen >= 60000) {
      entry.lastSeen = now();
      save();
    }
    return { id, ...entry };
  }
  const assets = new Map(
    [
      ['/_auth/login', ['login.html', 'text/html; charset=utf-8']],
      ['/_auth/login.js', ['login.js', 'text/javascript; charset=utf-8']],
      ['/_auth/login.css', ['login.css', 'text/css; charset=utf-8']],
    ].map(([url, [file, type]]) => [url, { body: fs.readFileSync(path.join(here, file)), type }]),
  );
  const attempts = new Map();
  let globalAttempts = [];
  let busy = 0;
  function limited(ip) {
    const cutoff = now() - 300000;
    globalAttempts = globalAttempts.filter((v) => v > cutoff);
    for (const [key, values] of attempts) {
      const live = values.filter((v) => v > cutoff);
      if (live.length) attempts.set(key, live);
      else attempts.delete(key);
    }
    const recent = attempts.get(ip) || [];
    if (busy >= 2 || recent.length >= 5 || globalAttempts.length >= 30) return true;
    attempts.set(ip, [...recent, now()]);
    globalAttempts.push(now());
    return false;
  }
  const send = (res, code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  function sameOrigin(req) {
    return req.headers.origin === origin && !['cross-site', 'same-site'].includes(req.headers['sec-fetch-site']);
  }
  async function body(req) {
    if (
      req.headers['content-type']?.split(';')[0] !== 'application/json' ||
      req.headers['x-asspp-request'] !== 'session-v1'
    )
      return null;
    req.setEncoding('utf8');
    let raw = '';
    for await (const chunk of req) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 4096) throw new Error('Body too large');
    }
    try {
      const value = JSON.parse(raw);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Kept on gateway pages only: the upstream WASM application needs its own CSP.
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const url = new URL(req.url, origin);
      if (req.method === 'GET' && url.pathname === '/health') {
        credentials();
        send(res, 200, { ok: true });
        return;
      }
      if (!equal(req.headers['x-asspp-gateway-secret'], proxySecret)) {
        send(res, 403, { error: 'Forbidden' });
        return;
      }
      const asset = assets.get(url.pathname);
      if (req.method === 'GET' && asset) {
        res.writeHead(200, { 'Content-Type': asset.type });
        res.end(asset.body);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/verify') {
        const method = req.headers['x-forwarded-method'];
        const original = req.headers['x-forwarded-uri'] || '/';
        const websocket =
          String(req.headers.upgrade || '').toLowerCase() === 'websocket' || original.startsWith('/wisp');
        const navigation =
          method === 'GET' && !websocket && !original.startsWith('/api/') && req.headers.accept?.includes('text/html');
        if (navigation && req.headers['sec-fetch-site'] === 'cross-site') {
          res.writeHead(302, { Location: '/_auth/login' });
          res.end();
          return;
        }
        if (
          !method ||
          req.headers['sec-fetch-site'] === 'cross-site' ||
          ((websocket || !['GET', 'HEAD', 'OPTIONS'].includes(method)) && !sameOrigin(req))
        ) {
          send(res, 403, { error: '来源校验失败，请从本站重新操作' });
          return;
        }
        if (session(req)) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (navigation) {
          res.writeHead(302, { Location: '/_auth/login' });
          res.end();
        } else send(res, 401, { error: '网站登录已过期，请重新登录', login: '/_auth/login' });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/_auth/session') {
        const current = session(req);
        send(
          res,
          200,
          current ? { authenticated: true, username, expires: current.expires } : { authenticated: false },
        );
        return;
      }
      if (req.method !== 'POST' || !['/_auth/login', '/_auth/logout', '/_auth/logout-all'].includes(url.pathname)) {
        send(res, 404, { error: 'Not found' });
        return;
      }
      if (!sameOrigin(req)) {
        send(res, 403, { error: '来源校验失败，请刷新页面' });
        return;
      }
      const input = await body(req);
      if (!input) {
        send(res, 400, { error: '请求无效' });
        return;
      }
      if (url.pathname === '/_auth/login') {
        if (limited(req.headers['x-asspp-peer'] || 'unknown')) {
          res.setHeader('Retry-After', '300');
          send(res, 429, { error: '尝试过于频繁，请在 5 分钟后重试' });
          return;
        }
        if (
          typeof input.username !== 'string' ||
          typeof input.password !== 'string' ||
          Buffer.byteLength(input.password) > 72
        ) {
          send(res, 401, { error: '用户名或密码不正确' });
          return;
        }
        const expected = credentials();
        busy++;
        let matches;
        try {
          matches = await bcrypt.compare(input.password, expected.hash);
        } finally {
          busy--;
        }
        if (!matches || !equal(input.username, username) || credentials().revision !== expected.revision) {
          send(res, 401, { error: '用户名或密码不正确' });
          return;
        }
        const previous = sessionKey(req);
        if (previous) delete state.sessions[previous];
        for (const [id, entry] of Object.entries(state.sessions)) {
          if (entry.expires <= now() || entry.lastSeen + entry.idle <= now()) delete state.sessions[id];
        }
        if (Object.keys(state.sessions).length >= 50) {
          const oldest = Object.keys(state.sessions).sort(
            (a, b) => state.sessions[a].lastSeen - state.sessions[b].lastSeen,
          )[0];
          delete state.sessions[oldest];
        }
        const remember = input.remember === true;
        const seconds = remember ? 604800 : 43200;
        const token = randomBytes(32).toString('hex');
        state.sessions[digest(token)] = {
          expires: now() + seconds * 1000,
          lastSeen: now(),
          idle: (remember ? 86400 : 7200) * 1000,
        };
        save();
        res.setHeader('Set-Cookie', cookie(token, remember ? seconds : undefined));
        send(res, 200, { ok: true });
        return;
      }
      const current = session(req);
      if (!current) {
        send(res, 401, { error: '网站登录已过期' });
        return;
      }
      if (url.pathname === '/_auth/logout-all') state.sessions = {};
      else delete state.sessions[current.id];
      save();
      res.setHeader('Set-Cookie', cookie('', 0));
      send(res, 200, { ok: true });
    } catch {
      // Never log bodies, credentials, cookies, or raw errors containing request data.
      if (!res.headersSent) send(res, 503, { error: '登录服务暂不可用，请稍后重试' });
      else res.end();
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const server = createGateway({
      publicUrl: process.env.PUBLIC_URL,
      username: process.env.AUTH_USERNAME,
      hashFile: process.env.AUTH_HASH_FILE || '/config/auth.hash',
      dataDir: process.env.SESSION_DIR || '/sessions',
      proxySecret: process.env.ACCOUNT_PROXY_TOKEN,
    });
    server.listen(Number(process.env.PORT || 3000), '0.0.0.0', () => console.log('Session gateway ready'));
  } catch {
    console.error('Session gateway configuration or storage is invalid');
    process.exit(1);
  }
}
