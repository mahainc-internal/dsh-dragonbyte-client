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
import { credentialPath, loadCredential, saveCredential, specsFromConfig } from './host-main.mjs';
import { editorCodeOf, httpBaseOf, labelOf, pairPageUrl, pairWithBrowser } from './pair.mjs';
import { fetchGatewayModels, normalizeGatewayUrl, GATEWAY_BASE_URL, syncProvider, removeProvider } from './provider.mjs';

export const name = 'dragonbyte';
// ⚠ `settings` AND `credentials` ARE OPTIONAL, NOT REQUIRED. They are what makes
// the AI gateway usable, and a Host without them can still serve MCP servers;
// requiring them would turn a late-arriving service into a plugin that never
// loads. The registration is attempted through `ctx.inject` and skipped quietly
// when the Host has no model settings surface.
export const inject = ['webServer'];

// The address the machine registers against is the deployment's by default and
// a Settings field when someone runs another gateway.
export { GATEWAY_BASE_URL as DEFAULT_AI_GATEWAY } from './provider.mjs';

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

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

/**
 * A pasted `.mcp.json` document -> the spec objects the bridge and `connectServers` take.
 *
 * ⚠ THE SAME PARSER `--mcp` USES. A machine configured by hand and a machine
 * configured in this panel must mean the same thing, and a second spelling of
 * the format is how the two drift. `specsFromConfig` is that one parser.
 *
 * ⚠ WHAT THE PERSON PASTES IS WHAT THEIR EDITOR SHOWS: a standard `.mcp.json`,
 * with `mcpServers` either wrapped in the document or pasted alone.
 */
export function parseServerConfig(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return [];
  let document;
  try { document = JSON.parse(raw); }
  catch (error) { throw badRequest(`not valid JSON: ${error.message}`); }
  // ⚠ THE BARE `mcpServers` OBJECT IS ACCEPTED TOO. Copying the inner object out
  // of a larger file is an ordinary thing to do, and refusing it would be a
  // formatting rule nobody can see.
  const config = document?.mcpServers !== undefined ? document : { mcpServers: document };
  try { return specsFromConfig(config); }
  catch (error) { throw badRequest(error.message); }
}

