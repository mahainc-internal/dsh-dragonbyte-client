#!/usr/bin/env node
// `dsh-dragonbyte-host` — run on the machine that holds the MCP servers.
//
//   dsh-dragonbyte-host
//
// The first run opens a browser to pair this machine with the DSH account; the
// credential it comes back with is saved and renewed, so later runs pair
// nothing. To reuse the config every MCP client already has, pass that file:
//
//   dsh-dragonbyte-host --mcp ./mcp.json
//
//   { "mcpServers": {
//       "fs":   { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"] },
//       "docs": { "url": "https://mcp.example.com/mcp", "headers": { "authorization": "Bearer ..." } } } }

import { readFileSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { createInterface } from 'node:readline/promises';

import { connectServers, fetchServers, serveBridge } from './host.mjs';
import { pairWithBrowser } from './pair.mjs';

/**
 * Where the credential lives, and why it is a file rather than a flag.
 *
 * ⚠ 0600 IN THE USER'S OWN CONFIG DIRECTORY, NEVER IN THE PROJECT. This file is
 * a bearer credential for one person's DSH; a copy in a repository is a leaked
 * credential, and a default umask would make it group-readable on a shared
 * machine. `XDG_CONFIG_HOME` is honoured because that is where a desktop user
 * looks when they need to revoke something by hand.
 */
export function credentialPath(env = process.env) {
  const base = env.DSH_DRAGONBYTE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'dsh-dragonbyte');
  return join(base, 'credential.json');
}

/** `null` when nothing is saved — a first run, not an error. */
export async function loadCredential(env = process.env, io = {}) {
  const read = io.readFile ?? readFile;
  try {
    const value = JSON.parse(await read(credentialPath(env), 'utf8'));
    return value !== null && typeof value === 'object' && typeof value.token === 'string' ? value : null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    // ⚠ AN UNREADABLE FILE IS NOT "NO CREDENTIAL". Silently prompting again would
    // mint a second device for a machine that already has one, and the user
    // would never learn their file is corrupt. Say so and let them fix it.
    throw new Error(`could not read ${credentialPath(env)}: ${error?.message || error}`);
  }
}

/** Write atomically: a crash mid-write must not leave a truncated credential. */
export async function saveCredential(value, env = process.env, io = {}) {
  const write = io.writeFile ?? writeFile;
  const renameFile = io.rename ?? rename;
  const file = credentialPath(env);
  const temporary = `${file}.${process.pid}.tmp`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await write(temporary, `${JSON.stringify(value, null, 1)}\n`, { mode: 0o600 });
  await renameFile(temporary, file);
}

function readlineAsk() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return async (question) => (await rl.question(question)).trim();
}

function parseArgs(argv) {
  const args = { bridge: '', mcp: '', tenant: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    // ⚠ `--email` IS STILL ACCEPTED AND STILL IGNORED. An operator's stored
    // command line predates the credential and carries it; failing on an unknown
    // flag would break a working setup for a value the device token now supplies.
    if (flag === '--email') { index += 1; }
    else if (flag === '--bridge') { args.bridge = value ?? ''; index += 1; }
    else if (flag === '--mcp') { args.mcp = value ?? ''; index += 1; }
    else if (flag === '--tenant') { args.tenant = value ?? ''; index += 1; }
    else if (flag === '--help' || flag === '-h') args.help = true;
  }
  return args;
}

const SERVER_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** `{mcpServers:{...}}` -> the array `connectServers` takes, with names checked. */
export function serverSpecs(file) {
  return specList(JSON.parse(readFileSync(file, 'utf8'))?.mcpServers, 'config');
}

/** The same conversion for a config object already in hand. */
export function specsFromConfig(config) {
  return specList(config?.mcpServers, 'config');
}

function specList(servers, source) {
  if (!servers || typeof servers !== 'object') throw new Error(`${source} must contain an "mcpServers" object`);
  return Object.entries(servers).map(([name, spec]) => {
    if (!SERVER_NAME.test(name)) throw new Error(`server name "${name}" must match [a-z][a-z0-9-]{0,31}`);
    if (spec?.command) return { name, label: spec.label, transport: 'stdio', command: spec.command, args: spec.args ?? [], env: spec.env ?? {} };
    if (spec?.url) return { name, label: spec.label, transport: 'http', url: spec.url, headers: spec.headers ?? {} };
    throw new Error(`server "${name}" needs either "command" (stdio) or "url" (HTTP)`);
  });
}

