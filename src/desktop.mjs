// The DSH Desktop half: a Settings section, and the bridge it drives.
//
// ⚠ THIS IS A CORDIS PLUGIN, NOT A SCRIPT. It installs into whatever DSH the
// person uses — today a desktop shell with its own local Host — and contributes
// two things that must run inside that Host, not beside it: the routes the
// Settings section calls, and the MCP bridge that must stay alive as long as the
// app does. A `bin` script cannot do either.
//
// ⚠ NOTHING HERE NEEDS AN EDGE01 SESSION. The machine holds a device token and
// nothing else. Pairing happens in a browser on edge01; this side only opens it,
// receives a one-time code on loopback, and trades the code for a token.
//
// ⚠ IT DEGRADES RATHER THAN REFUSING TO LOAD. No credential, no saved servers,
// no reachable bridge — each is a status the Settings section shows. Loading
// must never depend on the network, or an offline laptop loses its own settings
// UI.

import { createServer } from 'node:http';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

import { connectServers, serveBridge } from './host.mjs';
import { credentialPath, loadCredential, saveCredential } from './host-main.mjs';

export const name = 'dragonbyte';
export const inject = ['webServer'];

const DEFAULT_BRIDGE = 'wss://edge01.snapai.app/dragonbyte/ws';
const PAIR_PREFIX = '/dragonbyte/pair';
// Long enough for a person to finish a Google sign-in on a phone, short enough
// that a forgotten browser tab stops being a listener.
const PAIR_WINDOW_MS = 10 * 60 * 1000;

const json = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(payload));
};

const readBody = (req, limit = 256 * 1024) => new Promise((resolve, reject) => {
  let size = 0;
  const chunks = [];
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) { reject(Object.assign(new Error('request body is too large'), { status: 413 })); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null); }
    catch { reject(Object.assign(new Error('invalid JSON'), { status: 400 })); }
  });
  req.on('error', reject);
});

/**
 * The service prefix this DSH is served under, when it has one.
 *
 * ⚠ THE PAIRING PAGE IS SERVED BY THE BRIDGE, SO ONLY THE SERVICE IS NEEDED.
 * Its hostname is the bridge's; this reads the browser's own URL solely to keep
 * a desktop served under a prefix honest about which service it belongs to.
 */
export function bridgeUrlOf(env = process.env) {
  return env.DSH_DRAGONBYTE_BRIDGE || DEFAULT_BRIDGE;
}

export function pairPageUrl({ bridgeUrl, tenantId, callback }) {
  const url = new URL('/dragonbyte/pair/start', bridgeUrl.replace(/^ws/, 'http'));
  url.searchParams.set('tenant', tenantId);
  url.searchParams.set('callback', callback);
  return url.toString();
}

function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed in the status; the person can open it */ }
}

