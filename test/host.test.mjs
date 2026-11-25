import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { connectServers, serveBridge } from '../src/host.mjs';
import { validateCatalog } from '../src/wire.mjs';
import { parseServerLine, promptServers, serverSpecs } from '../src/host-main.mjs';

const CATALOG = validateCatalog({
  servers: [{ name: 'fs', tools: [{ name: 'read_file', description: 'Read', inputSchema: { type: 'object' } }] }],
});

/** A stand-in WebSocket whose lifecycle the test drives. */
function fakeWebSocket() {
  const listeners = new Map();
  return {
    readyState: 0,
    sent: [],
    addEventListener(type, handler) { listeners.set(type, handler); },
    emit(type, event = {}) { listeners.get(type)?.(event); },
    open() { this.readyState = 1; this.emit('open'); },
    send(data) { this.sent.push(JSON.parse(data)); },
    close() { this.readyState = 3; this.emit('close'); },
  };
}

test('the host publishes its catalog as the first message and answers a call', async () => {
  const socket = fakeWebSocket();
  const calls = [];
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws',
    token: 'tok',
    catalog: CATALOG,
    call: async (server, tool, args) => { calls.push([server, tool, args]); return { content: [{ type: 'text', text: 'ok' }] }; },
    connect: () => socket,
  });
  socket.open();
  // ⚠ NO email ON THE FRAME ANY MORE. The address lives inside the device token,
  // so the host has nothing to restate — and a frame that carried one would be
  // claiming something the token already decided.
  assert.deepEqual(socket.sent[0], { v: 1, type: 'catalog', catalog: CATALOG });
  // The id must satisfy the shared schema's correlation-token pattern, because
  // the host now refuses a frame that does not conform before it answers it.
  socket.emit('message', { data: JSON.stringify({ v: 1, type: 'call', id: 'call-0001', server: 'fs', tool: 'read_file', args: { path: '/x' } }) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [['fs', 'read_file', { path: '/x' }]]);
  assert.deepEqual(socket.sent.at(-1), { v: 1, type: 'reply', id: 'call-0001', result: { content: [{ type: 'text', text: 'ok' }] } });
  session.close();
});

test('a message that is not a well-shaped call is ignored rather than answered', async () => {  const socket = fakeWebSocket();
  const calls = [];
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok', catalog: CATALOG,
    call: async (...args) => { calls.push(args); return { content: [] }; },
    connect: () => socket,
  });
  socket.open();
  const before = socket.sent.length;
  for (const data of ['not json', JSON.stringify({ type: 'call' }), JSON.stringify({ type: 'reply', id: 'x' })]) {
    socket.emit('message', { data });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
  assert.equal(socket.sent.length, before);
  session.close();
});

test('exactly one owned tenant is adopted, and the catalog is republished with it', async () => {
  const socket = fakeWebSocket();
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok', catalog: CATALOG,
    call: async () => ({ content: [] }),
    connect: () => socket,
  });
  socket.open();
  // The first catalog carries no tenant: the host does not know one yet.
  assert.equal(socket.sent[0].tenantId, undefined);

  const tenantId = 'a'.repeat(32);
  socket.emit('message', { data: JSON.stringify({ v: 1, type: 'tenants', email: 'me@example.com', tenants: [tenantId] }) });
  const republished = socket.sent.at(-1);
  assert.equal(republished.type, 'catalog');
  assert.equal(republished.tenantId, tenantId);
  session.close();
});

test('several owned tenants are served together, not refused', async () => {
  const socket = fakeWebSocket();
  const logged = [];
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok', catalog: CATALOG,
    call: async () => ({ content: [] }),
    connect: () => socket,
    log: (line) => logged.push(line),
  });
  socket.open();
  socket.emit('message', { data: JSON.stringify({ v: 1, type: 'tenants', tenants: ['a'.repeat(32), 'b'.repeat(32)] }) });
  // ⚠ THE CATALOG IS REPUBLISHED WITHOUT A TENANT, SO THE BRIDGE FANS IT OUT to
  // every tenant the address owns. Picking one here was the old behaviour and it
  // left the other tenants unserved; refusing was worse still.
  const catalogs = socket.sent.filter((m) => m.type === 'catalog');
  assert.equal(catalogs.length, 2);
  assert.equal(catalogs.at(-1).tenantId, undefined);
  assert.match(logged.at(-1), /serving all of them/);
  session.close();
});

test('an explicitly named tenant is sent with the very first catalog', async () => {
  const socket = fakeWebSocket();
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok',
    tenantId: 'c'.repeat(32), catalog: CATALOG,
    call: async () => ({ content: [] }),
    connect: () => socket,
  });
  socket.open();
  assert.equal(socket.sent[0].tenantId, 'c'.repeat(32));
  session.close();
});

