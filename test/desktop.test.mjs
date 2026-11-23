import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeUrlOf, pairPageUrl, parseServerLines, serverLine } from '../src/desktop.mjs';

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

test('the pairing page link carries the loopback callback and nothing else', () => {
  // ⚠ NO CODE PARAMETER ANY MORE. The page no longer edits a server list, so a
  // link holding a code would be a second way into one device's settings.
  const url = new URL(pairPageUrl({ bridgeUrl: 'wss://edge01.snapai.app/dragonbyte/ws', callback: 'http://127.0.0.1:49152/dragonbyte/pair/callback' }));
  assert.equal(url.searchParams.has('code'), false);
  assert.equal(url.searchParams.get('callback'), 'http://127.0.0.1:49152/dragonbyte/pair/callback');
});

test('typed lines become specs, and a bad line names the line it is on', () => {
  // ⚠ ONE PARSER FOR THE PANEL AND THE HEADLESS PROMPT. A line means the same
  // thing in Settings, in `--mcp`, and in the interactive prompt, so a panel
  // with its own parser would be a second dialect of the same file format.
  const specs = parseServerLines([
    '# a comment',
    'fs: npx -y @modelcontextprotocol/server-filesystem "~/My Docs"',
    'search: https://mcp.example.test/sse',
    '',
  ].join('\n'));
  assert.deepEqual(specs, [
    { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/My Docs'], env: {} },
    { name: 'search', transport: 'http', url: 'https://mcp.example.test/sse', headers: {} },
  ]);

  // ⚠ AN EMPTY LIST IS VALID, NOT A FAILURE. Deleting every server is how a
  // machine stops sharing; the panel saves it and the host publishes nothing.
  assert.deepEqual(parseServerLines(''), []);
  assert.throws(() => parseServerLines('no colon here'), /line 1/);
  assert.throws(() => parseServerLines('fs: npx -y x\nfs: npx -y y'), /listed twice/);
  assert.throws(() => parseServerLines('Bad: npx'), /line 1/);
});

test('a server line round-trips through the panel', () => {
  const line = 'fs: npx -y @modelcontextprotocol/server-filesystem ~/docs';
  assert.equal(serverLine(parseServerLines(line)[0]), line);
  assert.equal(serverLine({ name: 'x', transport: 'http', url: 'https://e.test/m' }), 'x: https://e.test/m');
});
