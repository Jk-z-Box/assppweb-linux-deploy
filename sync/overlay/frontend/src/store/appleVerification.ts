import { create } from 'zustand';
import { Authenticator, AuthenticationError } from '../apple/authenticate';
import i18n from '../i18n';
import type { Account } from '../types';

interface Challenge {
  email: string;
  submit: (code: string) => Promise<void>;
  cancel: () => void;
}
export const useAppleVerification = create<{ challenge: Challenge | null }>(() => ({ challenge: null }));
let verificationQueue: Promise<unknown> = Promise.resolve();

/** Preserve the SAP session through 2FA. No password or code is persisted here. */
export function renewAppleAccount(account: Account): Promise<Account> {
  const operation = verificationQueue.then(async () => {
    const auth = new Authenticator(account.deviceIdentifier, account.cookies);
    try {
      return await auth.authenticate(account.email, account.password);
    } catch (error) {
      if (!(error instanceof AuthenticationError) || !error.codeRequired) throw error;
    }
    return new Promise<Account>((resolve, reject) => {
      let settled = false;
      const finish = (updated?: Account) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        useAppleVerification.setState({ challenge: null });
        if (updated) resolve(updated);
        else reject(new Error(i18n.t('downloadRecovery.cancelled')));
      };
      const timer = setTimeout(() => finish(), 5 * 60 * 1000);
      useAppleVerification.setState({
        challenge: {
          email: account.email,
          cancel: () => finish(),
          submit: async (code) => {
            if (settled) return;
            if (!/^\d{6}$/.test(code)) throw new Error(i18n.t('downloadRecovery.codeRequired'));
            const updated = await auth.authenticate(account.email, account.password, code);
            finish(updated);
          },
        },
      });
    });
  });
  verificationQueue = operation.catch(() => undefined);
  return operation;
}
