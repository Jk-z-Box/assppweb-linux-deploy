import { DownloadError } from './downloadProduct';
import { PurchaseError } from './purchase';
import type { Account, Software } from '../types';

interface RecoveryDependencies<T> {
  download: (account: Account) => Promise<T>;
  renew: (account: Account) => Promise<Account>;
  purchase: (account: Account) => Promise<Account>;
}

export function isExpiredSession(error: unknown): boolean {
  return (
    (error instanceof DownloadError || error instanceof PurchaseError) &&
    (error.code === '2034' || error.code === '2042')
  );
}

/** Recover only explicit Apple errors. HTTP 403 is not proof of expiration. */
export async function recoverDownload<T>(initial: Account, app: Software, deps: RecoveryDependencies<T>) {
  let account = initial;
  let renewed = false;
  let acquired = false;
  const withRenewal = async <R>(operation: (account: Account) => Promise<R>): Promise<R> => {
    try {
      return await operation(account);
    } catch (error) {
      if (renewed || !isExpiredSession(error)) throw error;
      renewed = true;
      account = await deps.renew(account);
      return operation(account);
    }
  };
  try {
    return { result: await withRenewal(deps.download), account };
  } catch (error) {
    if (!(error instanceof DownloadError) || error.code !== '9610' || app.price !== 0 || acquired) throw error;
    acquired = true;
    account = await withRenewal(deps.purchase);
    return { result: await withRenewal(deps.download), account };
  }
}
