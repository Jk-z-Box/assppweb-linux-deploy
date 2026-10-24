import { expect, it } from 'vitest';
import { server as wisp } from '@mercuryworkshop/wisp-js/server';
import '../../src/services/wsProxy.js';

it('limits the added family service to the exact Apple host over TLS', () => {
  const allowed = (host: string) => wisp.options.hostname_whitelist.some((pattern: RegExp) => pattern.test(host));
  expect(allowed('play.itunes.apple.com')).toBe(true);
  for (const host of [
    'play.itunes.apple.com.attacker.invalid',
    'attacker-play.itunes.apple.com',
    'play.itunes.apple.com:80',
    '127.0.0.1',
    'example.com',
  ]) {
    expect(allowed(host)).toBe(false);
  }
  expect(wisp.options.port_whitelist).toEqual([443]);
  expect(wisp.options.allow_direct_ip).toBe(false);
  expect(wisp.options.allow_loopback_ips).toBe(false);
});
