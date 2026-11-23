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
// How often every server's tool list is read again, as the fallback for a
// `list_changed` notification that had no stream to arrive on.
const RELIST_INTERVAL_MS = 30_000;
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
 * Whether a failed call failed because the *session* is gone rather than because
 * the tool did something.
 *
 * ⚠ THE SERVER LOSES A SESSION WITHOUT TELLING THE CLIENT, AND THE CLIENT KEEPS
 * USING IT. A stateful Streamable HTTP server evicts an idle session after an
 * hour, drops every session on restart, and answers a request carrying a dead
 * id with `404 MCP session not found or expired`. Measured against OpenChatCut
 * on 2026-11-23: after its host process restarted, every call kept failing with
 * that 404 and nothing ever recovered, because the client held a session id the
 * server had forgotten. The SDK does not re-initialize on this, so the retry has
 * to happen here.
 *
 * The status alone is not enough to conclude the *tool* did nothing: a server
 * may also answer 404 from a tool-aware route. Both conditions are required —
 * a 4xx on a request that carried a session id, with a body naming a missing
 * session — and a stdio transport can never match, because it has no sessions.
 */
function sessionLost(error) {
  const status = error?.status ?? error?.code;
  if (typeof status !== 'number' || status < 400 || status >= 500) return false;
  const text = String(error?.text ?? error?.message ?? '');
  return /session (?:not found|expired|terminated)/i.test(text)
    || /-32001/.test(text);
}

/**
 * Tools whose repeat is safe to send after a transport was rebuilt.
 *
 * ⚠ THE LIST IS OF READS, NOT OF NAMES THE SERVER CALLS ITSELF. A retry after a
 * session rebuild is only safe when the first attempt provably did not run: a
 * 404 on an unknown session is rejected before the tool is dispatched, so no
 * side effect happened. That reasoning holds for every tool equally — but a tool
 * that *mutates* would also be retried on a 4xx whose body merely mentions a
 * session, and one wrong match there duplicates an edit. Reads are the subset
 * where being wrong costs nothing, so the retry is limited to them.
 *
 * Two shapes cover every server seen so far: a verb-first read
 * (`read_timeline`, `list_projects`, `get_edit_session`) and a
 * namespace-prefixed status (`openchatcut_status`, `track_export` does not
 * match and is not a read).
 */
const REPLAYABLE = /^(?:read|list|get|show|inspect|search|browse|find|view|describe)_|\w+_status$/i;

/**
 * Connect every configured MCP server and return the catalog plus a dispatcher.
 *
 * A server that fails to connect is reported and skipped rather than failing
 * the whole host: one broken server on the user's machine must not take the
 * others' tools away from their agent.
 */
