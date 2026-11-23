import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { connectServers, serveBridge } from '../src/host.mjs';

/**
 * A Streamable HTTP MCP server whose tool list changes while it runs.
 *
 * It reproduces OpenChatCut: it advertises `tools.listChanged`, keeps the
 * standalone GET stream open, and announces a change on it with
 * `notifications/tools/list_changed`. The real SDK transport is under test,
 * because whether that stream is opened and read is the SDK's behaviour.
 */
function changingServer(initial) {
  let tools = initial;
  const streams = new Set();
  const sessions = new Set();
  let issued = 0;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    const reply = (result) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
    };
    // A request on a session this process never issued gets the real server's
    // answer to a session it forgot.
    const sessionId = req.headers['mcp-session-id'];
    if (sessionId && !sessions.has(sessionId)) {
      res.writeHead(404, { 'content-type': 'application/json' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found or expired' }, id: null }));
      return;
    }
    if (req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      streams.add(res);
      req.on('close', () => streams.delete(res));
      return;
    }
    if (req.method === 'DELETE') { res.writeHead(200).end(); return; }
    if (body?.method === 'initialize') {
      issued += 1;
      sessions.add(`session-${issued}`);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': `session-${issued}` });
      res.end(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'fake', version: '0' } },
      })}\n\n`);
      return;
    }
    if (body?.method === 'tools/list') { reply({ tools }); return; }
    if (body?.method === 'tools/call') { reply({ content: [{ type: 'text', text: `ran ${body.params.name}` }] }); return; }
    res.writeHead(202).end();
  });
  return {
    server,
    get streams() { return streams.size; },
    /** Swap the tool list and announce it, as opening a project does. */
    change(next) {
      tools = next;
      const note = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' });
      for (const res of streams) res.write(`event: message\ndata: ${note}\n\n`);
    },
    /** Relaunch: every session and stream is gone, and no notice is sent. */
    restart(next) {
      tools = next;
      sessions.clear();
      for (const res of streams) res.end();
      streams.clear();
    },
    close() { for (const res of streams) res.end(); server.close(); },
  };
}

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

const tool = (name) => ({ name, description: name, inputSchema: { type: 'object' } });

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test('a server that changes its tools mid-run reaches the bridge as a new catalog', async () => {
  const fake = changingServer([tool('list_projects')]);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fake.server.address().port}/mcp`;
  const host = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: () => {} });
  const socket = fakeWebSocket();
  const session = serveBridge({ url: 'ws://bridge.test/ws', token: 'tok', catalog: host.catalog, call: host.call, connect: () => socket });
  host.onCatalog((next) => session.republish(next));
  try {
    socket.open();
    assert.deepEqual(socket.sent[0].catalog.servers[0].tools.map((t) => t.name), ['list_projects']);
    await until(() => fake.streams > 0);

    // ⚠ THE PROJECT OPENS AFTER THE HOST STARTED. Before this was handled the
    // tenant kept the first list until the host was restarted by hand.
    fake.change([tool('list_projects'), tool('edit_item')]);
    await until(() => socket.sent.filter((m) => m.type === 'catalog').length === 2);
    const latest = socket.sent.filter((m) => m.type === 'catalog').at(-1);
    assert.deepEqual(latest.catalog.servers[0].tools.map((t) => t.name), ['list_projects', 'edit_item']);
    assert.deepEqual(host.catalog, latest.catalog);

    // A tool that appeared is callable, and one that disappeared is refused.
    assert.match((await host.call('ocs', 'edit_item', {})).content[0].text, /ran edit_item/);
    fake.change([tool('list_projects')]);
    await until(() => socket.sent.filter((m) => m.type === 'catalog').length === 3);
    const gone = await host.call('ocs', 'edit_item', {});
    assert.equal(gone.isError, true);
    assert.match(gone.content[0].text, /unknown tool/);

    // A reconnect publishes the latest list, not the one the host started with.
    socket.close();
    const again = fakeWebSocket();
    session.close();
    const second = serveBridge({ url: 'ws://bridge.test/ws', token: 'tok', catalog: host.catalog, call: host.call, connect: () => again });
    again.open();
    assert.deepEqual(again.sent[0].catalog.servers[0].tools.map((t) => t.name), ['list_projects']);
    second.close();
  } finally {
    session.close();
    await host.close();
    fake.close();
  }
});

test('a server that relaunches with a new list reaches the bridge without a call or a notice', async () => {
  const fake = changingServer([tool('list_projects')]);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fake.server.address().port}/mcp`;
  const host = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: () => {}, relistMs: 100 });
  const announced = [];
  host.onCatalog((next) => announced.push(next));
  try {
    // ⚠ NO NOTIFICATION AND NO TOOL CALL. A relaunched app forgets the session
    // the notice would have travelled on; only the host's own re-listing finds
    // the new session and the new list.
    fake.restart([tool('list_projects'), tool('edit_item')]);
    await until(() => announced.length > 0);
    assert.deepEqual(announced.at(-1).servers[0].tools.map((t) => t.name), ['list_projects', 'edit_item']);
    assert.match((await host.call('ocs', 'edit_item', {})).content[0].text, /ran edit_item/);
  } finally {
    await host.close();
    fake.close();
  }
});

test('a list that goes empty keeps the last published catalog instead of sending none', async () => {
  const fake = changingServer([tool('list_projects')]);
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${fake.server.address().port}/mcp`;
  const lines = [];
  const host = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: (line) => lines.push(line) });
  const announced = [];
  host.onCatalog((next) => announced.push(next));
  try {
    await until(() => fake.streams > 0);
    fake.change([]);
    await until(() => lines.some((line) => /keeping the last published catalog/.test(line)));
    assert.equal(announced.length, 0);
    assert.deepEqual(host.catalog.servers[0].tools.map((t) => t.name), ['list_projects']);
  } finally {
    await host.close();
    fake.close();
  }
});
