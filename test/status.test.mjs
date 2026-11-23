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

test('the hostname is the name when no label is configured', async (t) => {
  const dir = await unpairedConfigDir();
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