test('a dropped socket is retried, and the catalog is republished on the new one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets = [];
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok', catalog: CATALOG,
    call: async () => ({ content: [] }),
    connect: () => { const socket = fakeWebSocket(); sockets.push(socket); return socket; },
  });
  sockets[0].open();
  assert.equal(sockets[0].sent[0].type, 'catalog');

  sockets[0].close();
  t.mock.timers.tick(1_000);
  assert.equal(sockets.length, 2);
  sockets[1].open();
  assert.equal(sockets[1].sent[0].type, 'catalog');
  session.close();
});

test('a config file uses the standard mcpServers shape, and names are checked', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dragonbyte-cfg-'));
  const file = join(dir, 'mcp.json');
  writeFileSync(file, JSON.stringify({ mcpServers: {
    fs: { command: 'npx', args: ['-y', 'server-filesystem', '/tmp'] },
    docs: { url: 'https://mcp.example.com/mcp', headers: { authorization: 'Bearer x' } },
  } }));
  const specs = serverSpecs(file);
  assert.deepEqual(specs.map((spec) => [spec.name, spec.transport]), [['fs', 'stdio'], ['docs', 'http']]);

  writeFileSync(file, JSON.stringify({ mcpServers: { 'Bad Name': { command: 'x' } } }));
  assert.throws(() => serverSpecs(file), /must match/);

  writeFileSync(file, JSON.stringify({ mcpServers: { fs: { nope: true } } }));
  assert.throws(() => serverSpecs(file), /needs either/);
});

test('a server that never connects is skipped, and an empty catalog never reaches the wire', async () => {
  // A command that does not exist: the transport fails, and the host must still
  // be able to start and report it rather than crash — but nothing may be
  // published, because binding a tenant to a host that can do nothing is worse
  // than being offline.
  const { catalog, close } = await connectServers([
    { name: 'missing', transport: 'stdio', command: '/nonexistent/binary', args: [] },
  ], { log: () => {} });
  await close();
  assert.equal(catalog.servers.length, 0);
  assert.throws(() => serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok',
    catalog, call: async () => ({ content: [] }), connect: () => fakeWebSocket(),
  }), /empty catalog/);
});

test('a typed command line becomes a stdio server, honouring quotes', () => {
  assert.deepEqual(parseServerLine('fs', 'npx -y @modelcontextprotocol/server-filesystem "/Users/me/My Docs"'), {
    name: 'fs', transport: 'stdio', command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/me/My Docs'], env: {},
  });
  assert.deepEqual(parseServerLine('docs', 'https://mcp.example.com/mcp'), {
    name: 'docs', transport: 'http', url: 'https://mcp.example.com/mcp', headers: {},
  });
  assert.throws(() => parseServerLine('fs', 'node "unbalanced'), /unbalanced quote/);
  assert.throws(() => parseServerLine('fs', '   '), /needs a command line/);
});

test('the flow: type one line per server, finish with an empty name, refuse an empty set', async () => {
  const typed = ['fs', 'npx -y server-filesystem /tmp', 'docs', 'https://mcp.example.com/mcp', ''];
  const ask = async () => typed.shift();
  const specs = await promptServers(ask, () => {});
  assert.deepEqual(specs.map((spec) => [spec.name, spec.transport]), [['fs', 'stdio'], ['docs', 'http']]);

  await assert.rejects(promptServers(async () => '', () => {}), /no MCP server was entered/);
});

test('a mistyped command line is asked again instead of failing the start', async () => {
  const typed = ['fs', 'node "oops', 'node ok.mjs', ''];
  const specs = await promptServers(async () => typed.shift(), () => {});
  assert.equal(specs.length, 1);
  assert.equal(specs[0].command, 'node');
});

