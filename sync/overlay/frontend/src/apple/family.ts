import i18n from '../i18n';
import { appleRequest } from './request';
import type { Account } from '../types';

export interface FamilyMember {
  dsid: string;
  name: string;
  email: string;
  current: boolean;
  active: boolean;
  sharingPurchases: boolean;
}

export interface FamilyInfo {
  members: FamilyMember[];
  checkedAt: number;
}

function invalidResponse(): never {
  throw new Error(i18n.t('family.invalidResponse'));
}

function dsid(value: unknown): string {
  const text = String(value ?? '');
  if (!/^[1-9]\d{0,15}$/.test(text) || !Number.isSafeInteger(Number(text))) invalidResponse();
  return text;
}

function text(value: unknown, max = 320): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** Family membership is not proof of a license for an individual application. */
export function parseFamilyInfo(raw: string, accountDsid: string): FamilyInfo {
  if (raw.length > 65536) invalidResponse();
  let result: any;
  try {
    result = JSON.parse(raw);
  } catch {
    invalidResponse();
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) invalidResponse();
  const failure = result.failureType ?? result.status;
  if (String(failure) !== '0' || (result.status !== undefined && String(result.status) !== '0')) {
    // Never display arbitrary server messages, account identifiers, or URLs.
    const code = /^\d{1,6}$/.test(String(failure)) ? String(failure) : '?';
    throw new Error(i18n.t('family.lookupFailed', { code }));
  }
  if (!result.family || !Array.isArray(result.family.members) || result.family.members.length > 6) invalidResponse();
  const members: FamilyMember[] = result.family.members.map((member: any) => {
    if (!member || typeof member !== 'object' || Array.isArray(member)) invalidResponse();
    const id = dsid(member.ITunesPreferredDsid);
    return {
      dsid: id,
      name: [text(member.firstName, 100), text(member.lastName, 100)].filter(Boolean).join(' '),
      email: text(member.ITunesPreferredAccountName),
      current: id === accountDsid,
      active: String(member.membershipStatus) === '1',
      sharingPurchases: member.sharingPurchases === true,
    };
  });
  if (new Set(members.map((member) => member.dsid)).size !== members.length) invalidResponse();
  if (members.length && !members.some((member) => member.current)) invalidResponse();
  return { members, checkedAt: Date.now() };
}

/** Read-only lookup. No purchase, account switch, or credential refresh. */
export async function fetchFamilyInfo(account: Account): Promise<FamilyInfo> {
  dsid(account.directoryServicesIdentifier);
  const response = await appleRequest({
    method: 'GET',
    host: 'play.itunes.apple.com',
    path: '/WebObjects/MZPlay.woa/wa/familyInfo',
    headers: {
      'User-Agent': 'Configurator/2.18 (Macintosh; OS X 15.3.2; 24D81) AppleWebKit/0620.2.4.11.6',
      Accept: 'application/json',
      'X-Apple-Store-Front': `${account.store}-1`,
      'X-Dsid': account.directoryServicesIdentifier,
      // The verified family lookup needs Store cookies, not a purchase token.
    },
    cookies: account.cookies,
  });
  if (response.status !== 200) {
    throw new Error(i18n.t('family.httpError', { status: response.status }));
  }
  return parseFamilyInfo(response.body, account.directoryServicesIdentifier);
}