/** The specs this machine holds -> the document the panel shows and a person edits. */
export function serverConfigText(specs) {
  const servers = {};
  for (const spec of specs ?? []) {
    if (!spec || typeof spec !== 'object' || !spec.name) continue;
    if (spec.transport === 'http') {
      servers[spec.name] = {
        ...(typeof spec.type === 'string' ? { type: spec.type } : {}),
        url: spec.url,
        ...(Object.keys(spec.headers ?? {}).length ? { headers: spec.headers } : {}),
      };
    } else {
      servers[spec.name] = {
        command: spec.command,
        ...(spec.args?.length ? { args: spec.args } : {}),
        ...(Object.keys(spec.env ?? {}).length ? { env: spec.env } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers: servers }, null, 2);
}

/** One spec -> the line this panel shows and a person edits. */
function apply(ctx, config = {}) {
  const bridgeUrl = config.bridgeUrl || bridgeUrlOf();
  const state = {
    credential: null,
    catalog: null,
    session: null,
    status: 'idle',
    error: '',
    connecting: null,
    // Filled by the `settings`/`credentials` injection below; null on a Host
    // that has no model settings surface.
    models: null,
    gatewayModels: [],
    gatewayError: '',
  };

  // ⚠ A LOAD IN FLIGHT MUST NOT OVERWRITE A SAVE THAT LANDED WHILE IT READ.
  // `load()` runs at apply and again after pairing; the read is asynchronous,
  // so a save that completes in between would be clobbered by the older copy
  // the load had already asked for — the field would snap back to the previous
  // value and the save would look ignored. Every in-memory change bumps this.
  let credentialVersion = 0;

  async function load() {
    const version = credentialVersion;
    try {
      const value = await loadCredential();
      if (version === credentialVersion) state.credential = value;
    }
    catch (error) { state.error = error?.message || String(error); state.status = 'error'; }
  }

  /** Assign and persist in one step, so a load in flight cannot undo it. */
  async function commitCredential(value) {
    credentialVersion += 1;
    state.credential = value;
    await saveCredential(value);
  }

  /**
   * The gateway this machine will register and ask.
   *
   * ⚠ A SAVED ADDRESS WINS OVER THE DEPLOYMENT DEFAULT, AND NOTHING IS WRITTEN
   * HERE. The choice lives in the credential because that is the one file that
   * already belongs to this machine; reading it per use is what lets a person
   * change the address and have the next refresh, restart or reconnect follow
   * it without a migration.
   */
  const gatewayUrl = () => state.credential?.aiGateway || GATEWAY_BASE_URL;

  /** Ask the gateway what models this device token may use, then register them. */
  async function refreshGatewayModels({ fetchImpl = fetch } = {}) {
    if (!state.credential?.token) return;
    const baseURL = gatewayUrl();
    try {
      const { models } = await fetchGatewayModels(state.credential.token, { baseURL, fetchImpl });
      state.gatewayModels = models;
      state.gatewayError = '';
    } catch (error) {
    // ⚠ A REFUSED TOKEN WITHDRAWS THE ROUTE. Leaving a provider whose key the
      // gateway rejects turns "you were disconnected" into "every model fails".
      state.gatewayModels = [];
      state.gatewayError = error?.message || String(error);
    }
    // ⚠ THE ROUTE FOLLOWS THE ANSWER ON BOTH PATHS. A refresh that now succeeds
    // must restore a route a previous refusal removed, and one that fails must
    // remove it — `syncProvider` decides from `gatewayModels` alone.
    if (state.models && state.credential?.token) {
      try {
        await syncProvider({ settings: state.models.settings, credentials: state.models.credentials, token: state.gatewayModels.length ? state.credential.token : '', models: state.gatewayModels, baseURL });
      } catch (error) {
        state.gatewayError = error?.message || String(error);
      }
    }
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
              await commitCredential({ ...(state.credential ?? {}), mcpServers: body.mcpServers });
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
      const session = state.session;
      catalog.onCatalog((next) => session.republish(next));
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
      // ⚠ THE GATEWAY SURVIVES A RE-PAIR. It is a property of this machine's
      // configuration, not of the token being replaced.
      ...(state.credential?.aiGateway ? { aiGateway: state.credential.aiGateway } : {}),
    };
    await commitCredential(state.credential);
    await start();
    void refreshGatewayModels();
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
    await commitCredential({ token, refreshToken: '', expiresAt: 0, tenantId: '', mcpServers: state.credential?.mcpServers ?? [], ...(state.credential?.aiGateway ? { aiGateway: state.credential.aiGateway } : {}) });
    await start();
    void refreshGatewayModels();
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
    const specs = parseServerConfig(text);
    // ⚠ A REFUSED LIST IS THE PANEL'S 400, NOT A 500. `editorCodeOf` takes the
    // constructor so a bridge message stays the status a caller sees; a plain
    // Error here would report "the bridge refused that server list" as an
    // internal failure and lose the one sentence that says what to fix.
    await editorCodeOf({ bridgeUrl, token: state.credential?.token, mcpServers: specs, fail: badRequest });
    await commitCredential({ ...(state.credential ?? {}), mcpServers: specs });
    await start();
  }

  /**
   * Point this machine at another AI gateway and register its models there.
   *
   * ⚠ THE ADDRESS IS SAVED BEFORE IT IS TESTED, AND AN ANSWER THAT FAILS IS
   * REPORTED, NOT REVERTED. A gateway still being brought up is a reason to
   * keep the address and show its error, not to silently go back to a host the
   * person just said is wrong; the field and the error sentence together say
   * what is saved and what it did.
   */
  async function saveGateway(text) {
    let baseURL;
    try { baseURL = normalizeGatewayUrl(text); }
    catch (error) { throw badRequest(error.message); }
    await commitCredential({ ...(state.credential ?? {}), aiGateway: baseURL });
    await refreshGatewayModels();
  }

  const publicStatus = () => ({
    status: state.status,
    ...(state.error ? { error: state.error } : {}),
    tenantId: state.credential?.tenantId || '',
    paired: Boolean(state.credential?.token),
    // ⚠ THE GATEWAY IS AN ADDRESS A PERSON MAY CHANGE. It is shown in the same
    // text form the route accepts, so the panel edits what it displays.
    aiGateway: gatewayUrl(),
    aiGatewayIsDefault: !state.credential?.aiGateway,
    // ⚠ THE NAME THE TENANT SAW AT PAIRING, SHOWN BACK HERE. It is the same
    // `labelOf()` sent to the bridge in `pair`, so Settings names this machine
    // exactly as the tenant's device list does. A person running two machines
    // with alike hostnames sets `DSH_DRAGONBYTE_LABEL` to tell them apart.
    label: labelOf(),
    // The list as the document a person pastes, because this panel is where it
    // is edited. The credential holds specs; the panel holds `.mcp.json` text.
    servers: serverConfigText(state.credential?.mcpServers),
    credentialPath: credentialPath(),
    // ⚠ A COUNT, NOT THE MODELS. The panel edits which gateway is asked and
    // reports whether asking produced models, with a failure sentence when it
    // did not, so a person can tell "paired but the gateway refused this token"
    // from "paired and working".
    modelCount: state.gatewayModels.length,
    ...(state.models ? {} : { modelsUnavailable: 'this Host has no model settings' }),
    ...(state.gatewayError ? { gatewayError: state.gatewayError } : {}),
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
          if (url.pathname === '/dragonbyte/gateway' && req.method === 'PUT') {
            const body = await readBody(req);
            await saveGateway(typeof body?.url === 'string' ? body.url : '');
            return json(res, 200, publicStatus());
          }
          if (url.pathname === '/dragonbyte/credential' && req.method === 'DELETE') {
            await commitCredential({ token: '', refreshToken: '', expiresAt: 0, tenantId: '', mcpServers: state.credential?.mcpServers ?? [], ...(state.credential?.aiGateway ? { aiGateway: state.credential.aiGateway } : {}) });
            await stop();
            // ⚠ DISCONNECT WITHDRAWS THE MODELS TOO. The device token was the
            // provider's only credential; leaving the route behind would keep
            // stale models in the picker that every call then fails to use.
            state.gatewayModels = [];
            state.gatewayError = '';
            if (state.models) await removeProvider(state.models).catch(() => {});
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

  // ⚠ OPTIONAL SERVICES ARE INJECTED, NOT DECLARED REQUIRED. `settings` is
  // disabled on a Host with no profile context (base bundle guards it), so a
  // required inject would keep this whole plugin — MCP serving included — from
  // loading on exactly the Hosts that pair machines.
  // ⚠ A HOST WITHOUT `inject` HAS NO SERVICE GRAPH AT ALL, so there is no model
  // settings surface to register into. `typeof` rather than a try/catch: the
  // absence is a fact about the Host, not a failure of the registration.
  if (typeof ctx.inject === 'function') ctx.inject(['settings', 'credentials'], (scope) => {
    state.models = { settings: scope.settings, credentials: scope.credentials };
    // ⚠ THE FIRST SYNC HAPPENS AFTER LOAD, NOT AT APPLY. A credential on disk is
    // the ordinary case; waiting for a pair would register nothing for a machine
    // that has been paired for weeks.
    void load().then(async () => {
      await refreshGatewayModels();
      await start();
    }).catch(() => {});
    scope.effect(() => () => { state.models = null; }, 'dragonbyte: model registration');
  });

  void load().then(() => start()).catch(() => {});
}

export { apply };
