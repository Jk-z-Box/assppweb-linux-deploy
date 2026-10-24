import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '../common/Modal';
import { useAppleVerification } from '../../store/appleVerification';

export default function AppleVerification() {
  const { t } = useTranslation();
  const challenge = useAppleVerification((state) => state.challenge);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    setCode('');
    setError('');
    setBusy(false);
  }, [challenge]);
  useEffect(() => () => useAppleVerification.getState().challenge?.cancel(), []);
  if (!challenge) return null;
  return (
    <Modal
      open
      onClose={() => {
        if (!busy) challenge.cancel();
      }}
      title={t('downloadRecovery.verifyTitle')}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy) return;
          setBusy(true);
          setError('');
          try {
            await challenge.submit(code);
          } catch (failure) {
            setError(failure instanceof Error ? failure.message : t('accounts.detail.reauthFailed'));
          } finally {
            setBusy(false);
            setCode('');
          }
        }}
      >
        <p className="mb-3 break-all text-sm">{challenge.email}</p>
        <p className="mb-4 text-sm text-gray-500">{t('downloadRecovery.verifyHelp')}</p>
        <label htmlFor="apple-download-code" className="block text-sm">
          {t('accounts.detail.code')}
        </label>
        <input
          id="apple-download-code"
          autoFocus
          autoComplete="one-time-code"
          inputMode="numeric"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          disabled={busy}
          onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))}
          className="my-3 min-h-12 w-full rounded-xl bg-gray-100 px-4 text-lg tracking-widest dark:bg-gray-800"
        />
        {error && (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}
          </p>
        )}
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={busy || code.length !== 6}
            className="min-h-11 flex-1 rounded-full bg-blue-600 px-4 text-white disabled:opacity-50"
          >
            {busy ? t('loading') : t('downloadRecovery.continue')}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={challenge.cancel}
            className="min-h-11 rounded-full bg-gray-100 px-4 dark:bg-gray-800"
          >
            {t('cancel')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
