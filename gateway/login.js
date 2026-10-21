'use strict';
const element = (id) => document.getElementById(id);
function error(message) {
  element('message').textContent = message;
  element('message').hidden = false;
}
async function request(url, body) {
  const response = await fetch(url, {
    method: body ? 'POST' : 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', 'X-Asspp-Request': 'session-v1' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败，请重试');
  return result;
}
async function load() {
  try {
    const status = await request('/_auth/session');
    element('login').hidden = status.authenticated;
    element('session').hidden = !status.authenticated;
    if (status.authenticated) {
      element('title').textContent = '你已登录';
      element('subtitle').textContent = `当前账号：${status.username}`;
    }
  } catch {
    error('无法连接登录服务，请刷新页面重试');
  } finally {
    element('loading').hidden = true;
  }
}
element('show-password').addEventListener('click', () => {
  const visible = element('password').type === 'password';
  element('password').type = visible ? 'text' : 'password';
  element('show-password').textContent = visible ? '隐藏' : '显示';
  element('show-password').setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
  element('show-password').setAttribute('aria-pressed', String(visible));
});
element('login').addEventListener('submit', async (event) => {
  event.preventDefault();
  element('message').hidden = true;
  element('submit').disabled = true;
  element('submit').textContent = '正在登录…';
  try {
    await request('/_auth/login', {
      username: element('username').value,
      password: element('password').value,
      remember: element('remember').checked,
    });
    element('password').value = '';
    window.location.replace('/');
  } catch (cause) {
    element('password').value = '';
    error(cause.message || '无法连接，请重试');
  } finally {
    element('submit').disabled = false;
    element('submit').textContent = '登录';
  }
});
for (const id of ['logout', 'logout-all'])
  element(id).addEventListener('click', async () => {
    element(id).disabled = true;
    try {
      await request(`/_auth/${id}`, {});
      window.location.replace('/_auth/login');
    } catch (cause) {
      error(cause.message || '无法连接，请重试');
    } finally {
      element(id).disabled = false;
    }
  });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) window.location.reload();
});
load();
