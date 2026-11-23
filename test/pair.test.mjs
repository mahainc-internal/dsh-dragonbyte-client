/**
 * The browser pairing flow, driven without a browser and without a network.
 *
 * ⚠ THIS PINS THE TWO BRIDGE ROUTES THE FLOW DEPENDS ON. A machine that pairs
 * must register its handle BEFORE the page is opened and spend the code it gets
 * back — in that order, on the same origin. Every test here asserts one of
 * those, because the failure they prevent is a machine that reports "paired",
 * holds no credential, and looks exactly like a user who never finished signing
 * in.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { httpBaseOf, labelOf, pairPageUrl, pairWithBrowser } from '../src/pair.mjs';

/** A fetch stand-in that answers the two routes pairing uses, in order. */
function fakeBridge({ waitCode = 'the-code', redeemBody, onRequest = () => {} } = {}) {
  const requests = [];
  const http = async (url, init = {}) => {
    const parsed = new URL(url);
    const entry = { path: parsed.pathname, query: parsed.searchParams, method: init.method ?? 'GET', body: init.body };
    requests.push(entry);
    onRequest(entry);
    if (parsed.pathname === '/dragonbyte/pair/wait') {
      return { ok: true, status: 200, json: async () => ({ code: waitCode }) };
    }
    if (parsed.pathname === '/dragonbyte/pair/redeem') {
      return { ok: true, status: 200, json: async () => redeemBody };
    }
    return { ok: false, status: 404, json: async () => ({ error: 'not found' }) };
  };
  return { http, requests };
}

const CREDENTIAL = { token: 'dbt1.abc', refreshToken: 'dbt1.ref', expiresAt: 1893456000, tenantId: 'a'.repeat(32) };

test('pairing registers its handle before opening the page, then spends the code', async () => {
  // ⚠ THE ORDER IS THE BUG THIS PREVENTS. A person can finish a sign-in faster
  // than one round trip, and a page that posts to a handle nobody is holding
  // leaves this side waiting out its whole window for an answer already given.
  const order = [];
  const { http } = fakeBridge({
    redeemBody: CREDENTIAL,
    onRequest: (entry) => order.push(entry.path),
  });
  const pages = [];
  const credential = await pairWithBrowser({
    bridgeUrl: 'wss://bridge.test/dragonbyte/ws',
    env: { DSH_DRAGONBYTE_LABEL: 'office-mini' },
    http,
    open: (url) => { order.push('open'); pages.push(url); },
    log: () => {},
  });

  assert.deepEqual(order, ['/dragonbyte/pair/wait', 'open', '/dragonbyte/pair/redeem']);
  assert.deepEqual(credential, CREDENTIAL);
  // The page is on the bridge's public origin and carries the handle it must
  // wake, not a loopback callback that a browser may drop without saying so.
  const page = new URL(pages[0]);
  assert.equal(page.origin, 'https://bridge.test');
  assert.equal(page.pathname, '/dragonbyte/pair/start');
  assert.equal(page.searchParams.has('callback'), false);
  assert.ok(page.searchParams.get('handle'), 'the page must know which machine waits');
});

test('the machine names itself at redemption, because the browser cannot know it', async () => {
  // ⚠ THE BROWSER SIGNS A PERSON IN AND LEARNS NOTHING ABOUT THE MACHINE. Naming
  // it on the page would mean asking a person mid-flow; the redeem call is the
  // only point that has both the code and the hostname.
  const { http, requests } = fakeBridge({ redeemBody: CREDENTIAL });
  await pairWithBrowser({
    bridgeUrl: 'ws://127.0.0.1:3500/dragonbyte/ws', env: { DSH_DRAGONBYTE_LABEL: 'office-mini' },
    http, open: () => {}, log: () => {},
  });
  const redeem = requests.find((entry) => entry.path === '/dragonbyte/pair/redeem');
  assert.deepEqual(JSON.parse(redeem.body), { code: 'the-code', label: 'office-mini' });
});

test('a refused code is reported, never returned as a credential', async () => {
  const http = async (url) => {
    if (new URL(url).pathname === '/dragonbyte/pair/wait') return { ok: true, status: 200, json: async () => ({ code: 'c' }) };
    return { ok: false, status: 401, json: async () => ({ error: 'that pairing code is unknown or has expired' }) };
  };
  await assert.rejects(
    pairWithBrowser({ bridgeUrl: 'wss://b.test/dragonbyte/ws', http, open: () => {}, log: () => {} }),
    /unknown or has expired/,
  );
});

