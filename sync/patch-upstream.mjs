import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('Usage: node patch-upstream.mjs UPSTREAM_DIRECTORY');
function replace(file, from, to) {
  const target = path.join(root, file);
  const text = fs.readFileSync(target, 'utf8');
  if (!text.includes(from) || text.indexOf(from) !== text.lastIndexOf(from)) {
    throw new Error(`Upstream integration anchor changed: ${file}`);
  }
  fs.writeFileSync(target, text.replace(from, to));
}

replace(
  'backend/src/index.ts',
  "import bagRoutes from './routes/bag.js';",
  "import bagRoutes from './routes/bag.js';\nimport { createAccountsRouter } from './routes/accounts.js';",
);
replace(
  'backend/src/index.ts',
  'app.use(httpsRedirect);',
  "app.use(httpsRedirect);\napp.use('/api/accounts', createAccountsRouter(config.dataDir, process.env.ACCOUNT_PROXY_TOKEN || '', config.publicBaseUrl));",
);
replace(
  'frontend/src/App.tsx',
  "import GlobalDownloadNotifier from './components/common/GlobalDownloadNotifier';",
  "import GlobalDownloadNotifier from './components/common/GlobalDownloadNotifier';\nimport AccountSync from './components/Account/AccountSync';",
);
replace('frontend/src/App.tsx', '<GlobalDownloadNotifier />', '<GlobalDownloadNotifier />\n        <AccountSync />');
replace(
  'frontend/src/components/Account/AccountDetail.tsx',
  'await updateAccount(updated);',
  'await updateAccount({ ...account, ...updated });',
);
replace(
  'frontend/src/hooks/useDownloadAction.ts',
  'await updateAccount(renewed);\n      currentAccount = renewed;',
  'currentAccount = { ...account, ...renewed };\n      await updateAccount(currentAccount);',
);
replace(
  'frontend/src/components/Settings/SettingsPage.tsx',
  'if (overwrite) await updateAccount(imported);',
  'if (overwrite) await updateAccount({ ...accounts.find((a) => a.email === imported.email)!, ...imported });',
);
replace(
  'frontend/src/components/Account/AccountDetail.tsx',
  'await removeAccount(account.email);',
  "try { await removeAccount(account.email); } catch (error) { addToast(getErrorMessage(error, '删除失败'), 'error'); return; }",
);
// React's text-node insertion can fail after browser translation replaces those nodes.
// The app has native language settings, so use them and opt out of automatic translation.
replace('frontend/index.html', '<html lang="en">', '<html lang="en" translate="no" class="notranslate">');
replace(
  'frontend/index.html',
  '<meta charset="UTF-8" />',
  '<meta charset="UTF-8" />\n    <meta name="google" content="notranslate" />',
);
replace(
  'frontend/src/components/Account/AccountList.tsx',
  '      {loading ? (',
  '      <p translate="no" className="mb-4 text-sm text-gray-500">服务端同步已启用 · 此网站的所有登录设备共用账号库</p>\n      {loading ? (',
);

for (const file of fs.readdirSync(path.join(root, 'frontend/src/locales'))) {
  if (!file.endsWith('.json')) continue;
  const target = path.join(root, 'frontend/src/locales', file);
  const data = JSON.parse(fs.readFileSync(target, 'utf8'));
  const chinese = file.startsWith('zh-');
  data.settings.data.description = chinese
    ? 'Apple ID 与会话加密保存在服务器，所有登录设备共用账号库。清理本机数据不会删除服务端账号。'
    : 'Apple IDs and sessions are encrypted on this server and shared by signed-in devices. Clearing this browser does not delete server accounts.';
  data.settings.data.confirm = chinese
    ? '清理本浏览器的旧账号副本和偏好设置？服务端账号会保留。'
    : 'Clear legacy accounts and preferences in this browser? Server accounts will remain.';
  data.accounts.detail.confirmDelete = chinese ? '确认从所有设备删除' : 'Confirm deletion on all devices';
  fs.writeFileSync(target, JSON.stringify(data, null, 2) + '\n');
}

replace(
  'frontend/src/components/Layout/Sidebar.tsx',
  '        <ThemeToggle />',
  '        <a href="/_auth/login" translate="no" className="mb-2 block rounded-lg px-3 py-2 text-sm text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">网站登录 / 退出</a>\n        <ThemeToggle />',
);
replace(
  'frontend/src/components/Settings/SettingsPage.tsx',
  "    <PageContainer title={t('settings.title')}>",
  '    <PageContainer title={t(\'settings.title\')}>\n      <a href="/_auth/login" translate="no" className="mb-6 inline-block rounded-lg border border-gray-300 px-4 py-2 text-sm text-blue-600 dark:border-gray-700 dark:text-blue-400">\u7f51\u7ad9\u767b\u5f55 / \u9000\u51fa</a>',
);
