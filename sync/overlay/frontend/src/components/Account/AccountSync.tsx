import { useEffect, useState } from 'react';
import { useAccountsStore } from '../../store/accounts';

export default function AccountSync() {
  const { loadAccounts, migrateLocalAccounts, syncError, legacyCount } = useAccountsStore();
  const [migrating, setMigrating] = useState(false);
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch('/_auth/session', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.timeout(10000),
        });
        if (response.ok && (await response.json()).authenticated === false) {
          useAccountsStore.setState({ accounts: [] });
          window.location.replace('/_auth/login');
        }
      } catch {
        /* A temporary network failure does not mean the session was revoked. */
      }
    };
    const refresh = () => {
      if (document.visibilityState === 'visible') {
        void loadAccounts();
        void checkSession();
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 15000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [loadAccounts]);
  if (!syncError && !legacyCount) return null;
  return (
    <aside
      translate="no"
      className="fixed bottom-20 left-4 right-4 z-50 mx-auto max-w-xl rounded-xl border border-blue-300 bg-white p-4 text-sm text-gray-900 shadow-lg dark:bg-gray-900 dark:text-white"
      aria-live="polite"
    >
      {syncError && <p role="alert">{syncError}</p>}
      {legacyCount > 0 && (
        <>
          <p>发现 {legacyCount} 个本机旧账号。迁移后，使用同一网站登录的设备均可访问这些 Apple ID。</p>
          <button
            type="button"
            disabled={migrating}
            className="mt-3 rounded bg-blue-600 px-4 py-2 text-white disabled:opacity-50"
            onClick={async () => {
              setMigrating(true);
              try {
                await migrateLocalAccounts();
              } catch (error) {
                useAccountsStore.setState({
                  syncError: (error as Error).message,
                });
              } finally {
                setMigrating(false);
              }
            }}
          >
            <span>{migrating ? '正在迁移…' : '迁移本机已有账号到服务器'}</span>
          </button>
        </>
      )}
      {syncError && (
        <button type="button" onClick={() => void loadAccounts()} className="ml-3 underline">
          重新同步
        </button>
      )}
    </aside>
  );
}
