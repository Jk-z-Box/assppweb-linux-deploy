import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Spinner from '../common/Spinner';
import { fetchFamilyInfo } from '../../apple/family';
import { getErrorMessage } from '../../utils/error';
import type { FamilyInfo } from '../../apple/family';
import type { Account } from '../../types';

export default function FamilySharing({ account }: { account: Account }) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<FamilyInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    generation.current++;
    setInfo(null);
    setError('');
    setBusy(false);
    return () => {
      generation.current++;
    };
  }, [account.email, account.directoryServicesIdentifier, account.deviceIdentifier, account.passwordToken]);

  async function check() {
    const current = ++generation.current;
    setBusy(true);
    setInfo(null);
    setError('');
    try {
      const result = await fetchFamilyInfo(account);
      if (generation.current === current) setInfo(result);
    } catch (err) {
      if (generation.current === current) setError(getErrorMessage(err, t('family.unavailable')));
    } finally {
      if (generation.current === current) setBusy(false);
    }
  }

  return (
    <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-black/5 dark:bg-gray-900 dark:ring-white/10 sm:p-6">
      <h2 className="text-lg font-semibold">{t('family.title')}</h2>
      <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('family.description')}</p>
      <button
        onClick={check}
        disabled={busy}
        className="mt-4 flex min-h-11 items-center gap-2 rounded-full bg-blue-50 px-5 py-2 text-sm font-semibold text-blue-600 hover:bg-blue-100 disabled:opacity-50 dark:bg-blue-950/40 dark:text-blue-400"
      >
        {busy && <Spinner />}
        {busy ? t('family.checking') : info ? t('family.refresh') : t('family.check')}
      </button>
      {error && (
        <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
      {info && (
        <div aria-live="polite">
          <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">
            {info.members.length
              ? t('family.verified', {
                  time: new Date(info.checkedAt).toLocaleTimeString(),
                })
              : t('family.empty')}
          </p>
          <ul className="mt-2 divide-y divide-gray-100 dark:divide-gray-800">
            {info.members.map((member) => (
              <li key={member.dsid} className="py-3">
                <p className="font-medium break-words">
                  {member.name || member.email || t('family.member')}
                  {member.current && (
                    <span className="ml-2 text-xs text-blue-600 dark:text-blue-400">{t('family.current')}</span>
                  )}
                </p>
                {member.email && <p className="text-sm text-gray-500 break-all">{member.email}</p>}
                <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                  {!member.active
                    ? t('family.inactive')
                    : member.sharingPurchases
                      ? t('family.sharingOn')
                      : t('family.sharingOff')}
                </p>
              </li>
            ))}
          </ul>
        </div>
      )}
      <p className="mt-4 text-sm text-gray-600 dark:text-gray-400">{t('family.downloadLimit')}</p>
      <a
        href="https://support.apple.com/102599"
        target="_blank"
        rel="noopener noreferrer"
        className="mt-2 inline-block text-sm font-medium text-blue-600 dark:text-blue-400"
      >
        {t('family.help')}
      </a>
    </section>
  );
}
