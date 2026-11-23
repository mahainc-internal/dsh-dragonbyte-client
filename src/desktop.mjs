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

import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

import { connectServers, serveBridge } from './host.mjs';
import { credentialPath, loadCredential, saveCredential, parseServerLine } from './host-main.mjs';

export const name = 'dragonbyte';
export const inject = ['webServer'];

const DEFAULT_BRIDGE = 'wss://edge01.snapai.app/dragonbyte/ws';
// The bridge holds the waiting request this long. Matched on the bridge's own
// window, with a margin so this side is not what gives up first.
const WAIT_TTL_MS = 5 * 60 * 1000;

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

export function bridgeUrlOf(env = process.env) {
  return env.DSH_DRAGONBYTE_BRIDGE || DEFAULT_BRIDGE;
}

/**
 * The plain HTTP origin the bridge's REST routes live on.
 *
 * ⚠ THE SOCKET URL'S PATH IS NOT A BASE. `DEFAULT_BRIDGE` ends in `/dragonbyte/ws`,
 * which is where the WebSocket route is mounted, so appending `/dragonbyte/pair/…`
 * to it produced `/dragonbyte/ws/dragonbyte/pair/…` — answered 401 by the gateway,
 * which reads exactly like the machine never signed in.
 */
function httpBaseOf(bridgeUrl) {
  const url = new URL(bridgeUrl);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url.origin;
}

/**
 * What this machine calls itself in the tenant's Settings.
 *
 * ⚠ THE OS HOSTNAME, NOT A PROMPT. Pairing is a browser round trip and asking a
 * person to type a name there would add a step to the flow that most needs to
 * be one click. `DSH_DRAGONBYTE_LABEL` overrides it for a person who runs two
 * machines whose hostnames look alike.
 */
export function labelOf(env = process.env) {
  const configured = String(env.DSH_DRAGONBYTE_LABEL ?? '').trim();
  if (configured) return configured.slice(0, 80);
  try { return String(hostname() || '').slice(0, 80); }
  catch { return ''; }
}

/**
 * Ask the bridge for a short-lived editor code, or `''` when it cannot answer.
 *
 * ⚠ THE CODE IS NOT KEPT, BECAUSE IT CANNOT BE. The bridge holds it in memory
 * for an hour; a copy saved beside the credential would be dead by the time a
 * person used it. The device token is signed and can always ask again.
 */