test('a run that never prompts does not keep the process alive', async () => {
  // ⚠ THE HANG IS THE PROCESS, NOT THE RETURN VALUE. `main` resolved fine even
  // when it created a readline interface eagerly; what never happened was exit,
  // because an open readline on an inherited stdin holds the event loop. So this
  // has to be a real child with its stdin *open and silent* — an in-process
  // assertion would pass either way, and a closed stdin would exit on its own.
  const { spawn } = await import('node:child_process');
  const child = spawn(process.execPath, [new URL('../src/host-main.mjs', import.meta.url).pathname, '--help'], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const exited = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 5000);
    child.on('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
  child.stdin.destroy();
  assert.equal(exited, 0, 'the process must exit on its own with no prompt pending');
});

test('the host asks for the servers Settings saved, and falls back rather than failing', () => {
  const socket = fakeWebSocket();
  const session = serveBridge({
    url: 'ws://bridge.test/dragonbyte/ws', token: 'tok', catalog: CATALOG,
    call: async () => ({ content: [] }), connect: () => socket,
  });
  socket.open();
  // ⚠ THE ASK IS ON THE SAME CONNECT AS THE CATALOG. A laptop has no browser
  // session, so the gateway's settings route is unreachable; the bridge answers
  // this frame out of the document Settings wrote.
  assert.ok(socket.sent.some((frame) => frame.type === 'config'));

  const seen = [];
  const watched = fakeWebSocket();
  const observing = serveBridge({ url: 'wss://b/ws', token: 't', catalog: CATALOG,
    call: async () => ({}), connect: () => watched, onServers: (list) => seen.push(list) });
  watched.open();
  // An empty list is a machine nobody configured. It must be reported, not
  // treated as a refusal, or a host with a saved credential would stop starting.
  watched.emit('message', { data: JSON.stringify({ v: 1, type: 'servers', servers: [] }) });
  assert.deepEqual(seen, [[]], 'an empty list is delivered, not swallowed');
  // An older bridge answers `config` with an error frame; that is not a list.
  watched.emit('message', { data: JSON.stringify({ v: 1, type: 'error', error: 'unknown frame config' }) });
  assert.deepEqual(seen, [[]], 'an error frame must not be read as a server list');
  session.close();
  observing.close();
});

test('fetchServers resolves the saved list, and null whenever it cannot', async () => {
  const { fetchServers } = await import('../src/host.mjs');
  const SAVED = [{ name: 'fs', transport: 'stdio', command: 'npx', args: [] }];

  const withList = fakeWebSocket();
  const finding = fetchServers({ url: 'wss://b/ws', token: 't', connect: () => withList });
  withList.open();
  withList.emit('message', { data: JSON.stringify({ v: 1, type: 'servers', servers: SAVED }) });
  assert.deepEqual(await finding, SAVED);

  // An empty list is not a configuration; `null` makes the caller keep what it has.
  const empty = fakeWebSocket();
  const emptyFinding = fetchServers({ url: 'wss://b/ws', token: 't', connect: () => empty });
  empty.open();
  empty.emit('message', { data: JSON.stringify({ v: 1, type: 'servers', servers: [] }) });
  assert.equal(await emptyFinding, null);

  const refused = fakeWebSocket();
  const refusedFinding = fetchServers({ url: 'wss://b/ws', token: 't', connect: () => refused });
  refused.open();
  refused.emit('message', { data: JSON.stringify({ v: 1, type: 'error', error: 'unknown' }) });
  assert.equal(await refusedFinding, null);
});

test('the entrypoint runs through an installed bin symlink', async () => {
  // ⚠ THE BUG THIS PINS: Node realpaths the module it loads, so
  // `import.meta.url` is the real file while `process.argv[1]` is the
  // `node_modules/.bin` symlink. Comparing them raw made every installed run a
  // silent no-op — `--help` printed nothing and exited 0. A direct-path test
  // cannot see it, so this one has to go through a symlink.
  const { spawn } = await import('node:child_process');
  const { mkdtempSync, symlinkSync, mkdirSync } = await import('node:fs');
  const dir = mkdtempSync(join(tmpdir(), 'dragonbyte-bin-'));
  const binDir = join(dir, 'bin');
  mkdirSync(binDir);
  const target = new URL('../src/host-main.mjs', import.meta.url).pathname;
  const link = join(binDir, 'dsh-dragonbyte-host');
  symlinkSync(target, link);

  const child = spawn(process.execPath, [link, '--help'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (chunk) => { out += chunk; });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('hung'); }, 5000);
    child.on('exit', (value) => { clearTimeout(timer); resolve(value); });
  });
  child.stdin.destroy();
  assert.equal(code, 0);
  assert.match(out, /usage: dsh-dragonbyte-host/, 'an installed bin must actually run the entrypoint');
});

test('a catalog as big as a real machine list is accepted, not silenced by a size cap', () => {
  // ⚠ MEASURED 2026-11-25: one paired Mac mini publishes ios 17 KiB, ipa 1 KiB,
  // openchatcut 218 KiB and a 75-tool agent-desktop -- 244 tools. The old
  // 256 KiB / 256-tool ceilings refused it, and because validateCatalog throws
  // before the socket sends anything, the tenant lost every machine's tools
  // instead of just the large server's. This pins the ceiling above that list.
  const tool = (i) => ({ name: `tool_${i}`, description: 'x'.repeat(1200), inputSchema: { type: 'object' } });
  const servers = [
    { name: 'ios', tools: Array.from({ length: 35 }, (_, i) => tool(i)) },
    { name: 'ipa', tools: Array.from({ length: 2 }, (_, i) => tool(i)) },
    { name: 'openchatcut', tools: Array.from({ length: 132 }, (_, i) => tool(i)) },
    { name: 'agent-desktop', tools: Array.from({ length: 75 }, (_, i) => tool(i)) },
  ];
  const catalog = validateCatalog({ servers });
  const bytes = Buffer.byteLength(JSON.stringify(catalog));
  assert.ok(bytes > 256 * 1024, `the fixture must exceed the old ceiling (${bytes} bytes)`);
  assert.equal(catalog.servers.reduce((n, s) => n + s.tools.length, 0), 244);
});
