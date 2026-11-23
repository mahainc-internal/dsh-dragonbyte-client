import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import { connectServers } from '../src/host.mjs';

/**
 * A Streamable HTTP MCP server that can forget a session on demand.
 *
 * The real server this reproduces is OpenChatCut: a stateful transport that
 * answers a request carrying an unknown session id with
 * `404 {"error":{"code":-32001,"message":"MCP session not found or expired"}}`.
 * Reproducing it here rather than mocking the client keeps the thing under test
 * the real SDK transport, which is where the failure actually lived.
 */
function mcpServer({ tools }) {
  const sessions = new Set();
  let nextSession = 0;
  const calls = [];

  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;

    if (req.method === 'DELETE') {
      sessions.delete(req.headers['mcp-session-id']);
      res.writeHead(200).end();
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    // A request naming a session this server has forgotten is refused with the
    // exact shape the real one uses. Everything else proceeds.
    if (sessionId && !sessions.has(sessionId)) {
      const text = JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'MCP session not found or expired' }, id: null });
      res.writeHead(404, { 'content-type': 'application/json' }).end(text);
      return;
    }

    if (body?.method === 'initialize') {
      nextSession += 1;
      const issued = `session-${nextSession}`;
      sessions.add(issued);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': issued });
      res.end(`event: message\ndata: ${JSON.stringify({
        jsonrpc: '2.0', id: body.id,
        result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } },
      })}\n\n`);
      return;
    }

    if (body?.method === 'notifications/initialized') {
      res.writeHead(202).end();
      return;
    }

    if (body?.method === 'tools/list') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { tools } })}\n\n`);
      return;
    }

    if (body?.method === 'tools/call') {
      calls.push(body.params.name);
      const result = { content: [{ type: 'text', text: `ran ${body.params.name}` }] };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result })}\n\n`);
      return;
    }

    res.writeHead(202).end();
  });

  return {
    server,
    calls,
    /** Drop every session, as a restart or the idle sweep does. */
    forgetAll() { sessions.clear(); },
    sessions,
  };
}

async function listen(fake) {
  await new Promise((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const { port } = fake.server.address();
  return `http://127.0.0.1:${port}/mcp`;
}

const TOOLS = [
  { name: 'read_timeline', description: 'Read', inputSchema: { type: 'object' } },
  { name: 'edit_item', description: 'Edit', inputSchema: { type: 'object' } },
];

test('a read is replayed once after the server forgets the session', async () => {
  const fake = mcpServer({ tools: TOOLS });
  const url = await listen(fake);
  const { call, close } = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: () => {} });
  try {
    // The session goes away underneath, exactly as it does on a server restart.
    fake.forgetAll();
    const result = await call('ocs', 'read_timeline', {});
    assert.equal(result.isError, undefined);
    assert.match(result.content[0].text, /ran read_timeline/);
    // The call was dispatched once, after the rebuild — not against the dead
    // session and not twice.
    assert.deepEqual(fake.calls, ['read_timeline']);
  } finally {
    await close();
    fake.server.close();
  }
});

test('a write is not replayed, and says it was not run', async () => {
  const fake = mcpServer({ tools: TOOLS });
  const url = await listen(fake);
  const { call, close } = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: () => {} });
  try {
    fake.forgetAll();
    const result = await call('ocs', 'edit_item', {});
    // ⚠ A WRITE THAT MIGHT HAVE LANDED IS NEVER SENT TWICE. The recovery still
    // rebuilds the session — the next call needs it — but this one refuses.
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /was not run/);
    assert.deepEqual(fake.calls, []);
    // The rebuild is what makes the refusal a one-time cost.
    const after = await call('ocs', 'read_timeline', {});
    assert.equal(after.isError, undefined);
  } finally {
    await close();
    fake.server.close();
  }
});

test('closing the host ends the MCP session instead of abandoning it', async () => {
  const fake = mcpServer({ tools: TOOLS });
  const url = await listen(fake);
  const { close } = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: () => {} });
  // ⚠ A SESSION LEFT OPEN STRANDS WHAT IT OWNS. OpenChatCut ties an edit draft
  // to the session that began it, so an abandoned session is a draft nobody can
  // discard and an editor that refuses every new one.
  assert.equal(fake.sessions.size, 1);
  await close();
  assert.equal(fake.sessions.size, 0);
  fake.server.close();
});

test('a failure that is not a lost session is reported without reconnecting', async () => {
  const fake = mcpServer({ tools: [] });
  const url = await listen(fake);
  const { call, close } = await connectServers([{ name: 'ocs', transport: 'http', url, headers: {} }], { log: () => {} });
  try {
    const before = fake.sessions.size;
    const result = await call('ocs', 'read_timeline', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /unknown tool/);
    // An unknown tool is a name error, not a transport one: no session churn.
    assert.equal(fake.sessions.size, before);
  } finally {
    await close();
    fake.server.close();
  }
});