async function editorCodeOf({ bridgeUrl, token, mcpServers }) {
  if (!token) return '';
  const response = await fetch(`${httpBaseOf(bridgeUrl)}/dragonbyte/pair/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mcpServers === undefined ? { token } : { token, mcpServers }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw badRequest(body?.error || 'the bridge refused that server list');
  }
  const body = await response.json();
  return typeof body?.code === 'string' ? body.code : '';
}

export function pairPageUrl({ bridgeUrl, code = '', handle = '', tenantId = '', callback = '' }) {
  const url = new URL('/dragonbyte/pair/start', httpBaseOf(bridgeUrl));
  // ⚠ ONLY THE PARAMETERS THAT EXIST. An empty `tenant` would be sent as a
  // tenant named "", which reads as a choice nobody made.
  if (tenantId) url.searchParams.set('tenant', tenantId);
  // ⚠ THE CODE IS THE PAGE'S SUBJECT, NOT A RESUME TOKEN. It is what the person
  // signs in to spend; the page shows it back so a different machine can be
  // paired from the same browser session.
  if (code) url.searchParams.set('code', code);
  // ⚠ THE HANDLE IS HOW THE PAGE FINDS THE MACHINE WAITING FOR IT. Without it
  // the sign-in completes in the browser and nothing on this side hears about it.
  if (handle) url.searchParams.set('handle', handle);
  if (callback) url.searchParams.set('callback', callback);
  return url.toString();
}

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Typed lines -> the spec objects `connectServers` and the bridge both take.
 *
 * ⚠ ONE LINE, ONE SERVER, AND THE COMMAND IS NOT RUN THROUGH A SHELL. The parse
 * is `parseServerLine`, the same one the headless prompt uses, so a line means
 * the same thing here, there, and on a Windows machine.
 */
export function parseServerLines(text) {
  const specs = [];
  const seen = new Set();
  String(text ?? '').split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const at = line.indexOf(':');
    if (at < 1) throw badRequest(`line ${index + 1}: write "name: command" or "name: https://url"`);
    const name = line.slice(0, at).trim();
    if (seen.has(name)) throw badRequest(`line ${index + 1}: ${name} is listed twice`);
    seen.add(name);
    try { specs.push(parseServerLine(name, line.slice(at + 1))); }
    catch (error) { throw badRequest(`line ${index + 1}: ${error.message}`); }
  });
  return specs;
}

/** One spec -> the line this panel shows and a person edits. */
export function serverLine(spec) {
  if (!spec || typeof spec !== 'object') return '';
  if (spec.transport === 'http') return `${spec.name}: ${spec.url}`;
  return `${spec.name}: ${[spec.command, ...(spec.args ?? [])].join(' ')}`;
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
      // ⚠ THE LIST IS READ FROM THE EDITOR BEFORE EACH CONNECT. A list saved on
      // the bridge after this machine last ran is what the person meant; the
      // copy in the credential is a cache for an offline start.
      try {
        const code = await editorCodeOf({ bridgeUrl, token: state.credential.token });
        if (code) {
          const url = `${httpBaseOf(bridgeUrl)}/dragonbyte/pair/servers?code=${encodeURIComponent(code)}`;
          const response = await fetch(url, { cache: 'no-store' });
          if (response.ok) {
            const body = await response.json();
            // ⚠ AN EMPTY LIST IS AN ANSWER, NOT A MISS. A person who deletes
            // every server means to share none; keeping the cached copy would
            // publish a list they just removed.
            if (Array.isArray(body?.mcpServers)) {
              state.credential.mcpServers = body.mcpServers;
              await saveCredential(state.credential);
            }
          }
        }
      } catch { /* offline: keep the cached list, which is what lets it start */ }
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
        // ⚠ `connect` IS AN INJECTED DEPENDENCY, NOT A REFERENCE TO GLOBAL
        // WebSocket — `serveBridge` defaults it to `undefined` so a test can
        // drive the protocol without a socket. Omitting it here made `open()`
        // throw `connect is not a function` on every start, so the machine
        // held an open MCP connection, showed nothing, and never dialed the
        // bridge. `host-main.mjs` has always passed this line.
        connect: (url, { headers }) => new WebSocket(url, { headers }),
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
   * Open the pairing page and wait for the bridge to hand this machine a code.
   *
   * ⚠ THE CODE COMES FROM THE BRIDGE, NOT FROM THE PAGE. It is minted in the
   * browser's own copy of the page, so fetching that page from here returns
   * markup with no code in it and can only ever time out. The sign-in ends on
   * the bridge, and the bridge answers this request with the code directly.
   */
  async function pair({ tenantId }) {
    // ⚠ AN EMPTY TENANT IS THE NORMAL FIRST PAIRING, AND THE PAGE NAMES NONE.
    // The device is scoped to the account, so there is nothing to choose; the
    // bridge checks ownership from the registry on every catalog it publishes.
    const handle = randomBytes(16).toString('base64url');
    const issued = waitForPairing(handle);
    openBrowser(pairPageUrl({ bridgeUrl, handle, tenantId }));
    return redeem((await issued).code);
  }

  /**
   * Hold this request until the browser finishes signing in, then take the code.
   *
   * ⚠ THE HANDLE IS THIS MACHINE'S CLAIM ON THE RESULT, AND IT IS THE ONLY
   * ONE. It is 16 random bytes, never shown to anyone, and the bridge keeps it
   * until it either hands over a code or the window closes.
   */
  async function waitForPairing(handle) {
    const response = await fetch(`${httpBaseOf(bridgeUrl)}/dragonbyte/pair/wait?handle=${encodeURIComponent(handle)}`,
      { cache: 'no-store', signal: AbortSignal.timeout(WAIT_TTL_MS + 30_000) }).catch(() => null);
    if (!response) throw new Error('the bridge could not be reached while pairing');
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error || 'the bridge refused to register this machine');
    if (typeof body?.code !== 'string' || !body.code) throw new Error('sign-in did not finish on the bridge');
    return body;
  }

  /**
   * Adopt a device token typed into Settings.
   *
   * ⚠ THIS IS THE PATH THAT DOES NOT NEED A BROWSER OR A CODE. A token minted in
   * the tenant's own Settings -> DragonByte proves the same thing a pairing code
   * does, and this machine already knows how to hold one: the headless host has
   * taken a pasted token since it existed. Refusing it here only meant a desktop
   * had to route the same proof through a page instead.
   *
   * ⚠ THE PREFIX IS CHECKED BEFORE ANYTHING IS SAVED. A pasted line that is not
   * a device token is a paste mistake, not a credential — writing it would make
   * "paired" true and every call fail afterwards.
   */
  async function adoptToken(text) {
    const token = String(text ?? '').trim();
    if (!token) throw badRequest('a device token is required');
    if (!/^dbt1[.A-Za-z0-9_-]+$/.test(token)) throw badRequest('that is not a device token (it should start with dbt1)');
    state.credential = { token, refreshToken: '', expiresAt: 0, tenantId: '', mcpServers: state.credential?.mcpServers ?? [] };
    await saveCredential(state.credential);
    await start();
  }

  async function redeem(code) {
    const response = await fetch(`${httpBaseOf(bridgeUrl)}/dragonbyte/pair/redeem`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // ⚠ THE NAME IS SENT HERE, BY THE ONLY CALLER THAT KNOWS IT. The browser
      // signs in and hands over a code; it never learns what this machine is
      // called, so naming it there would mean asking a person mid-flow.
      body: JSON.stringify({ code, label: labelOf() }),
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

  /**
   * Save the list the panel holds, then reconnect with it.
   *
   * ⚠ THE BRIDGE IS WRITTEN FIRST, AND THE CREDENTIAL ONLY AFTER IT AGREES. The
   * bridge re-reads this list on the machine's next start, so a save that never
   * reached it must not look saved here. The credential copy is what lets an
   * offline start publish the list the person last confirmed.
   *
   * ⚠ AN EMPTY LIST IS SAVED, NOT SKIPPED. Deleting every server is how a
   * machine stops sharing; `start()` then publishes nothing and says so.
   */
  async function saveServers(text) {
    const specs = parseServerLines(text);
    await editorCodeOf({ bridgeUrl, token: state.credential?.token, mcpServers: specs });
    state.credential = { ...(state.credential ?? {}), mcpServers: specs };
    await saveCredential(state.credential);
    await start();
  }

  const publicStatus = () => ({
    status: state.status,
    ...(state.error ? { error: state.error } : {}),
    tenantId: state.credential?.tenantId || '',
    paired: Boolean(state.credential?.token),
    // ⚠ THE NAME THE TENANT SAW AT PAIRING, SHOWN BACK HERE. It is the same
    // `labelOf()` sent to the bridge in `pair`, so Settings names this machine
    // exactly as the tenant's device list does. A person running two machines
    // with alike hostnames sets `DSH_DRAGONBYTE_LABEL` to tell them apart.
    label: labelOf(),
    // The list as text, because this panel is where it is typed. The credential
    // holds specs; the panel holds one line per server.
    servers: (state.credential?.mcpServers ?? []).map(serverLine).join('\n'),
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
            await pair({ tenantId: typeof body?.tenantId === 'string' ? body.tenantId : '' });
            return json(res, 200, publicStatus());
          }
          if (url.pathname === '/dragonbyte/token' && req.method === 'PUT') {
            const body = await readBody(req);
            await adoptToken(body?.token);
            return json(res, 200, publicStatus());
          }
          if (url.pathname === '/dragonbyte/servers' && req.method === 'PUT') {
            const body = await readBody(req);
            await saveServers(typeof body?.text === 'string' ? body.text : '');
            return json(res, 200, publicStatus());
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
    void stop();
  }, 'dragonbyte: routes and bridge');

  void load().then(() => start()).catch(() => {});
}

export { apply };
