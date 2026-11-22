// The half that runs on the end user's machine.
//
// It is an MCP *client*, not a server: it connects to whichever MCP servers the
// user already has (stdio or Streamable HTTP), and publishes their catalog
// upward over one outbound WebSocket. Nothing dials in. That direction is what
// makes "any DSH, outside edge01" possible — the user's laptop needs no public
// name, no certificate and no inbound port, only egress to edge01.snapai.app.
//
// ⚠ THE HOST DOES NOT TRUST THE TENANT SIDE EITHER. A tool call arrives as
// `{server, tool, args}` and is dispatched only to a server named in the
// catalog this host published; an unknown pair is a refusal in the reply body,
// never a throw, because a throw crosses the socket as a protocol error and
// loses the correlation.

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { MAX_FRAME_BYTES, WIRE_VERSION, assertFrame, validateArgs, validateCatalog, validateResult } from './wire.mjs';

const CALL_TIMEOUT_MS = 60_000;
const PING_INTERVAL_MS = 30_000;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;
// Refresh this long before expiry: longer than one ping interval, so a live
// socket renews on its next tick rather than after the bridge has started
// refusing the token it is holding.
const REFRESH_MARGIN_SECONDS = 300;

function createTransport(spec) {
  if (spec.transport === 'stdio') {
    return new StdioClientTransport({
      command: spec.command,
      args: spec.args ?? [],
      env: { ...process.env, ...(spec.env ?? {}) },
      stderr: 'inherit',
    });
  }
  return new StreamableHTTPClientTransport(new URL(spec.url), {
    requestInit: { headers: spec.headers ?? {} },
  });
}

/**
 * Connect every configured MCP server and return the catalog plus a dispatcher.
 *
 * A server that fails to connect is reported and skipped rather than failing
 * the whole host: one broken server on the user's machine must not take the
 * others' tools away from their agent.
 */
export async function connectServers(specs, { log = () => {} } = {}) {
  const clients = new Map();
  const tools = new Map();
  const published = [];

  for (const spec of specs) {
    try {
      const client = new Client({ name: 'dsh-dragonbyte-host', version: '0.1.0' }, { capabilities: {} });
      await client.connect(createTransport(spec));
      const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
      const entries = [];
      for (const tool of listed.tools || []) {
        entries.push({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema ?? { type: 'object' } });
        tools.set(`${spec.name}\0${tool.name}`, { client, rawName: tool.name });
      }
      if (!entries.length) {
        await client.close();
        log(`dragonbyte-host: ${spec.name} exposes no tools; not published`);
        continue;
      }
      clients.set(spec.name, client);
      published.push({ name: spec.name, label: spec.label, tools: entries });
      log(`dragonbyte-host: ${spec.name} exposes ${entries.length} tool(s)`);
    } catch (error) {
      log(`dragonbyte-host: ${spec.name} did not connect (${error?.message || error})`);
    }
  }

  // ⚠ AN EMPTY CATALOG IS VALID HERE AND INVALID ON THE WIRE. The host must be
  // able to start, report "nothing connected", and keep retrying — crashing on
  // a config whose servers are temporarily down would make the user restart it
  // by hand for no reason. What must not happen is publishing it: the wire
  // validator refuses a tool-less catalog, so the socket stays closed until
  // there is something real to send.
  const catalog = published.length
    ? validateCatalog({ servers: published })
    : { servers: [] };

  return {
    catalog,
    clients,
    /** One `tools/call` on a published pair. Errors come back as `isError` results. */
    async call(server, tool, args) {
      const target = tools.get(`${server}\0${tool}`);
      if (!target) return { content: [{ type: 'text', text: `unknown tool ${server}/${tool}` }], isError: true };
      try {
        const result = await target.client.callTool(
          { name: target.rawName, arguments: validateArgs(args) },
          { timeout: CALL_TIMEOUT_MS },
        );
        return validateResult(result);
      } catch (error) {
        // ⚠ A THROWN CALL MAY ALREADY HAVE HAPPENED on the far side. The tool
        // result says so and the bridge never retries, because a local MCP tool
        // is an arbitrary side effect rather than a read.
        return { content: [{ type: 'text', text: `tool ${server}/${tool} failed: ${error?.message || error}` }], isError: true };
      }
    },
    async close() {
      await Promise.allSettled([...clients.values()].map((client) => client.close()));
      clients.clear();
      tools.clear();
    },
  };
}

