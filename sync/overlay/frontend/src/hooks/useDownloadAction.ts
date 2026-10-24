import { useTranslation } from 'react-i18next';
import { useToastStore } from '../store/toast';
import { useDownloadsStore } from '../store/downloads';
import { runAccountAction, saveAccount } from '../store/accountActions';
import { renewAppleAccount } from '../store/appleVerification';
import { getDownloadInfo } from '../apple/download';
import { purchaseApp } from '../apple/purchase';
import { isExpiredSession, recoverDownload } from '../apple/downloadRecovery';
import { apiPost, apiGet } from '../api/client';
import { accountHash } from '../utils/account';
import { getErrorMessage } from '../utils/error';
import { getAccountContext } from '../utils/toast';
import type { Account, Software } from '../types';

/**
 * Shared hook for download & purchase actions.
 * Eliminates the duplicated flow across ProductDetail, VersionHistory, and AddDownload.
 */
export function useDownloadAction() {
  const addToast = useToastStore((s) => s.addToast);
  const fetchTasks = useDownloadsStore((s) => s.fetchTasks);
  const { t } = useTranslation();

  async function startDownload(account: Account, app: Software, versionId?: string) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    try {
      const settings = await apiGet<{ maxDownloadMB: number }>('/api/settings');
      if (settings.maxDownloadMB > 0 && app.fileSizeBytes) {
        const sizeMB = parseInt(app.fileSizeBytes, 10) / (1024 * 1024);
        if (sizeMB > settings.maxDownloadMB) {
          addToast(
            t('toast.downloadLimit.message', {
              appName,
              size: sizeMB.toFixed(2),
              limit: settings.maxDownloadMB,
            }),
            'error',
            t('toast.title.downloadLimit'),
          );
          return;
        }
      }
    } catch {
      // Settings fetch failed — backend will still enforce the limit
    }

    addToast(t('downloadRecovery.preparing'), 'info');
    await runAccountAction(account.email, async (latest) => {
      const recovered = await recoverDownload(latest, app, {
        download: (current) => getDownloadInfo(current, app, versionId),
        renew,
        purchase: async (current) => {
          addToast(t('downloadRecovery.acquiring'), 'info');
          const result = await purchaseApp(current, app);
          return saveAccount({ ...current, cookies: result.updatedCookies });
        },
      });
      const { output, updatedCookies } = recovered.result;
      await saveAccount({ ...recovered.account, cookies: updatedCookies });
      const hash = await accountHash(recovered.account);
      // Only submit the server download once, after all Apple recovery succeeds.
      await apiPost('/api/downloads', {
        software: { ...app, version: output.bundleShortVersionString },
        accountHash: hash,
        downloadURL: output.downloadURL,
        sinfs: output.sinfs,
        iTunesMetadata: output.iTunesMetadata,
      });
    });

    fetchTasks();

    addToast(t('toast.msg', { appName, ...ctx }), 'info', t('toast.title.downloadStarted'));
  }

  async function renew(account: Account): Promise<Account> {
    addToast(t('downloadRecovery.renewing'), 'info');
    const updated = await renewAppleAccount(account);
    return saveAccount({ ...account, ...updated });
  }

  async function acquireLicense(account: Account, app: Software) {
    const ctx = getAccountContext(account, t);
    const appName = app.name;

    const result = await runAccountAction(account.email, async (latest) => {
      let currentAccount = latest;
      let purchased;
      try {
        purchased = await purchaseApp(currentAccount, app);
      } catch (error) {
        if (!isExpiredSession(error)) throw error;
        currentAccount = await renew(currentAccount);
        purchased = await purchaseApp(currentAccount, app);
      }
      await saveAccount({ ...currentAccount, cookies: purchased.updatedCookies });
      return purchased;
    });

    addToast(
      t('toast.msg', { appName, ...ctx }),
      'success',
      result.alreadyOwned ? t('toast.title.licenseOwned') : t('toast.title.licenseSuccess'),
    );
  }

  function toastDownloadError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t('toast.msgFailed', {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t('toast.title.downloadFailed')),
      }),
      'error',
      t('toast.title.downloadFailed'),
    );
  }

  function toastLicenseError(account: Account, app: Software, error: unknown) {
    const ctx = getAccountContext(account, t);
    addToast(
      t('toast.msgFailed', {
        appName: app.name,
        ...ctx,
        error: getErrorMessage(error, t('toast.title.licenseFailed')),
      }),
      'error',
      t('toast.title.licenseFailed'),
    );
  }

  return {
    startDownload,
    acquireLicense,
    toastDownloadError,
    toastLicenseError,
  };
}