/**
 * Split a typed command line into `{command, args}`, honouring double and single
 * quotes so a path or an argument with a space survives.
 *
 * ⚠ NOT run through a shell. The user is typing a command for their own machine,
 * but this parser is why the same line behaves identically on Windows and on
 * macOS, and why nothing here can expand `$HOME` or a glob into something the
 * user did not see.
 */
export function splitCommand(line) {
  const out = [];
  let current = '';
  let quote = '';
  let started = false;
  for (const char of String(line ?? '')) {
    if (quote) {
      if (char === quote) quote = '';
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { out.push(current); current = ''; started = false; }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote) throw new Error('unbalanced quote in the command');
  if (started) out.push(current);
  if (!out.length) throw new Error('empty command');
  return { command: out[0], args: out.slice(1) };
}

/** One typed line -> one server spec. `url` or `command`, decided by the line. */
export function parseServerLine(name, line) {
  if (!SERVER_NAME.test(name)) throw new Error(`name "${name}" must match [a-z][a-z0-9-]{0,31}`);
  const trimmed = String(line ?? '').trim();
  if (!trimmed) throw new Error('a server needs a command line or a URL');
  if (/^https?:\/\//.test(trimmed)) return { name, transport: 'http', url: trimmed, headers: {} };
  const { command, args } = splitCommand(trimmed);
  return { name, transport: 'stdio', command, args, env: {} };
}

/**
 * Ask for servers one at a time until the user submits an empty name.
 *
 * `ask` is injected so this is testable without a terminal: it is called with a
 * question and must return the typed line.
 */
export async function promptServers(ask, log = console.log) {
  const servers = {};
  log('Add the MCP servers you want to share. Press Enter on an empty name when done.');
  for (;;) {
    const name = (await ask('server name (e.g. fs): ')).trim();
    if (!name) break;
    let line;
    for (;;) {
      line = await ask(`  ${name} command or URL (e.g. npx -y @modelcontextprotocol/server-filesystem ~/docs): `);
      try {
        servers[name] = parseServerLine(name, line);
        break;
      } catch (error) {
        log(`  ${error.message}`);
      }
    }
    log(`  added ${name}`);
  }
  if (!Object.keys(servers).length) throw new Error('no MCP server was entered');
  return specsFromConfig({ mcpServers: servers });
}

export async function main(argv = process.argv.slice(2), env = process.env, io = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log('usage: dsh-dragonbyte-host [--bridge <wss url>] [--mcp <mcp.json>]');
    console.log('The first run opens a browser to pair this machine; nothing has to be copied.');
    console.log('The credential is saved in ~/.config/dsh-dragonbyte and renewed by itself.');
    return 0;
  }
  const bridge = args.bridge || env.DSH_DRAGONBYTE_BRIDGE || 'wss://edge01.snapai.app/dragonbyte/ws';
  if (!/^wss?:\/\//.test(bridge)) throw new Error('--bridge must be a ws:// or wss:// URL');

  // ⚠ CREATED ON FIRST USE, NOT HERE. An open readline holds the event loop, so
  // a run that never prompts — `--help` above all, but now also a first run that
  // pairs in a browser and then fails to connect — would print its line and then
  // never exit. Measured: `--help` with a silent pipe on stdin hung until the
  // interface moved behind a lazy accessor.
  let pendingAsk = null;
  const ask = (question) => {
    pendingAsk ??= io.ask ?? readlineAsk();
    return pendingAsk(question);
  };

  // ⚠ THE SAVED CREDENTIAL IS THE DEFAULT, AND THE INTERACTIVE PATH EXISTS ONLY
  // FOR THE FIRST RUN. A machine that has connected once should never prompt
  // again — that is the whole meaning of "authorize once". The file is read
  // before any server is spawned, so a missing credential fails in a second
  // rather than after connecting MCP servers it cannot publish.
  const saved = await loadCredential(env, io);
  let credential = saved;
  let mcpServers = args.mcp ? null : (saved?.mcpServers ?? null);
  if (!credential?.token) {
    // ⚠ THE FIRST RUN PAIRS THROUGH A BROWSER, NOT THROUGH A PASTE. A device
    // token used to have to be minted in the tenant's Settings and carried over
    // by hand; the bridge already serves a page that does the same proof, and
    // DSH Desktop has used it since it shipped. Asking for a paste here made the
    // terminal the only place a person could not pair the same way.
    const pasted = env.DSH_DRAGONBYTE_TOKEN || '';
    if (pasted) {
      credential = { token: pasted.trim(), refreshToken: '', expiresAt: 0, tenantId: args.tenant || env.DSH_DRAGONBYTE_TENANT || '' };
      mcpServers = null;
    } else {
      const issued = await pairWithBrowser({
        bridgeUrl: bridge, tenantId: args.tenant || env.DSH_DRAGONBYTE_TENANT || '', env, log: (line) => console.log(line),
      });
      credential = { ...issued, mcpServers: [] };
      // ⚠ SAVED BEFORE THE FIRST CONNECT, NOT AFTER IT. A machine that paired
      // and then failed to reach the bridge would otherwise pair again on its
      // next run, minting a second device record for the same laptop.
      await saveCredential(credential, env, io);
      mcpServers = null;
    }
  }

  // ⚠ THE NODE CHECK COMES BEFORE THE SOCKET, because `WebSocket` only exists
  // globally from 22 and the fetch below would otherwise fail as a network error.
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 5)) throw new Error(`Node >= 22.5 is required (found ${process.versions.node})`);
  const connect = (url, { headers }) => new WebSocket(url, { headers });

  // ⚠ SETTINGS IS THE SOURCE OF TRUTH, AND IT LIVES ON THE GATEWAY. The host
  // holds a device token, not the browser's session cookie, so it asks the
  // bridge — which reads the document the gateway wrote — rather than the
  // browser route. `--mcp` and the saved credential remain fallbacks, so an old
  // bridge that does not answer `config` still starts a working host.
  if (!args.mcp && !mcpServers?.length && credential.refreshToken !== undefined) {
    const fetched = await fetchServers({ url: bridge, token: credential.token, connect });
    if (fetched?.length) {
      mcpServers = fetched;
      console.log(`dsh-dragonbyte-host: using the ${fetched.length} server(s) saved in Settings`);
    }
  }

  const specs = mcpServers?.length
    ? specsFromConfig({ mcpServers: Object.fromEntries(mcpServers.map((entry) => [entry.name, entry])) })
    : args.mcp ? serverSpecs(args.mcp) : await promptServers(ask);
  const { catalog, call, close } = await connectServers(specs, { log: (line) => console.log(line) });
  if (!catalog.servers.length) {
    await close();
    throw new Error('no configured MCP server connected; nothing to publish');
  }

  const session = serveBridge({
    url: bridge,
    token: credential.token,
    refreshToken: credential.refreshToken ?? '',
    expiresAt: credential.expiresAt ?? 0,
    tenantId: credential.tenantId || args.tenant || '',
    catalog,
    call,
    connect,
    log: (line) => console.log(line),
    // ⚠ THIS PROCESS HAS NOTHING ELSE HOLDING IT OPEN. Every timer the bridge
    // owns is unref'd for a Host's sake; a CLI has no Host, so a reconnect
    // window would let the whole process fall out of the event loop and exit 0
    // without a word. Measured: a refused handshake logged the retry and the
    // process was gone before it fired.
    keepAlive: true,
  });
  // The refreshed token replaces only the credential; the tenant and the refresh
  // token stay as they were, so a renewal never loses the binding.
  session.onRefresh(({ token, expiresAt }) => {
    void saveCredential({ ...credential, token, expiresAt }, env, io);
  });

  const shutdown = async () => { session.close(); await close(); process.exit(0); };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, shutdown);
  // The caller owns the lifetime: `main` resolves once the bridge is serving, so
  // a test can drive it without a process that never exits.
  return session;
}

// ⚠ BOTH SIDES ARE RESOLVED, AND `import.meta.url` IS ALREADY ONE. Node
// realpaths the module it loads, so `import.meta.url` is the real file while
// `process.argv[1]` is whatever the caller typed — a relative path, or the
// `node_modules/.bin` symlink that an installed `bin` always is. Comparing the
// two raw is therefore false for every installed run, and the entrypoint
// silently does nothing: `--help` printed no usage and exited 0. Resolving the
// argv side to its real path is what makes an install behave like a direct run.
const entry = process.argv[1] ? realpathSync(process.argv[1]) : '';
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().then(() => { /* stays alive on the socket */ }).catch((error) => { console.error(`dsh-dragonbyte-host: ${error?.message || error}`); process.exit(1); });
}
