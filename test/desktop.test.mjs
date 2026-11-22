import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeUrlOf, pairPageUrl } from '../src/desktop.mjs';

test('the pairing page is built on the bridge origin, not the desktop origin', () => {
  // ⚠ A DESKTOP SHELL SERVES ITS UI FROM `app://`, WHICH FIREBASE WILL NEVER
  // ACCEPT AS AN AUTHORIZED DOMAIN. The page therefore has to live on the
  // bridge's public hostname, and this is the one place that decides so.
  const url = new URL(pairPageUrl({
    bridgeUrl: 'wss://edge01.snapai.app/dragonbyte/ws',
    tenantId: 'a'.repeat(32),
    callback: 'http://127.0.0.1:49152/dragonbyte/pair/callback',
  }));
  assert.equal(url.origin, 'https://edge01.snapai.app');
  assert.equal(url.pathname, '/dragonbyte/pair/start');
  assert.equal(url.searchParams.get('tenant'), 'a'.repeat(32));
  assert.equal(url.searchParams.get('callback'), 'http://127.0.0.1:49152/dragonbyte/pair/callback');
});

test('a configured bridge replaces the default, and `ws` becomes `http` for the page', () => {
  const url = new URL(pairPageUrl({
    bridgeUrl: 'ws://127.0.0.1:3500/dragonbyte/ws', tenantId: 'b'.repeat(32), callback: 'http://127.0.0.1:1/cb',
  }));
  assert.equal(url.protocol, 'http:');
  assert.equal(url.port, '3500');
  assert.equal(bridgeUrlOf({ DSH_DRAGONBYTE_BRIDGE: 'wss://example.test/dragonbyte/ws' }), 'wss://example.test/dragonbyte/ws');
  assert.equal(bridgeUrlOf({}), 'wss://edge01.snapai.app/dragonbyte/ws');
});
