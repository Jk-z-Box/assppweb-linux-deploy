import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import FamilySharing from '../../src/components/Account/FamilySharing';
import { fetchFamilyInfo } from '../../src/apple/family';
import type { FamilyInfo } from '../../src/apple/family';
import type { Account } from '../../src/types';

vi.mock('../../src/apple/family', () => ({ fetchFamilyInfo: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const account = {
  email: 'member@example.invalid',
  directoryServicesIdentifier: '123',
  passwordToken: 'test',
} as Account;
const result: FamilyInfo = {
  checkedAt: Date.now(),
  members: [
    {
      dsid: '123',
      name: 'Family member',
      email: account.email,
      current: true,
      active: true,
      sharingPurchases: true,
    },
  ],
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it('queries on demand and distinguishes sharing settings from download support', async () => {
  vi.mocked(fetchFamilyInfo).mockResolvedValue(result);
  render(<FamilySharing account={account} />);
  expect(fetchFamilyInfo).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'family.check' }));
  expect(await screen.findByText(account.email)).toBeTruthy();
  expect(screen.getByText('family.current')).toBeTruthy();
  expect(screen.getByText('family.sharingOn')).toBeTruthy();
  expect(screen.getByText('family.downloadLimit')).toBeTruthy();
});

it('discards a response if the account changes while the lookup is pending', async () => {
  let finish!: (value: FamilyInfo) => void;
  vi.mocked(fetchFamilyInfo).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = render(<FamilySharing account={account} />);
  fireEvent.click(screen.getByRole('button', { name: 'family.check' }));
  view.rerender(
    <FamilySharing
      account={{
        ...account,
        email: 'other@example.invalid',
        directoryServicesIdentifier: '456',
      }}
    />,
  );
  await act(async () => {
    finish(result);
  });
  expect(screen.queryByText(account.email)).toBeNull();
  expect(screen.getByRole('button', { name: 'family.check' })).not.toBeDisabled();
});

it('shows a retryable lookup error instead of claiming sharing is disabled', async () => {
  vi.mocked(fetchFamilyInfo).mockRejectedValue(new Error('Lookup unavailable'));
  render(<FamilySharing account={account} />);
  fireEvent.click(screen.getByRole('button', { name: 'family.check' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Lookup unavailable');
  expect(screen.queryByText('family.sharingOff')).toBeNull();
});