export async function connectServers(specs, { log = () => {}, relistMs = RELIST_INTERVAL_MS } = {}) {
  const clients = new Map();
  const tools = new Map();
  const published = [];
  let current = { servers: [] };
  let announce = () => {};

  /** Make `listed` the server's whole tool set, here and in its published row. */
  function adopt(server, client, listed) {
    for (const key of [...tools.keys()]) {
      if (key.startsWith(`${server}\0`)) tools.delete(key);
    }
    const entries = [];
    for (const tool of listed || []) {
      entries.push({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema ?? { type: 'object' } });
      tools.set(`${server}\0${tool.name}`, { client, rawName: tool.name });
    }
    const row = published.find((entry) => entry.name === server);
    if (row) row.tools = entries;
    return entries;
  }

  /**
   * Rebuild the catalog from the published rows and hand it to the bridge.
   *
   * ⚠ THE CATALOG IS A COPY, SO A ROW EDIT REACHES NO TENANT BY ITSELF.
   * `validateCatalog` returns new objects; until this runs, the bridge keeps
   * serving the list it was given at start. A server whose list went empty is
   * left out rather than published tool-less, which the wire refuses.
   */
  function republish() {
    const servers = published.filter((row) => row.tools.length);
    if (!servers.length) {
      log('dragonbyte-host: every server now exposes no tools; keeping the last published catalog');
      return;
    }
    current = validateCatalog({ servers });
    announce(current);
  }

  /**
   * A client that follows the server's own tool list.
   *
   * ⚠ A SERVER'S TOOL LIST CAN CHANGE WHILE IT RUNS. OpenChatCut exposes 44
   * tools while its editor shows the project list and 131 once a project is
   * open (measured 2026-11-23), and says so with `tools/list_changed`. A host
   * that listed once at start served whichever half it happened to see until
   * it was restarted. The SDK re-lists on that notification; a notice from a
   * client that has since been replaced is dropped, so a closing transport
   * cannot overwrite its successor's list.
   */
  function openClient(spec) {
    const client = new Client({ name: 'dsh-dragonbyte-host', version: '0.1.0' }, {
      capabilities: {},
      listChanged: {
        tools: {
          onChanged: (error, listed) => {
            if (clients.get(spec.name) !== client) return;
            if (error) {
              log(`dragonbyte-host: ${spec.name} changed its tools but re-listing failed (${error?.message || error})`);
              return;
            }
            const entries = adopt(spec.name, client, listed);
            log(`dragonbyte-host: ${spec.name} now exposes ${entries.length} tool(s)`);
            republish();
          },
        },
      },
    });
    return client;
  }

  for (const spec of specs) {
    try {
      const client = openClient(spec);
      await client.connect(createTransport(spec));
      const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
      if (!listed.tools?.length) {
        await client.close();
        log(`dragonbyte-host: ${spec.name} exposes no tools; not published`);
        continue;
      }
      clients.set(spec.name, client);
      published.push({ name: spec.name, label: spec.label, tools: [] });
      const entries = adopt(spec.name, client, listed.tools);
      log(`dragonbyte-host: ${spec.name} exposes ${entries.length} tool(s)`);
    } catch (error) {
      log(`dragonbyte-host: ${spec.name} did not connect (${error?.message || error})`);
    }
  }

  // The spec each published server was reached with, so a session that died can
  // be re-opened without asking the caller for its configuration again.
  const specsByName = new Map(specs.map((spec) => [spec.name, spec]));
  // One rebuild per server at a time: two calls that lose the session together
  // must not each open a transport, or the older one is left running against a
  // session nobody uses and the process leaks a connection per failure.
  const rebuilding = new Map();

  function forget(server) {
    clients.delete(server);
    for (const key of [...tools.keys()]) {
      if (key.startsWith(`${server}\0`)) tools.delete(key);
    }
  }

  async function reconnect(server) {
    const pending = rebuilding.get(server);
    if (pending) return pending;
    const spec = specsByName.get(server);
    if (!spec) throw new Error(`no configuration is held for ${server}`);
    const attempt = (async () => {
      // The old client is closed before the new one is built. A stale
      // StreamableHTTP transport holds a session id the server already forgot,
      // and leaving it connected is what a later silent failure would be built
      // on.
      const previous = clients.get(server);
      forget(server);
      await previous?.close().catch(() => {});
      const client = openClient(spec);
      await client.connect(createTransport(spec));
      const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
      clients.set(server, client);
      // The published catalog is what a tenant registers tools from, so a tool
      // that appeared or disappeared during the outage has to reach it. The
      // bridge answers a republish by replacing the tenant's tool set.
      const entries = adopt(server, client, listed.tools);
      republish();
      log(`dragonbyte-host: ${server} reconnected after its session was lost`);
      return entries;
    })().finally(() => rebuilding.delete(server));
    rebuilding.set(server, attempt);
    return attempt;
  }

  /**
   * Read one server's tool list again; adopt it if it moved, rebuild if the
   * session is gone.
   *
   * ⚠ THE NOTIFICATION NEEDS A LIVE STREAM, AND A RESTARTED APP TAKES IT AWAY.
   * Measured 2026-11-23: OpenChatCut announced 44 -> 131 tools on the GET stream
   * when a project opened, then the app relaunched and every request on the old
   * session answered 404. Nothing arrives on a stream whose session the server
   * forgot, so without this a host learned of the restart only when a tenant's
   * call failed on it — and served a stale list until then. A server that is
   * down altogether is left alone and logged once; its next answer resumes it.
   */
  const failing = new Set();
  async function relist(server) {
    const client = clients.get(server);
    if (!client || rebuilding.has(server)) return;
    try {
      const listed = await client.listTools(undefined, { cacheMode: 'refresh' });
      failing.delete(server);
      if (clients.get(server) !== client) return;
      const row = published.find((entry) => entry.name === server);
      const next = (listed.tools || []).map((tool) => ({ name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema ?? { type: 'object' } }));
      if (row && JSON.stringify(row.tools) === JSON.stringify(next)) return;
      const entries = adopt(server, client, listed.tools);
      log(`dragonbyte-host: ${server} now exposes ${entries.length} tool(s)`);
      republish();
    } catch (error) {
      if (sessionLost(error)) {
        await reconnect(server).catch((rebuildError) => log(`dragonbyte-host: ${server} lost its session and reconnecting failed (${rebuildError?.message || rebuildError})`));
        return;
      }
      if (!failing.has(server)) log(`dragonbyte-host: ${server} did not answer a tool listing (${error?.message || error})`);
      failing.add(server);
    }
  }
  const relistTimer = setInterval(() => {
    for (const server of [...clients.keys()]) void relist(server);
  }, relistMs);
  relistTimer.unref?.();

  // ⚠ AN EMPTY CATALOG IS VALID HERE AND INVALID ON THE WIRE. The host must be
  // able to start, report "nothing connected", and keep retrying — crashing on
  // a config whose servers are temporarily down would make the user restart it
  // by hand for no reason. What must not happen is publishing it: the wire
  // validator refuses a tool-less catalog, so the socket stays closed until
  // there is something real to send.
  if (published.length) current = validateCatalog({ servers: published });

  return {
    /** The catalog as of now; `onCatalog` is told of every later one. */
    get catalog() { return current; },
    clients,
    /** Receive each catalog published after start, e.g. a bridge's `republish`. */
    onCatalog(fn) { announce = typeof fn === 'function' ? fn : () => {}; },
    /**
     * One `tools/call` on a published pair. Errors come back as `isError` results.
     *
     * A call that finds its session gone rebuilds the transport and, for a read,
     * sends the call once more. A write is not retried: it answers with the
     * reason and the fact that it may have run, because the only proof the first
     * attempt did nothing is the server's own 404 text, and a wrong reading of
     * that text turns one edit into two.
     */
    async call(server, tool, args) {
      const send = async () => {
        const target = tools.get(`${server}\0${tool}`);
        if (!target) return { missing: true };
        const result = await target.client.callTool(
          { name: target.rawName, arguments: validateArgs(args) },
          { timeout: CALL_TIMEOUT_MS },
        );
        return { result: validateResult(result) };
      };
      try {
        const first = await send();
        if (first.missing) return { content: [{ type: 'text', text: `unknown tool ${server}/${tool}` }], isError: true };
        return first.result;
      } catch (error) {
        if (!sessionLost(error)) {
          // ⚠ A THROWN CALL MAY ALREADY HAVE HAPPENED on the far side. The tool
          // result says so and the bridge never retries, because a local MCP tool
          // is an arbitrary side effect rather than a read.
          return { content: [{ type: 'text', text: `tool ${server}/${tool} failed: ${error?.message || error}` }], isError: true };
        }
        try {
          await reconnect(server);
        } catch (rebuildError) {
          return {
            content: [{ type: 'text', text: `tool ${server}/${tool} failed: its MCP session was lost and reconnecting failed (${rebuildError?.message || rebuildError})` }],
            isError: true,
          };
        }
        // ⚠ A SESSION THAT WAS NOT FOUND REJECTS THE REQUEST BEFORE THE TOOL
        // RUNS, so a retry of any tool is safe on this exact error. It is still
        // limited to reads, because the match above is a regular expression over
        // a server's own text and a false positive on a write would duplicate it.
        if (!REPLAYABLE.test(tool)) {
          return {
            content: [{ type: 'text', text: `tool ${server}/${tool} was not run: its MCP session had expired and the connection was rebuilt. Send it again now that the session is live.` }],
            isError: true,
          };
        }
        try {
          const second = await send();
          if (second.missing) return { content: [{ type: 'text', text: `unknown tool ${server}/${tool}` }], isError: true };
          return second.result;
        } catch (retryError) {
          return { content: [{ type: 'text', text: `tool ${server}/${tool} failed after reconnecting: ${retryError?.message || retryError}` }], isError: true };
        }
      }
    },
    /**
     * Close every server, ending the MCP session explicitly rather than by
     * dropping the socket.
     *
     * ⚠ A SESSION LEFT OPEN STRANDS WHATEVER IT OWNED. OpenChatCut ties an edit
     * draft to the MCP session that began it, and only a transport that closes
     * releases that claim (`DELETE`, or an hour of idle) — measured 2026-11-23:
     * a draft left behind by a restarted host could not be discarded by any
     * other transport until the dead one was evicted, and the editor refused
     * every new draft in the meantime. `terminateSession` is what sends that
     * DELETE; `close` alone merely closes the SSE stream.
     */
    async close() {
      clearInterval(relistTimer);
      await Promise.allSettled([...clients.values()].map(async (client) => {
        const transport = client.transport;
        try { await transport?.terminateSession?.(); } catch { /* already gone */ }
        await client.close();
      }));
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
  onServers = () => {}, keepAlive = false }) {
  // ⚠ A HEADLESS RUN OWNS ITS OWN LIFETIME; A PLUGIN DOES NOT. In a DSH Host
  // the app's event loop is what keeps the bridge running, and an unref'd timer
  // is the polite thing to leave behind. A CLI process has nothing else, so the
  // same unref'd timer is what made it exit 0 — silently — the moment the bridge
  // closed the socket, which reads exactly like a run that finished its work.
  const hold = (timer) => { if (!keepAlive) timer.unref?.(); return timer; };
  // Publishing a tool-less catalog would bind a tenant to a host that can do
  // nothing; the caller is expected to have found something to send.
  if (!catalog?.servers?.length) throw new Error('refusing to bridge an empty catalog');
  let socket = null;
  let currentCatalog = catalog;
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
    send({ v: WIRE_VERSION, type: 'catalog', ...(boundTenant ? { tenantId: boundTenant } : {}), catalog: currentCatalog });
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
    const timer = hold(setTimeout(() => { reconnecting = null; open(); }, delay));
    reconnecting = timer;
  };

  function open() {
    if (closedByUs) return;
    const live = connect(url, {
      headers: { authorization: `Bearer ${currentToken}` },
    });
    socket = live;
    live.addEventListener('open', () => {
      attempt = 0;
      publishCatalog();
      refresh();
      // Ask for the servers Settings saved. The bridge answers over this socket
      // because a laptop holds a device token, not the browser's session cookie.
      send({ v: WIRE_VERSION, type: 'config' });
    });
    live.addEventListener('message', async (event) => {
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
    live.addEventListener('close', () => {
      if (socket !== live) return;
      socket = null;
      scheduleReconnect();
    });
    // ⚠ A REFUSED HANDSHAKE IS AN `error` WITH NO `close`, AND THAT IS THE
    // ORDINARY REFUSAL PATH. Measured on Node 22 against a live bridge: a
    // non-101 answer emits `error` and then nothing — `readyState` stays 0 and
    // `close` never fires. Waiting for that `close` meant a wrong or expired
    // token produced no refusal log, no retry, and a process that exited 0 the
    // moment the event loop drained: the run looked like it had simply finished.
    live.addEventListener('error', () => {
      // ⚠ ONLY WHEN THIS SOCKET IS STILL THE CURRENT ONE AND NEVER CONNECTED.
      // A socket that did open is followed by its own `close`, and tearing it
      // down here would cut a live call short for an error that was not fatal.
      if (socket !== live || live.readyState !== 0) return;
      // ⚠ NOTHING IS CLOSED HERE, AND THAT IS DELIBERATE. Calling `close()` on
      // a socket that never opened emits `error` again — synchronously, on this
      // same listener — and the handler re-entered itself until the stack ran
      // out (measured: 62KB of the same line inside 14ms). The socket is
      // already dead; dropping the reference is the whole cleanup.
      log('dragonbyte-host: the bridge refused the connection; check the device token');
      socket = null;
      scheduleReconnect();
    });
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
  hold(ping);

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
    /**
     * Replace the published catalog and send it now if the socket is open.
     *
     * The bridge treats a second `catalog` frame on a live socket as a new
     * revision and the tenant re-registers on its next poll. A closed socket
     * needs nothing more: every (re)connect publishes the latest catalog.
     */
    republish(next) {
      if (!next?.servers?.length) return;
      currentCatalog = next;
      publishCatalog();
    },
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
