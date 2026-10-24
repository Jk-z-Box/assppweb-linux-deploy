import { afterEach, expect, it, vi } from 'vitest';
import { Authenticator, AuthenticationError } from '../../src/apple/authenticate';
import { renewAppleAccount, useAppleVerification } from '../../src/store/appleVerification';
import type { Account } from '../../src/types';

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), constructed: vi.fn() }));
vi.mock('../../src/apple/authenticate', () => ({
  Authenticator: class {
    constructor(...args: unknown[]) {
      mocks.constructed(...args);
    }
    authenticate = mocks.authenticate;
  },
  AuthenticationError: class extends Error {
    constructor(
      message: string,
      public codeRequired = false,
    ) {
      super(message);
    }
  },
}));
const account = {
  email: 'test@example.invalid',
  password: 'test-only',
  deviceIdentifier: 'aabbccddeeff',
  cookies: [],
} as unknown as Account;
afterEach(() => {
  useAppleVerification.getState().challenge?.cancel();
  vi.clearAllMocks();
});
it('keeps the same SAP authenticator across the verification-code submission', async () => {
  mocks.authenticate.mockRejectedValueOnce(new AuthenticationError('verify', true)).mockResolvedValueOnce(account);
  const pending = renewAppleAccount(account);
  await vi.waitFor(() => expect(useAppleVerification.getState().challenge).not.toBeNull());
  await useAppleVerification.getState().challenge!.submit('123456');
  expect(await pending).toEqual(account);
  expect(mocks.constructed).toHaveBeenCalledOnce();
  expect(mocks.authenticate).toHaveBeenLastCalledWith(account.email, account.password, '123456');
  expect(useAppleVerification.getState().challenge).toBeNull();
});
it('cancels without continuing authentication or saving a code', async () => {
  mocks.authenticate.mockRejectedValueOnce(new AuthenticationError('verify', true));
  const pending = renewAppleAccount(account);
  const rejection = expect(pending).rejects.toThrow();
  await vi.waitFor(() => expect(useAppleVerification.getState().challenge).not.toBeNull());
  useAppleVerification.getState().challenge!.cancel();
  await rejection;
  expect(mocks.authenticate).toHaveBeenCalledOnce();
});