/**
 * Keep one outbound WebSocket to the bridge open for as long as the process
 * lives, republishing the catalog on every (re)connect.
 *
 * ⚠ THE TOKEN IS A CREDENTIAL, NOT A CONFIG VALUE. `token` is a `device` token
 * minted by the gateway for this machine and this tenant; it carries the uid,
 * the address and the tenant id, so this function never needs to be told who it
 * speaks for. A `refreshToken`, when present, is exchanged over the live socket
 * before the device token expires — see `refresh`: it replaces the credential
 * without touching the socket, so a refresh never drops an in-flight call.
 *
 * `connect` is injected so a test can drive the protocol without a socket.
 */
export function serveBridge({ url, token, refreshToken = '', expiresAt = 0, tenantId = '', catalog, call, connect, log = () => {},
  onServers = () => {} }) {
  // Publishing a tool-less catalog would bind a tenant to a host that can do
  // nothing; the caller is expected to have found something to send.
  if (!catalog?.servers?.length) throw new Error('refusing to bridge an empty catalog');
  let socket = null;
  let currentToken = token;
  let currentExpiry = expiresAt;
  let boundTenant = tenantId;
  let closedByUs = false;
  let attempt = 0;
  let reconnecting = null;
  /** Persist a rotated credential. Called on every refresh; a no-op in tests. */
  let persist = () => {};

  const send = (message) => {
    if (socket && socket.readyState === 1) socket.send(JSON.stringify(message));
  };

  const publishCatalog = () => {
    send({ v: WIRE_VERSION, type: 'catalog', ...(boundTenant ? { tenantId: boundTenant } : {}), catalog });
  };

  /**
   * Exchange the refresh token for a new device token, over the open socket.
   *
   * ⚠ RENEWS ONCE PER LIFETIME, NOT ON A TIMER THAT CAN FIRE TWICE. A token that
   * is already fresh when this runs (a second call raced with the first, or the
   * process just started inside the window) is not sent again: the bridge mints
   * every time it is asked, and an unnecessary mint is a credential the user's
   * disk no longer needs to hold.
   */
  function refresh() {
    if (!refreshToken) return;
    const secondsLeft = currentExpiry - Math.floor(Date.now() / 1000);
    if (currentExpiry && secondsLeft > REFRESH_MARGIN_SECONDS) return;
    send({ v: WIRE_VERSION, type: 'refresh', token: refreshToken });
  }

  const scheduleReconnect = () => {
    if (closedByUs || reconnecting) return;
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** attempt);
    attempt += 1;
    log(`dragonbyte-host: reconnecting in ${delay}ms`);
    const timer = setTimeout(() => { reconnecting = null; open(); }, delay);
    timer.unref?.();
    reconnecting = timer;
  };

  function open() {
    if (closedByUs) return;
    socket = connect(url, {
      headers: { authorization: `Bearer ${currentToken}` },
    });
    socket.addEventListener('open', () => {
      attempt = 0;
      publishCatalog();
      refresh();
      // Ask for the servers Settings saved. The bridge answers over this socket
      // because a laptop holds a device token, not the browser's session cookie.
      send({ v: WIRE_VERSION, type: 'config' });
    });
    socket.addEventListener('message', async (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      // ⚠ THE BRIDGE'S FRAMES ARE VALIDATED, NOT ASSUMED. A newer bridge may
      // send a frame this host does not know; without this check it would be
      // silently ignored, which reads as a host that stopped answering calls.
      try {
        if (typeof message?.type === 'string') assertFrame(message, 'bridge-to-host', message.type);
      } catch (error) {
        log(`dragonbyte-host: ignoring a frame from the bridge: ${error.message}`);
        return;
      }
      if (message.type === 'refreshed') {
        currentToken = message.token;
        currentExpiry = message.expiresAt;
        // ⚠ PERSIST, THEN LOG. The new token is the only live credential until
        // this process exits, and a crash before the next write would leave the
        // disk holding one the bridge is about to refuse. Writing first means
        // the failure mode is an unused fresh token, not a dead one.
        try { persist({ token: currentToken, expiresAt: currentExpiry }); }
        catch (error) { log(`dragonbyte-host: could not save the refreshed token (${error?.message || error})`); }
        log('dragonbyte-host: device token refreshed');
        return;
      }
      if (message.type === 'tenants') {
        // ⚠ THIS FRAME IS LEGACY, AND THE REFUSAL IS GONE WITH IT. An older
        // bridge answers a tenant-less catalog by listing what the address
        // owns; that listing used to force a choice and then give up. A current
        // bridge publishes to every owned tenant on the catalog itself, so all
        // this has to do is republish and let the bridge decide.
        const owned = Array.isArray(message.tenants) ? message.tenants.filter((id) => typeof id === 'string') : [];
        if (!boundTenant && owned.length === 1) {
          boundTenant = owned[0];
          log(`dragonbyte-host: this address owns one tenant; serving ${boundTenant}`);
        }
        if (!boundTenant && owned.length > 1) {
          log(`dragonbyte-host: this address owns ${owned.length} tenants; serving all of them`);
        }
        publishCatalog();
        return;
      }
      if (message.type === 'servers') {
        // The list Settings saved for this machine. It is advisory: a machine
        // that has never been configured gets an empty list and keeps whatever
        // its credential already names, so this cannot fail a start.
        const servers = Array.isArray(message.servers) ? message.servers : [];
        try { onServers(servers); }
        catch (error) { log(`dragonbyte-host: could not apply the saved servers (${error?.message || error})`); }
        return;
      }
      if (message.type === 'error') {
        log(`dragonbyte-host: bridge refused: ${message.error || 'unknown error'}`);
        return;
      }
      // `call`: the schema already required `id`, `server` and `tool`.
      const result = await call(message.server, message.tool, message.args ?? {});
      send({ v: WIRE_VERSION, type: 'reply', id: message.id, result });
    });
    socket.addEventListener('close', () => { socket = null; scheduleReconnect(); });
    socket.addEventListener('error', () => { /* `close` always follows */ });
  }

  open();
  // ⚠ THE REFRESH TICKER IS THE SAFETY NET, NOT THE MECHANISM. `open()` refreshes
  // on connect, which covers a restart inside the window; this covers a socket
  // that stays up for longer than a token lives, which is the ordinary case for
  // a laptop left running. It fires on the same ping interval, so no second timer.
  const ping = setInterval(() => {
    if (socket?.readyState === 1) socket.send(JSON.stringify({ v: WIRE_VERSION, type: 'ping' }));
    refresh();
  }, PING_INTERVAL_MS);
  ping.unref?.();

  return {
    close() {
      closedByUs = true;
      clearInterval(ping);
      if (reconnecting) clearTimeout(reconnecting);
      socket?.close();
      socket = null;
    },
    /** Let the caller persist a rotated credential; called before it is used. */
    onRefresh(fn) { persist = typeof fn === 'function' ? fn : () => {}; },
  };
}

