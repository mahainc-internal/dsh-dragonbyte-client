import assert from 'node:assert/strict';
import test from 'node:test';

import { bridgeUrlOf, labelOf, pairPageUrl, parseServerConfig, serverConfigText } from '../src/desktop.mjs';

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

test('a pairing link names no callback, so nothing depends on loopback', () => {
  // ⚠ A LINK THAT CARRIED ONE WOULD REINTRODUCE THE PATH THAT FAILED SILENTLY:
  // a cross-origin load into 127.0.0.1 that a browser may refuse without
  // telling anyone, leaving the page saying "paired" and this machine waiting.
  const url = new URL(pairPageUrl({ bridgeUrl: 'wss://edge01.snapai.app/dragonbyte/ws' }));
  assert.equal(url.searchParams.has('callback'), false);
  assert.equal(url.searchParams.has('code'), false);
});

test('a pasted .mcp.json becomes specs, in the same format `--mcp` reads', () => {
  // ⚠ THE FILE A PERSON PASTES IS THE FILE THEIR EDITOR SHOWS. This is the
  // document form, including a header on one entry and a bare `url` on another.
  const specs = parseServerConfig(JSON.stringify({
    mcpServers: {
      ios: { url: 'http://127.0.0.1:8765/mcp' },
      openchatcut: {
        type: 'streamable-http',
        url: 'http://127.0.0.1:5199/api/external-mcp/mcp',
        headers: { Authorization: 'Bearer abc' },
      },
      fs: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/My Docs'] },
    },
  }));
  assert.deepEqual(specs, [
    { name: 'ios', label: undefined, transport: 'http', url: 'http://127.0.0.1:8765/mcp', headers: {} },
    { name: 'openchatcut', label: undefined, transport: 'http', url: 'http://127.0.0.1:5199/api/external-mcp/mcp', headers: { Authorization: 'Bearer abc' }, type: 'streamable-http' },
    { name: 'fs', label: undefined, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '~/My Docs'], env: {} },
  ]);
});

test('the bare mcpServers object is accepted, and an empty editor means no servers', () => {
  // ⚠ COPYING THE INNER OBJECT OUT OF A LARGER FILE IS ORDINARY. Refusing it
  // would be a formatting rule the person cannot see.
  assert.deepEqual(parseServerConfig('{"s":{"url":"https://e.test/m"}}'), [
    { name: 's', label: undefined, transport: 'http', url: 'https://e.test/m', headers: {} },
  ]);
  assert.deepEqual(parseServerConfig(''), []);
  assert.deepEqual(parseServerConfig('   '), []);
});

test('a bad document says what is wrong instead of failing silently', () => {
  assert.throws(() => parseServerConfig('{not json'), /not valid JSON/);
  assert.throws(() => parseServerConfig('{"mcpServers":{"Bad_Name":{"url":"https://e.test"}}}'), /must match/);
  assert.throws(() => parseServerConfig('{"mcpServers":{"x":{}}}'), /needs either "command"/);
});

test('the panel shows what it holds as the same document shape', () => {
  const text = serverConfigText([
    { name: 'ios', transport: 'http', url: 'http://127.0.0.1:8765/mcp', headers: {} },
    { name: 'fs', transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: {} },
  ]);
  assert.deepEqual(JSON.parse(text), {
    mcpServers: {
      ios: { url: 'http://127.0.0.1:8765/mcp' },
      fs: { command: 'npx', args: ['-y', 'x'] },
    },
  });
  // Round-trip: what the panel shows parses back to the same specs.
  assert.deepEqual(parseServerConfig(text).map((s) => s.name), ['ios', 'fs']);
  assert.deepEqual(JSON.parse(serverConfigText([])), { mcpServers: {} });
});

test('the machine names itself by hostname, unless a label is configured', () => {
  // ⚠ THE NAME REACHES THE TENANT'S SETTINGS, SO IT MUST BE THIS MACHINE'S.
  // A configured label wins because two machines can share a hostname pattern;
  // with none, the OS hostname is what a person would recognise in the list.
  assert.equal(labelOf({ DSH_DRAGONBYTE_LABEL: '  office-mini  ' }), 'office-mini');
  const fallback = labelOf({});
  assert.equal(typeof fallback, 'string');
  assert.notEqual(fallback, '');
  assert.ok(fallback.length <= 80);
});