function apply(ctx, config = {}) {
  const bridgeUrl = config.bridgeUrl || bridgeUrlOf();
  const state = {
    credential: null,
    catalog: null,
    session: null,
    status: 'idle',
    error: '',
    connecting: null,
    pairing: null,
  };

  async function load() {
    try { state.credential = await loadCredential(); }
    catch (error) { state.error = error?.message || String(error); state.status = 'error'; }
  }

  /** Stop the MCP clients and the socket. Safe to call repeatedly. */
  async function stop() {
    state.session?.close?.();
    state.session = null;
    if (state.catalog) { await state.catalog.close?.().catch(() => {}); state.catalog = null; }
    state.status = 'idle';
  }

  async function start() {
    if (state.connecting) return state.connecting;
    state.connecting = (async () => {
      await stop();
      if (!state.credential?.token) { state.status = 'idle'; return; }
      // ⚠ ONE FORM, WRITTEN WHERE THE LIST IS EDITED AND READ HERE UNCHANGED.
      // The credential holds the spec objects `connectServers` takes, so
      // re-parsing them as a `{command|url}` config would read a stdio spec as
      // a server that "needs either command or url".
      const specs = Array.isArray(state.credential.mcpServers) ? state.credential.mcpServers : [];
      // ⚠ AN EMPTY CATALOG IS NOT PUBLISHED. Binding a tenant to a host that can
      // do nothing is worse than being offline, so a machine with no servers
      // stays "configured but not connected" and says so.
      if (!specs.length) { state.status = 'no-servers'; return; }
      state.status = 'connecting';
      const catalog = await connectServers(specs, { log: () => {} });
      state.catalog = catalog;
      if (!catalog.catalog.servers.length) { state.status = 'no-servers'; await catalog.close(); state.catalog = null; return; }
      state.session = serveBridge({
        url: bridgeUrl,
        token: state.credential.token,
        refreshToken: state.credential.refreshToken ?? '',
        expiresAt: state.credential.expiresAt ?? 0,
        tenantId: state.credential.tenantId || '',
        catalog: catalog.catalog,
        call: catalog.call,
        onServers: (servers) => { state.credential.mcpServers = servers; },
      });
      state.status = 'connected';
      state.error = '';
    })().catch((error) => {
      state.status = 'error';
      state.error = error?.message || String(error);
    }).finally(() => { state.connecting = null; });
    return state.connecting;
  }

  /**
   * Open the system browser on the pairing page and listen on loopback for the
   * code it sends back.
   *
   * ⚠ THIS LISTENER IS THE MACHINE'S PROOF. The code arrives only here, the
   * bridge is told this exact URL when the code is minted, and the listener
   * closes on the first use or the window's end.
   */
  async function pair({ tenantId }) {
    // ⚠ AN EMPTY TENANT IS THE NORMAL FIRST PAIRING. Which tenants the account
    // owns is a registry answer that only exists after sign-in, so the page is
    // opened without one and asks there; the choice comes back on its own POST.
    if (state.pairing) state.pairing.close();
    const received = new Promise((resolve, reject) => {
      const listener = createServer((req, res) => {
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const code = url.searchParams.get('code') || '';
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end('<!doctype html><meta charset="utf-8"><title>Paired</title><p>The machine is paired. You can close this window.</p>');
        finish();
        if (code) resolve(code); else reject(new Error('no pairing code was returned'));
      });
      const timer = setTimeout(() => { finish(); reject(new Error('pairing timed out')); }, PAIR_WINDOW_MS);
      timer.unref?.();
      function finish() { clearTimeout(timer); try { listener.close(); } catch {} state.pairing = null; }
      listener.on('error', (error) => { finish(); reject(error); });
      listener.listen(0, '127.0.0.1', () => {
        const { port } = listener.address();
        const callback = `http://127.0.0.1:${port}${PAIR_PREFIX}/callback`;
        openBrowser(pairPageUrl({ bridgeUrl, tenantId, callback }));
      });
      state.pairing = { close: () => { finish(); reject(new Error('pairing was cancelled')); } };
    });

    const code = await received;
    const response = await fetch(`${bridgeUrl.replace(/^ws/, 'http')}/dragonbyte/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const credential = await response.json().catch(() => null);
    if (!response.ok) throw new Error(credential?.error || 'the pairing code was refused');
    state.credential = {
      token: credential.token,
      refreshToken: credential.refreshToken,
      expiresAt: credential.expiresAt,
      tenantId: credential.tenantId,
      mcpServers: state.credential?.mcpServers ?? [],
    };
    await saveCredential(state.credential);
    await start();
    return { tenantId: state.credential.tenantId };
  }

  const publicStatus = () => ({
    status: state.status,
    ...(state.error ? { error: state.error } : {}),
    tenantId: state.credential?.tenantId || '',
    paired: Boolean(state.credential?.token),
    servers: state.credential?.mcpServers ?? [],
    credentialPath: credentialPath(),
  });

  const routes = [
    ctx.webServer.register({
      kind: 'prefix', path: '/dragonbyte',
      handler: async (req, res) => {
        const url = new URL(req.url || '/', 'http://host.invalid');
        try {
          if (url.pathname === '/dragonbyte/status' && req.method === 'GET') return json(res, 200, publicStatus());
          if (url.pathname === '/dragonbyte/pair' && req.method === 'POST') {
            const body = await readBody(req);
            return json(res, 200, await pair({ tenantId: typeof body?.tenantId === 'string' ? body.tenantId : '' }));
          }
          if (url.pathname === '/dragonbyte/credential' && req.method === 'DELETE') {
            state.credential = { token: '', refreshToken: '', expiresAt: 0, tenantId: '', mcpServers: state.credential?.mcpServers ?? [] };
            await saveCredential(state.credential);
            await stop();
            return json(res, 200, publicStatus());
          }
          if (url.pathname === '/dragonbyte/reconnect' && req.method === 'POST') {
            await start();
            return json(res, 200, publicStatus());
          }
          return json(res, 404, { error: 'not found' });
        } catch (error) {
          return json(res, Number.isInteger(error?.status) ? error.status : 500, { error: error?.message || 'dragonbyte failed' });
        }
      },
    }),
  ];

  ctx.effect(() => () => {
    for (const dispose of routes) dispose();
    state.pairing?.close?.();
    void stop();
  }, 'dragonbyte: routes and bridge');

  void load().then(() => start()).catch(() => {});
}

export { apply };