export { MAX_FRAME_BYTES };

/**
 * Ask the bridge what Settings saved for this machine, before any MCP server is
 * spawned, and close the socket again.
 *
 * ⚠ A SEPARATE SHORT CONNECTION, NOT A PHASE OF `serveBridge`. The catalog must
 * be published on the first connect, and the catalog comes from the servers,
 * which come from this answer — so the list has to be in hand before serving
 * starts. Reusing the serving socket would mean either publishing a catalog it
 * does not have yet or holding the socket open with nothing to send.
 *
 * Resolves to `null` — not an error — whenever the answer is anything but a
 * usable list: an older bridge that does not know `config` will answer with an
 * error frame, and a machine with nothing saved gets an empty array. Both mean
 * "fall back to what the credential already names".
 */
export function fetchServers({ url, token, connect, timeoutMs = 10000 }) {
  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket?.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    try {
      socket = connect(url, { headers: { authorization: `Bearer ${token}` } });
    } catch { return finish(null); }
    socket.addEventListener('open', () => {
      try { socket.send(JSON.stringify({ v: WIRE_VERSION, type: 'config' })); } catch { finish(null); }
    });
    socket.addEventListener('message', (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (message?.type === 'servers') {
        finish(Array.isArray(message.servers) && message.servers.length ? message.servers : null);
      } else if (message?.type === 'error') {
        finish(null);
      }
    });
    socket.addEventListener('error', () => finish(null));
    socket.addEventListener('close', () => finish(null));
  });
}