test('a bridge that never answers times out instead of waiting forever', async () => {
  // ⚠ THE WAIT IS A HELD HTTP REQUEST, SO IT CANNOT BE TRUSTED TO END. Without
  // this abort a run whose page was closed would hold a terminal for the
  // bridge's whole window and then some.
  let aborted = false;
  const http = (_url, init = {}) => new Promise((_resolve, reject) => {
    init.signal?.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')); });
  });
  await assert.rejects(
    pairWithBrowser({ bridgeUrl: 'wss://b.test/dragonbyte/ws', http, open: () => {}, log: () => {}, timeoutMs: 20 }),
    // ⚠ NOT "could not be reached". A person who closed the tab and a person
    // with a broken network need different fixes, and one message for both
    // sends the first to check a connection that was never the problem.
    /nobody finished signing in/,
  );
  assert.equal(aborted, true);
});

test('a fetch that fails outright is reported as an unreachable bridge', async () => {
  const http = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(
    pairWithBrowser({ bridgeUrl: 'wss://b.test/dragonbyte/ws', http, open: () => {}, log: () => {} }),
    /could not be reached while pairing/,
  );
});

test('a machine with no browser still gets the URL to open elsewhere', async () => {
  // ⚠ THIS IS THE HEADLESS CASE. `xdg-open` may not exist, and a container has
  // no browser at all, so the flow must be able to print the page and wait.
  const { http } = fakeBridge({ redeemBody: CREDENTIAL });
  const seen = [];
  const lines = [];
  await pairWithBrowser({
    bridgeUrl: 'wss://b.test/dragonbyte/ws', http,
    open: () => { throw new Error('no browser'); },
    onPage: (url) => seen.push(url),
    log: (line) => lines.push(line),
  }).catch(() => {});
  assert.equal(seen.length, 1);
  assert.match(lines.join('\n'), /pair this machine in a browser/);
  assert.match(lines.join('\n'), /\/dragonbyte\/pair\/start\?handle=/);
});

test('a given name beats the hostname, and an empty one falls back to it', async () => {
  // ⚠ REDEMPTION IS THE ONLY MOMENT A MACHINE CAN NAME ITSELF. The bridge stores
  // the name with the device there and never accepts a rename, so a flag that
  // did not reach this call would be a flag that silently did nothing.
  const labelSent = async (extra) => {
    const { http, requests } = fakeBridge({ redeemBody: CREDENTIAL });
    await pairWithBrowser({
      bridgeUrl: 'ws://127.0.0.1:3500/dragonbyte/ws',
      env: { DSH_DRAGONBYTE_LABEL: 'from-env' }, http, open: () => {}, log: () => {}, ...extra,
    });
    return JSON.parse(requests.find((entry) => entry.path === '/dragonbyte/pair/redeem').body).label;
  };
  assert.equal(await labelSent({ label: 'office-mini' }), 'office-mini');
  assert.equal(await labelSent({ label: '   ' }), 'from-env');
  assert.equal(await labelSent({}), 'from-env');
});

test('the origin swap keeps a ws bridge on http and a wss one on https', () => {
  assert.equal(httpBaseOf('wss://edge01.snapai.app/dragonbyte/ws'), 'https://edge01.snapai.app');
  assert.equal(httpBaseOf('ws://127.0.0.1:3500/dragonbyte/ws'), 'http://127.0.0.1:3500');
});

test('the label is the configured override, else this machine\'s hostname', () => {
  assert.equal(labelOf({ DSH_DRAGONBYTE_LABEL: ' office-mini ' }), 'office-mini');
  const fallback = labelOf({});
  assert.equal(typeof fallback, 'string');
  assert.notEqual(fallback, '');
});

test('a pairing link names no tenant unless one was asked for', () => {
  // ⚠ AN EMPTY `tenant` WOULD READ AS A CHOICE NOBODY MADE. The device serves
  // every tenant the account owns, so the parameter only exists when a person
  // asked to narrow it.
  assert.equal(new URL(pairPageUrl({ bridgeUrl: 'wss://b.test/dragonbyte/ws' })).searchParams.has('tenant'), false);
  assert.equal(new URL(pairPageUrl({ bridgeUrl: 'wss://b.test/dragonbyte/ws', tenantId: 'abc' })).searchParams.get('tenant'), 'abc');
});
