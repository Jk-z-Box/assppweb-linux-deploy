import { useAccountsStore } from './accounts';
import i18n from '../i18n';
import type { Account } from '../types';

const queues = new Map<string, Promise<unknown>>();

/** Serialize local actions and tabs, then read the latest server session. */
export function runAccountAction<T>(email: string, operation: (account: Account) => Promise<T>): Promise<T> {
  const run = async () => {
    await useAccountsStore.getState().loadAccounts();
    const { accounts, syncError } = useAccountsStore.getState();
    if (syncError) throw new Error(syncError);
    const account = accounts.find((item) => item.email === email);
    if (!account) throw new Error(i18n.t('accounts.detail.notFound'));
    return operation(account);
  };
  const locked = async (): Promise<T> => {
    if (typeof navigator !== 'undefined' && navigator.locks) {
      return await navigator.locks.request(`asspp-account:${email}`, run);
    }
    return run();
  };
  const result = (queues.get(email) ?? Promise.resolve()).then(locked, locked);
  queues.set(email, result);
  const clear = () => {
    if (queues.get(email) === result) queues.delete(email);
  };
  void result.then(clear, clear);
  return result;
}

export async function saveAccount(account: Account): Promise<Account> {
  // The vault's compare-and-swap rejects another device's concurrent edits.
  await useAccountsStore.getState().updateAccount(account);
  return useAccountsStore.getState().accounts.find((item) => item.email === account.email)!;
}
