import { describe, expect, it, vi } from 'vitest';
import { recoverDownload } from '../../src/apple/downloadRecovery';
import { DownloadError } from '../../src/apple/downloadProduct';
import { PurchaseError } from '../../src/apple/purchase';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
const account = { email: 'test@example.invalid', passwordToken: 'old' } as Account;
const app = { id: 123, price: 0 } as Software;
function deps() {
  return {
    download: vi.fn().mockResolvedValue('package'),
    renew: vi.fn().mockResolvedValue({ ...account, passwordToken: 'new' }),
    purchase: vi.fn().mockImplementation(async (current) => ({ ...current, cookies: [] })),
  };
}

describe('bounded Apple download recovery', () => {
  it('downloads valid sessions without logging in or acquiring again', async () => {
    const d = deps();
    expect((await recoverDownload(account, app, d)).result).toBe('package');
    expect(d.renew).not.toHaveBeenCalled();
    expect(d.purchase).not.toHaveBeenCalled();
  });
  it.each(['2034', '2042'])('renews once for %s and uses the saved session', async (code) => {
    const d = deps();
    d.download.mockRejectedValueOnce(new DownloadError('expired', code));
    const out = await recoverDownload(account, app, d);
    expect(d.renew).toHaveBeenCalledOnce();
    expect(d.download.mock.calls[1][0].passwordToken).toBe('new');
    expect(out.account.passwordToken).toBe('new');
  });
  it('stops when a fresh session still expires', async () => {
    const d = deps();
    d.download.mockRejectedValue(new DownloadError('expired', '2034'));
    await expect(recoverDownload(account, app, d)).rejects.toThrow('expired');
    expect(d.download).toHaveBeenCalledTimes(2);
    expect(d.renew).toHaveBeenCalledOnce();
  });
  it('acquires a free license, recovering expiry during acquisition', async () => {
    const d = deps();
    d.download.mockRejectedValueOnce(new DownloadError('license', '9610'));
    d.purchase.mockRejectedValueOnce(new PurchaseError('expired', '2042'));
    const out = await recoverDownload(account, app, d);
    expect(out.result).toBe('package');
    expect(d.purchase).toHaveBeenCalledTimes(2);
    expect(d.renew).toHaveBeenCalledOnce();
    expect(d.download.mock.calls[1][0].passwordToken).toBe('new');
  });
  it.each([undefined, 1.99])('does not automatically purchase unknown/paid price %s', async (price) => {
    const d = deps();
    d.download.mockRejectedValue(new DownloadError('license', '9610'));
    await expect(recoverDownload(account, { ...app, price }, d)).rejects.toThrow('license');
    expect(d.purchase).not.toHaveBeenCalled();
  });
  it('never turns a bare HTTP 403 into repeated sign-ins', async () => {
    const d = deps();
    d.download.mockRejectedValue(new DownloadError('HTTP 403'));
    await expect(recoverDownload(account, app, d)).rejects.toThrow('HTTP 403');
    expect(d.renew).not.toHaveBeenCalled();
    expect(d.purchase).not.toHaveBeenCalled();
  });
  it('stops when verification is cancelled or saving the refreshed account fails', async () => {
    const d = deps();
    d.download.mockRejectedValue(new DownloadError('expired', '2034'));
    d.renew.mockRejectedValue(new Error('cancelled'));
    await expect(recoverDownload(account, app, d)).rejects.toThrow('cancelled');
    expect(d.download).toHaveBeenCalledOnce();
  });
});
