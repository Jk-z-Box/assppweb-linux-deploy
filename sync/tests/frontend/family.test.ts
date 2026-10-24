import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchFamilyInfo, parseFamilyInfo } from '../../src/apple/family';
import { appleRequest } from '../../src/apple/request';
import type { Account } from '../../src/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
vi.mock('../../src/i18n', () => ({
  default: {
    t: (key: string, values?: object) => key + JSON.stringify(values ?? {}),
  },
}));

const account = {
  email: 'member@example.invalid',
  password: 'never-send-password',
  passwordToken: 'never-send-token',
  directoryServicesIdentifier: '123',
  deviceIdentifier: 'aabbccddeeff',
  store: '143441',
  cookies: [],
} as unknown as Account;
const fixture = () => ({
  status: 0,
  failureType: 0,
  family: {
    members: [
      {
        ITunesPreferredDsid: 123,
        ITunesPreferredAccountName: account.email,
        membershipStatus: '1',
        sharingPurchases: true,
      },
      {
        ITunesPreferredDsid: 456,
        firstName: 'Owner',
        ITunesPreferredAccountName: 'owner@example.invalid',
        membershipStatus: '1',
        sharingPurchases: true,
      },
    ],
  },
});

beforeEach(() => vi.resetAllMocks());

describe('Apple family membership lookup', () => {
  it('reads membership, not an app entitlement', () => {
    const info = parseFamilyInfo(JSON.stringify(fixture()), '123');
    expect(info.members).toHaveLength(2);
    expect(info.members[0]).toMatchObject({
      current: true,
      active: true,
      sharingPurchases: true,
    });
    expect(info.members[1]).toMatchObject({ current: false, name: 'Owner' });
    expect(info).not.toHaveProperty('license');
    expect(info).not.toHaveProperty('familyId');
  });
  it('keeps inactive or non-sharing members distinct', () => {
    const data = fixture();
    data.family.members[1].membershipStatus = '0';
    data.family.members[1].sharingPurchases = false;
    expect(parseFamilyInfo(JSON.stringify(data), '123').members[1]).toMatchObject({
      active: false,
      sharingPurchases: false,
    });
  });
  it('accepts an explicitly empty member list', () => {
    const data = fixture();
    data.family.members = [];
    expect(parseFamilyInfo(JSON.stringify(data), '123').members).toEqual([]);
  });
  it.each(['null', '{}', '[]', 'not json', '{"status":0,"family":{}}', ' '.repeat(65537)])(
    'rejects incomplete responses',
    (raw) => {
      expect(() => parseFamilyInfo(raw, '123')).toThrow();
    },
  );
  it('rejects a family from a different account', () => {
    expect(() => parseFamilyInfo(JSON.stringify(fixture()), '789')).toThrow();
  });
  it('rejects duplicate and unsafe identifiers', () => {
    const data = fixture();
    data.family.members[1].ITunesPreferredDsid = 123;
    expect(() => parseFamilyInfo(JSON.stringify(data), '123')).toThrow();
    data.family.members[1].ITunesPreferredDsid = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseFamilyInfo(JSON.stringify(data), '123')).toThrow();
  });
  it('does not mistake failed lookup for disabled sharing or expose Apple message text', () => {
    expect(() =>
      parseFamilyInfo(
        JSON.stringify({
          failureType: 2002,
          status: 2002,
          customerMessage: 'private-token',
        }),
        '123',
      ),
    ).toThrow('family.lookupFailed{"code":"2002"}');
  });
  it('uses only the observed read-only endpoint with member cookies', async () => {
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      body: JSON.stringify(fixture()),
    } as any);
    await fetchFamilyInfo(account);
    expect(appleRequest).toHaveBeenCalledExactlyOnceWith({
      method: 'GET',
      host: 'play.itunes.apple.com',
      path: '/WebObjects/MZPlay.woa/wa/familyInfo',
      cookies: account.cookies,
      headers: {
        'User-Agent': 'Configurator/2.18 (Macintosh; OS X 15.3.2; 24D81) AppleWebKit/0620.2.4.11.6',
        Accept: 'application/json',
        'X-Apple-Store-Front': '143441-1',
        'X-Dsid': '123',
      },
    });
    expect(JSON.stringify(vi.mocked(appleRequest).mock.calls)).not.toContain(account.passwordToken);
    expect(JSON.stringify(vi.mocked(appleRequest).mock.calls)).not.toContain(account.password);
  });
  it.each([302, 403, 500])('stops after HTTP %s without another request', async (status) => {
    vi.mocked(appleRequest).mockResolvedValue({
      status,
      body: 'secret',
      headers: { location: 'https://invalid.example' },
    } as any);
    await expect(fetchFamilyInfo(account)).rejects.toThrow('family.httpError');
    expect(appleRequest).toHaveBeenCalledOnce();
  });
});
