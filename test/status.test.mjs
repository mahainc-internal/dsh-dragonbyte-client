/**
 * The Settings route the client panel reads.
 *
 * ⚠ THIS PINS WHAT THE PANEL DEPENDS ON, NOT WHAT THE HOST HAPPENS TO SEND.
 * The panel now shows this machine's name and hides "Pair this machine" once
 * `paired` is true, so `/dragonbyte/status` must carry the name on every
 * response — including the ones that are not a fresh load.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply } from '../src/desktop.mjs';

/** A config dir with no credential file, so the host reports "not paired". */
async function unpairedConfigDir() {
  return await mkdtemp(join(tmpdir(), 'dragonbyte-status-'));
}

/** Collect the one prefix route `apply` registers, and drive it. */
function fakeContext() {
  const registered = [];
  return {
    registered,
    ctx: {
      webServer: { register: (route) => { registered.push(route); return () => {}; } },
      effect: () => () => {},
    },
  };
}

function get(route, path) {
  return new Promise((resolve) => {
    const res = {
      statusCode: 0, headers: {}, body: '',
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers ?? {}); },
      end(chunk = '') { this.body += chunk; resolve(this); },
    };
    route.handler({ url: path, method: 'GET', headers: {} }, res);
  });
}

test('status carries this machine\'s name even before it is paired', async (t) => {
  const dir = await unpairedConfigDir();
  const previous = { ...process.env };
  process.env.DSH_DRAGONBYTE_CONFIG_DIR = dir;
  process.env.DSH_DRAGONBYTE_LABEL = 'office-mini';
  try {
    const { ctx, registered } = fakeContext();
    apply(ctx, { bridgeUrl: 'wss://example.test/dragonbyte/ws' });
    assert.equal(registered.length, 1, 'apply must register exactly one prefix route');
    const res = await get(registered[0], '/dragonbyte/status');
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.paired, false);
    // ⚠ THE NAME IS A CONTRACT THE PANEL RENDERS. Without it Settings shows a
    // dash where the tenant's device list shows a machine name.
    assert.equal(body.label, 'office-mini');
    assert.equal(typeof body.status, 'string');
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the hostname is the name when no label is configured', async (t) => {  const dir = await unpairedConfigDir();
  const previous = { ...process.env };
  process.env.DSH_DRAGONBYTE_CONFIG_DIR = dir;
  delete process.env.DSH_DRAGONBYTE_LABEL;
  try {
    const { ctx, registered } = fakeContext();
    apply(ctx, { bridgeUrl: 'wss://example.test/dragonbyte/ws' });
    const body = JSON.parse((await get(registered[0], '/dragonbyte/status')).body);
    assert.equal(typeof body.label, 'string');
    assert.notEqual(body.label, '', 'the OS hostname is always something');
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

test('the configured gateway is reported, saved, and survives a disconnect', async (t) => {
  // ⚠ THE ADDRESS IS A PANEL FIELD, SO IT ROUND-TRIPS: what `/status` reports
  // is what the PUT accepted, and Disconnect clears the token without silently
  // forgetting which gateway the machine was pointed at.
  const dir = await unpairedConfigDir();
  const previous = { ...process.env };
  process.env.DSH_DRAGONBYTE_CONFIG_DIR = dir;
  try {
    const { ctx, registered } = fakeContext();
    apply(ctx, { bridgeUrl: 'wss://example.test/dragonbyte/ws' });
    const route = registered[0];
    const before = JSON.parse((await get(route, '/dragonbyte/status')).body);
    assert.equal(before.aiGateway, 'https://io.snapai.app:8443/v1');
    assert.equal(before.aiGatewayIsDefault, true);

    const saved = await put(route, '/dragonbyte/gateway', { url: 'https://gw.example.test:9443' });
    assert.equal(saved.statusCode, 200);
    const body = JSON.parse(saved.body);
    assert.equal(body.aiGateway, 'https://gw.example.test:9443/v1', 'a bare host means the deployment root');
    assert.equal(body.aiGatewayIsDefault, false);

    const refused = await put(route, '/dragonbyte/gateway', { url: 'not a url' });
    assert.equal(refused.statusCode, 400, 'a bad address is a refused request, not a host failure');
    const afterRefusal = JSON.parse((await get(route, '/dragonbyte/status')).body);
    assert.equal(afterRefusal.aiGateway, 'https://gw.example.test:9443/v1', 'a refused address leaves the saved one in place');

    await del(route, '/dragonbyte/credential');
    const afterDisconnect = JSON.parse((await get(route, '/dragonbyte/status')).body);
    assert.equal(afterDisconnect.paired, false);
    assert.equal(afterDisconnect.aiGateway, 'https://gw.example.test:9443/v1', 'the address is this machine\'s, not the token\'s');

    const cleared = await put(route, '/dragonbyte/gateway', { url: '' });
    assert.equal(JSON.parse(cleared.body).aiGateway, 'https://io.snapai.app:8443/v1', 'an empty field returns to the default');
  } finally {
    process.env = previous;
    await rm(dir, { recursive: true, force: true });
  }
});

function jsonRequest(route, path, method, body) {
  return new Promise((resolve) => {
    const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
    const req = {
      url: path, method, headers: { 'content-type': 'application/json' },
      on(event, handler) { if (event === 'data') for (const chunk of chunks) handler(chunk); if (event === 'end') handler(); return req; },
      destroy() {},
    };
    const res = {
      statusCode: 0, body: '',
      writeHead(status) { this.statusCode = status; },
      end(chunk = '') { this.body += chunk; resolve(this); },
    };
    route.handler(req, res);
  });
}

const put = (route, path, body) => jsonRequest(route, path, 'PUT', body);
const del = (route, path) => jsonRequest(route, path, 'DELETE');
