import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDownloadInfo } from '../../src/apple/download';
import { appleRequest } from '../../src/apple/request';
import { fetchBag } from '../../src/apple/bag';
import { generateKBSync } from '../../src/apple/kbsync/generate';
import { buildPlist } from '../../src/apple/plist';
import type { Account, Software } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/apple/bag', () => ({ fetchBag: vi.fn() }));
vi.mock('../../src/apple/kbsync/generate', async (original) => ({
  ...(await original<typeof import('../../src/apple/kbsync/generate')>()),
  generateKBSync: vi.fn(),
}));
const account = {
  directoryServicesIdentifier: '123',
  deviceIdentifier: 'aabbccddeeff',
  cookies: [],
  store: '143441',
} as unknown as Account;
const app = { id: 123, bundleID: 'test.example' } as Software;
const item = {
  URL: 'https://example.invalid/app.ipa',
  metadata: {
    itemId: 123,
    softwareVersionBundleId: 'test.example',
    softwareVersionExternalIdentifier: '100',
    bundleShortVersionString: '1.0',
    bundleVersion: '1',
  },
};
const response = (dict: unknown) => ({
  status: 200,
  statusText: '',
  headers: {},
  rawHeaders: [],
  body: buildPlist(dict),
});
beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  vi.mocked(fetchBag).mockResolvedValue({ authURL: '' });
});

describe('download protocol compatibility', () => {
  it.each([undefined, []])('accepts omitted or empty SINF without losing metadata', async (sinfs) => {
    vi.mocked(appleRequest).mockResolvedValue(response({ songList: [{ ...item, ...(sinfs ? { sinfs } : {}) }] }));
    const out = await getDownloadInfo(account, app, '100');
    expect(out.output.sinfs).toEqual([]);
    expect(out.output.iTunesMetadata).toBeTruthy();
    expect(out.output.downloadURL).toBe(item.URL);
  });
  it.each([[{}], [{ id: 0 }], 'invalid'])('rejects malformed supplied SINF %j', async (sinfs) => {
    vi.mocked(appleRequest).mockResolvedValue(response({ songList: [{ ...item, sinfs }] }));
    await expect(getDownloadInfo(account, app, '100')).rejects.toThrow();
  });
  it.each(['2034', '2042', '9610'])('preserves ent error %s without regenerating or falling back', async (code) => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: '',
      entDownloadURL: 'https://downloaddispatch.itunes.apple.com/WebObjects/DownloadDispatch.woa/wa/ent/download',
    });
    localStorage.setItem('asspp-kbsync-v1:123:aabbccddeeff', 'cached');
    vi.mocked(appleRequest).mockResolvedValue(response({ failureType: code }));
    await expect(getDownloadInfo(account, app, '100')).rejects.toMatchObject({ code });
    expect(appleRequest).toHaveBeenCalledOnce();
    expect(generateKBSync).not.toHaveBeenCalled();
  });
  it('maps a message-only expired session to a recoverable code', async () => {
    vi.mocked(appleRequest).mockResolvedValue(response({ customerMessage: 'Your password has changed.' }));
    await expect(getDownloadInfo(account, app, '100')).rejects.toMatchObject({ code: '2034' });
  });
  it('rejects a legacy response for a different app', async () => {
    vi.mocked(appleRequest).mockResolvedValue(
      response({ songList: [{ ...item, metadata: { ...item.metadata, itemId: 456 } }] }),
    );
    await expect(getDownloadInfo(account, app, '100')).rejects.toThrow();
  });
});
