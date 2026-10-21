import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { createGateway } from '../server.mjs';

const password = 'Testing-only-$pace password!';
const secret = 'b'.repeat(64);
const origin = 'https://apps.example.com';
const hash = bcrypt.hashSync(password, 4);
async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asspp-session-'));
  const hashFile = path.join(dir, 'auth.hash');
  fs.writeFileSync(hashFile, hash + '\n');
  let clock = Date.now();
  const options = {
    publicUrl: origin,
    username: 'tester',
    hashFile,
    dataDir: path.join(dir, 'sessions'),
    proxySecret: secret,
    now: () => clock,
  };
  let server;
  let base;
  async function start() {
    server = createGateway(options);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
  }
  async function close() {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  await start();
  t.after(async () => {
    await close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const request = async (url, { body, cookie, headers = {}, method = body ? 'POST' : 'GET' } = {}) =>
    fetch(base + url, {
      method,
      redirect: 'manual',
      headers: {
        'X-Asspp-Gateway-Secret': secret,
        Origin: origin,
        'X-Asspp-Peer': '192.0.2.1',
        'Content-Type': 'application/json',
        'X-Asspp-Request': 'session-v1',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  async function login(overrides = {}) {
    const result = await request('/_auth/login', {
      body: { username: 'tester', password, remember: true, ...overrides },
    });
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie');
  }
  return {
    request,
    login,
    hashFile,
    options,
    dir,
    advance: (ms) => {
      clock += ms;
    },
    restart: async () => {
      await close();
      await start();
    },
  };
}
const verifyHeaders = { 'X-Forwarded-Method': 'GET', 'X-Forwarded-Uri': '/api/accounts' };

test('existing bcrypt password creates opaque Secure HttpOnly host-only cookie; no credentials on disk', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  assert.match(cookie, /^__Host-asspp_session=[a-f0-9]{64}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=604800$/);
  const token = cookie.split(';')[0].split('=')[1];
  const stored = fs.readFileSync(path.join(f.options.dataDir, 'sessions.json'), 'utf8');
  assert.ok(!stored.includes(token) && !stored.includes(password));
  assert.equal(fs.statSync(path.join(f.options.dataDir, 'sessions.json')).mode & 0o777, 0o600);
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 204);
  assert.equal((await (await f.request('/_auth/session', { cookie })).json()).username, 'tester');
});
test('restart preserves unexpired sessions', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  await f.restart();
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 204);
});
test('password or username change revokes all previous sessions', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  fs.writeFileSync(f.hashFile, bcrypt.hashSync('Different-password!', 4));
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 401);
  fs.writeFileSync(f.hashFile, hash);
  const other = await f.login();
  f.options.username = 'changed';
  await f.restart();
  assert.equal((await f.request('/verify', { cookie: other, headers: verifyHeaders })).status, 401);
});
test('logout revokes a replayed cookie; logout-all revokes every device', async (t) => {
  const f = await fixture(t);
  const first = await f.login();
  const second = await f.login();
  const out = await f.request('/_auth/logout', { cookie: first, body: {} });
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await f.request('/verify', { cookie: first, headers: verifyHeaders })).status, 401);
  assert.equal((await f.request('/verify', { cookie: second, headers: verifyHeaders })).status, 204);
  const third = await f.login();
  assert.equal((await f.request('/_auth/logout-all', { cookie: second, body: {} })).status, 200);
  for (const cookie of [second, third])
    assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 401);
  await f.restart();
  assert.equal((await f.request('/verify', { cookie: third, headers: verifyHeaders })).status, 401);
});
test('idle and absolute expiry are enforced on server, regardless of cookie lifetime', async (t) => {
  const f = await fixture(t);
  let cookie = await f.login();
  f.advance(86400001);
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 401);
  cookie = await f.login();
  for (let hour = 0; hour < 168; hour++) {
    f.advance(3600000);
    await f.request('/verify', { cookie, headers: verifyHeaders });
  }
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 401);
});
test('non-remembered sessions have no persistent cookie and a two-hour idle timeout', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login({ remember: false });
  assert.ok(!cookie.includes('Max-Age'));
  f.advance(7200001);
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 401);
});
test('unauthenticated API and WebSocket get 401; document navigation redirects without Basic challenge', async (t) => {
  const f = await fixture(t);
  for (const uri of ['/api/accounts', '/wisp/']) {
    const r = await f.request('/verify', { headers: { ...verifyHeaders, 'X-Forwarded-Uri': uri } });
    assert.equal(r.status, 401);
    assert.equal(r.headers.get('www-authenticate'), null);
  }
  const r = await f.request('/verify', { headers: { ...verifyHeaders, 'X-Forwarded-Uri': '/', Accept: 'text/html' } });
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('location'), '/_auth/login');
});
test('Origin, Fetch Metadata and custom header checks stop login/logout and API/WebSocket CSRF', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  for (const url of ['/_auth/login', '/_auth/logout', '/_auth/logout-all']) {
    for (const headers of [
      { Origin: 'https://evil.example' },
      { Origin: '' },
      { 'Sec-Fetch-Site': 'same-site' },
      { 'Sec-Fetch-Site': 'cross-site' },
    ]) {
      assert.equal((await f.request(url, { cookie, headers, body: { username: 'tester', password } })).status, 403);
    }
    assert.equal((await f.request(url, { cookie, headers: { 'X-Asspp-Request': '' }, body: {} })).status, 400);
    assert.equal((await f.request(url, { cookie, headers: { 'Content-Type': 'text/plain' }, body: {} })).status, 400);
  }
  for (const headers of [
    { ...verifyHeaders, 'X-Forwarded-Method': 'DELETE', Origin: '' },
    { ...verifyHeaders, 'X-Forwarded-Uri': '/wisp/', Origin: 'https://evil.example' },
    { ...verifyHeaders, 'Sec-Fetch-Site': 'cross-site' },
  ])
    assert.equal((await f.request('/verify', { cookie, headers })).status, 403);
});
test('Basic authorization, forged cookies and query parameters cannot authenticate', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  const valid = cookie.split(';')[0];
  const headers = { ...verifyHeaders, Authorization: 'Basic ' + Buffer.from(`tester:${password}`).toString('base64') };
  for (const candidate of ['', '__Host-asspp_session=' + 'a'.repeat(64), valid + '; ' + valid]) {
    assert.equal((await f.request('/verify?token=' + valid, { cookie: candidate, headers })).status, 401);
  }
});
test('successful login rotates any previous session identifier', async (t) => {
  const f = await fixture(t);
  const old = await f.login();
  const r = await f.request('/_auth/login', { cookie: old, body: { username: 'tester', password } });
  assert.equal(r.status, 200);
  assert.notEqual(r.headers.get('set-cookie'), old);
  assert.equal((await f.request('/verify', { cookie: old, headers: verifyHeaders })).status, 401);
});
test('wrong username and password have the same generic response; brute-force attempts are throttled', async (t) => {
  const f = await fixture(t);
  const bodies = [];
  for (let i = 0; i < 5; i++) {
    const r = await f.request('/_auth/login', {
      body: { username: i % 2 ? 'tester' : 'wrong', password: i % 2 ? 'wrong' : password },
    });
    assert.equal(r.status, 401);
    bodies.push(await r.text());
  }
  assert.equal(new Set(bodies).size, 1);
  const r = await f.request('/_auth/login', { body: { username: 'tester', password } });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get('retry-after'), '300');
  f.advance(300001);
  await f.login();
});
test('gateway rejects direct requests without its proxy secret and fails closed on missing hash', async (t) => {
  const f = await fixture(t);
  const cookie = await f.login();
  assert.equal(
    (await f.request('/verify', { cookie, headers: { ...verifyHeaders, 'X-Asspp-Gateway-Secret': '' } })).status,
    403,
  );
  fs.unlinkSync(f.hashFile);
  assert.equal((await f.request('/verify', { cookie, headers: verifyHeaders })).status, 503);
  assert.equal((await f.request('/health')).status, 503);
});
test('login page has CSP and no external assets; response does not cache credentials', async (t) => {
  const f = await fixture(t);
  const r = await f.request('/_auth/login');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await r.text();
  assert.match(html, /网站用户名/);
  assert.ok(!html.includes('https://'));
  assert.equal((await f.request('/_auth/unknown')).status, 404);
});
test('HTTP public domains fail configuration; local mode uses a separate non-Secure test cookie', async (t) => {
  const f = await fixture(t);
  f.options.publicUrl = 'http://apps.example.com';
  assert.throws(() => createGateway(f.options), /HTTPS/);
  f.options.publicUrl = 'http://localhost:18080';
  await f.restart();
  const r = await f.request('/_auth/login', {
    headers: { Origin: f.options.publicUrl },
    body: { username: 'tester', password },
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('set-cookie'), /^asspp_local_session=/);
  assert.ok(!r.headers.get('set-cookie').includes('; Secure'));
});
test('corrupt session store fails closed at startup', async (t) => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.options.dataDir, 'sessions.json'), '{broken');
  assert.throws(() => createGateway(f.options));
});

test('global limit remains effective when client addresses rotate', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 30; i++) {
    const response = await f.request('/_auth/login', {
      headers: { 'X-Asspp-Peer': `192.0.2.${i}` },
      body: { username: 'tester', password: 'wrong' },
    });
    assert.equal(response.status, 401);
  }
  const response = await f.request('/_auth/login', {
    headers: { 'X-Asspp-Peer': '192.0.2.99' },
    body: { username: 'tester', password },
  });
  assert.equal(response.status, 429);
});

test('external document links lead to login; external API requests remain rejected', async (t) => {
  const f = await fixture(t);
  const response = await f.request('/verify', {
    headers: { ...verifyHeaders, 'X-Forwarded-Uri': '/', 'Sec-Fetch-Site': 'cross-site', Accept: 'text/html' },
  });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/_auth/login');
  assert.equal(
    (
      await f.request('/verify', {
        headers: { ...verifyHeaders, 'Sec-Fetch-Site': 'cross-site', Accept: 'text/html' },
      })
    ).status,
    403,
  );
});
