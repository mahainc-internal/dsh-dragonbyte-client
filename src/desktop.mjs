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

import { connectServers, serveBridge } from './host.mjs';
import { credentialPath, loadCredential, saveCredential, parseServerLine } from './host-main.mjs';
import { editorCodeOf, httpBaseOf, labelOf, pairPageUrl, pairWithBrowser } from './pair.mjs';

export const name = 'dragonbyte';
export const inject = ['webServer'];

const DEFAULT_BRIDGE = 'wss://edge01.snapai.app/dragonbyte/ws';

// ⚠ RE-EXPORTED, NOT REIMPLEMENTED. The pairing flow moved into `pair.mjs` so
// the headless host runs the same one; these two names are what callers and
// tests already reach for on this module.
export { labelOf, pairPageUrl };

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
   * Open the pairing page and trade the finished sign-in for a credential.
   *
   * ⚠ THE FLOW LIVES IN `pair.mjs` AND THIS ONLY STORES WHAT IT RETURNS. The
   * headless host runs the same two routes, so a copy here would be a second
   * reading of the bridge's contract — and the one that drifted would report a
   * pairing the other could not make.
   */
  async function pair({ tenantId }) {
    const credential = await pairWithBrowser({ bridgeUrl, tenantId });
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
    // ⚠ A REFUSED LIST IS THE PANEL'S 400, NOT A 500. `editorCodeOf` takes the
    // constructor so a bridge message stays the status a caller sees; a plain
    // Error here would report "the bridge refused that server list" as an
    // internal failure and lose the one sentence that says what to fix.
    await editorCodeOf({ bridgeUrl, token: state.credential?.token, mcpServers: specs, fail: badRequest });
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
