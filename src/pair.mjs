// Pairing a machine, from either half of this package.
//
// ⚠ ONE CONTRACT, TWO CALLERS. DSH Desktop opens the page and waits on it, and
// the headless host does the same thing from a terminal. A second copy of this
// flow would drift from the bridge's routes, and the drift would show up as a
// machine that says it paired and holds no credential.
//
// ⚠ THE BROWSER IS NEVER OPTIONAL, AND IT IS NEVER IN THIS PROCESS. Firebase
// refuses an origin it does not know, and both callers are origins it will never
// accept. The page is served by the bridge on the host's public name; this side
// only says "here is a handle", opens it, and reads back the code the sign-in
// produced.
//
// ⚠ THE CODE ARRIVES THROUGH THE BRIDGE, NOT THROUGH LOOPBACK. The code is
// minted in the browser's own copy of the page, so nothing this side fetches
// ever contains it. The page posts it to `/dragonbyte/pair/ready` with the
// handle this side registered, and `/dragonbyte/pair/wait` answers with it. A
// loopback callback would be a cross-origin load a browser may drop without
// saying so — and it does not exist on a machine with no browser at all.

import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { hostname } from 'node:os';

// The bridge holds the waiting request this long. Matched on the bridge's own
// window, with a margin so this side is not what gives up first.
const WAIT_TTL_MS = 5 * 60 * 1000;

/**
 * The plain HTTP origin the bridge's REST routes live on.
 *
 * ⚠ THE SOCKET URL'S PATH IS NOT A BASE. `DEFAULT_BRIDGE` ends in `/dragonbyte/ws`,
 * which is where the WebSocket route is mounted, so appending `/dragonbyte/pair/…`
 * to it produced `/dragonbyte/ws/dragonbyte/pair/…` — answered 401 by the gateway,
 * which reads exactly like the machine never signed in.
 */
export function httpBaseOf(bridgeUrl) {
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

/** Open a URL in whatever browser this machine has, and never fail if it has none. */
export function openBrowser(url) {
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* the URL is printed; the person can open it somewhere else */ }
}

/**
 * Ask the bridge for a short-lived editor code, or `''` when it cannot answer.
 *
 * ⚠ THE CODE IS NOT KEPT, BECAUSE IT CANNOT BE. The bridge holds it in memory
 * for an hour; a copy saved beside the credential would be dead by the time a
 * person used it. The device token is signed and can always ask again.
 */
export async function editorCodeOf({ bridgeUrl, token, mcpServers, http = globalThis.fetch, fail = (message) => new Error(message) }) {
  if (!token) return '';
  const response = await http(`${httpBaseOf(bridgeUrl)}/dragonbyte/pair/servers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mcpServers === undefined ? { token } : { token, mcpServers }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw fail(body?.error || 'the bridge refused that server list');
  }
  const body = await response.json();
  return typeof body?.code === 'string' ? body.code : '';
}

/**
 * Hold this request until the browser finishes signing in, then take the code.
 *
 * ⚠ THE HANDLE IS THIS MACHINE'S CLAIM ON THE RESULT, AND IT IS THE ONLY ONE.
 * It is 16 random bytes, never shown to anyone, and the bridge keeps it until it
 * either hands over a code or the window closes.
 */
async function waitForPairing({ bridgeUrl, handle, http, signal }) {
  let response;
  try {
    response = await http(`${httpBaseOf(bridgeUrl)}/dragonbyte/pair/wait?handle=${encodeURIComponent(handle)}`,
      { cache: 'no-store', signal });
  } catch (error) {
    // ⚠ A TIMED-OUT SIGN-IN IS NOT AN UNREACHABLE BRIDGE. Both arrive here as a
    // rejected fetch, and reporting the timeout as "could not be reached" sends
    // a person to check their network for a page they simply did not finish.
    if (signal?.aborted || error?.name === 'AbortError') throw new Error('nobody finished signing in before the window closed');
    throw new Error('the bridge could not be reached while pairing');
  }
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error || 'the bridge refused to register this machine');
  if (typeof body?.code !== 'string' || !body.code) throw new Error('sign-in did not finish on the bridge');
  return body.code;
}

async function redeem({ bridgeUrl, code, label, http }) {
  const response = await http(`${httpBaseOf(bridgeUrl)}/dragonbyte/pair/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // ⚠ THE NAME IS SENT HERE, BY THE ONLY CALLER THAT KNOWS IT. The browser
    // signs in and hands over a code; it never learns what this machine is
    // called, so naming it there would mean asking a person mid-flow.
    body: JSON.stringify({ code, label }),
  });
  const credential = await response.json().catch(() => null);
  if (!response.ok) throw new Error(credential?.error || 'the pairing code was refused');
  return credential;
}

/**
 * Pair this machine through a browser, and resolve with the device credential.
 *
 * Everything is injectable so this is testable without a network, a browser or a
 * terminal: `http` stands in for `fetch`, `open` for the browser launch.
 *
 * `onPage` receives the URL before it is opened — a machine with no browser has
 * to be able to print it for a person to open elsewhere.
 */
export async function pairWithBrowser({
  bridgeUrl, tenantId = '', env = process.env, log = () => {}, onPage = () => {},
  open = openBrowser, http = globalThis.fetch, timeoutMs = WAIT_TTL_MS + 30_000,
}) {
  const handle = randomBytes(16).toString('base64url');
  // Registered before the page is opened: a person can finish a sign-in faster
  // than a round trip, and a page that posts to a handle nobody is holding
  // leaves this side waiting out its whole window for an answer already given.
  const controller = new AbortController();
  // ⚠ THIS TIMER IS NOT UNREF'D, AND A CLI IS WHY. `unref` says "the work behind
  // this timer may be abandoned" — true of a ping tick, false of the one deadline
  // that bounds a person's sign-in. Measured in this package: an unref'd timer
  // here let the event loop drain before it fired, so a bridge that never
  // answered ended the run with no timeout and no error at all.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const waiting = waitForPairing({ bridgeUrl, handle, http, signal: controller.signal });
  try {
    const page = pairPageUrl({ bridgeUrl, handle, tenantId });
    onPage(page);
    log(`dragonbyte-host: pair this machine in a browser:\n  ${page}`);
    // ⚠ A MACHINE WITH NO BROWSER IS NOT AN ERROR. `xdg-open` may be missing, or
    // there may be no desktop at all; the URL is already printed, so the person
    // can open it elsewhere and this side keeps waiting for the sign-in.
    try { open(page); }
    catch (error) { log(`dragonbyte-host: could not open a browser (${error?.message || error}); open the URL above`); }
    const code = await waiting;
    log('dragonbyte-host: sign-in finished; taking the device credential');
    return await redeem({ bridgeUrl, code, label: labelOf(env), http });
  } finally {
    clearTimeout(timer);
  }
}

export { WAIT_TTL_MS };
