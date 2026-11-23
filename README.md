# dsh-dragonbyte-client

Share the MCP servers running on **your own machine** with a DSH tenant, without
opening a port, without a public name, and without moving the servers off your
laptop.

Two ways to run it, and they install differently:

| Where | What you get | How it installs |
| --- | --- | --- |
| a DSH Desktop (or any DSH Host) | `Settings -> DragonByte`, with pairing, the bridged servers and status | as a DSH **plugin bundle** |
| a plain machine | a headless host process | `npx -y dsh-dragonbyte-client` |

## In DSH Desktop

Install the bundle through the Plugin Manager, or point it at the npm package:

```
Plugin Manager -> install  dsh-dragonbyte-client
Settings -> DragonByte -> Pair this machine
```

`github:mahainc-internal/dsh-dragonbyte-client` still works as an install
source, but the published npm package is what a release ships.

Pairing opens your browser on `edge01.snapai.app`, where you sign in with the
Google account that owns the DSH tenants. Approve it and the machine comes back
paired. There is nothing to copy and no token to paste.

**Once paired, the pair button is gone and the panel names the machine.** A
second pairing would mint a second device record for a machine that already has
one, so a paired machine offers **Reconnect** and **Disconnect** instead. The
name shown is this machine's OS hostname — the same one the tenant's device list
shows — overridden by `DSH_DRAGONBYTE_LABEL` when two machines have alike
hostnames.

**A paired machine serves every tenant that account owns.** There is no tenant
picker: which tenants an address owns is a registry question the bridge answers
on every publish, so handing the choice to a person would only be a way to
answer it wrongly.

**The MCP server list is typed here.** One line per server, either
`name: command args` or `name: https://host/mcp`; `#` starts a comment. **Save
servers** writes the list to the bridge first — the bridge is what every start
reads it from — and only then to the local credential, which is the copy an
offline start uses. Deleting every line is a real answer: the machine stops
sharing and says so instead of publishing an empty catalog.

The pairing page no longer has an editor. It signs a browser in and hands the
code back to the machine; the list has one home, and this is it.

⚠ **The browser step is not optional, and it cannot happen inside the app.** A
desktop shell serves its UI from an `app://` origin, which Firebase will never
accept as an authorized domain. The pairing page is therefore served by the
bridge on `edge01.snapai.app`; the app only opens it and waits on `127.0.0.1` for
the one-time code that comes back.

## On a plain machine

```sh
npx -y dsh-dragonbyte-client
#    opens a browser; sign in with the Google account that owns the tenants
#    then answer once for each MCP server (or pass --mcp ./mcp.json)
```

**The first run pairs through a browser, exactly as DSH Desktop does.** The
machine registers a handle on the bridge, opens `edge01.snapai.app`, and waits.
Signing in there hands the code back to the waiting machine over the bridge, so
nothing has to be copied. A machine with no browser still works: the URL is
printed, and opening it anywhere finishes the pairing.

The credential is saved in `~/.config/dsh-dragonbyte/credential.json` and the
host renews its own token before it expires.

## What it does

One outbound WebSocket to `edge01.snapai.app/dragonbyte/ws`, then it publishes a
catalog of your MCP tools upward and answers calls on that socket. A DSH tenant
gets one tool per bridged entry, named `mcp__dragonbyte_<server>__<tool>`.

The connection points downward on purpose: your machine has no public name, no
certificate and no inbound port, so giving it one is the whole problem this
avoids.

## Supported MCP servers

| Transport | How to enter it | Notes |
| --- | --- | --- |
| `stdio` | `name: command args` | spawned on this machine, inherits its environment |
| `http` | `name: https://host/path` | Streamable HTTP, optional static headers |

Not supported, and refused rather than half-connected: legacy SSE transport,
OAuth-protected servers, and anything that is not one of the two rows above.

Limits worth knowing before you plan around them:

- **16 servers** per machine; a name must match `[a-z][a-z0-9-]{0,31}`.
- **A tool result over 4 MiB is refused.** Serving large files as base64 through
  this path will not work.
- **A server that fails to connect is skipped**, and the others still serve. If
  none connect, the host publishes nothing rather than binding a tenant to a
  machine that can do nothing.
- **Calls are at-most-once.** A timed-out call is reported as "may have run" and
  is never retried, because a local MCP tool is an arbitrary side effect.

## Where settings live

| What | Where |
| --- | --- |
| the device token and tenant binding | `~/.config/dsh-dragonbyte/credential.json` (0600) |
| the MCP server list | the bridge's paired-device store, typed in `Settings -> DragonByte` and cached in the credential for an offline start |
| revocation | `Settings -> DragonByte -> Disconnect` |

Override the config location with `DSH_DRAGONBYTE_CONFIG_DIR`.

## Run it headless

```sh
# first run: pairs through a browser (or takes DSH_DRAGONBYTE_TOKEN)
dsh-dragonbyte-host

# later runs: everything comes from the credential file
dsh-dragonbyte-host --bridge wss://edge01.snapai.app/dragonbyte/ws
```

| Flag / variable | Meaning |
| --- | --- |
| `--bridge <url>` | bridge WebSocket; defaults to `DSH_DRAGONBYTE_BRIDGE` or the edge01 URL |
| `--mcp <mcp.json>` | a standard `{ "mcpServers": { … } }` file instead of the saved list |
| `--tenant <id>` | required only when this address owns more than one tenant |
| `DSH_DRAGONBYTE_TOKEN` | skips the browser and uses a device token you already hold |
| `DSH_DRAGONBYTE_CONFIG_DIR` | where `credential.json` lives |

`--help` exits without prompting, and a run with a saved credential never asks
for input — which is what lets it run under a supervisor or a login item.

## Revoking a machine

`Settings -> DragonByte -> Disconnect`. The bridge re-reads its revocation list on
its 15-second sweep and closes an already-open socket, so the tenant's tools go
away within about half a minute rather than when the machine happens to
reconnect.

## Requirements

Node.js **>= 22.5** (the global `WebSocket`, and `@modelcontextprotocol/client`).
The DSH Host provides its own runtime, so an installed bundle needs nothing on
the machine's `PATH`.

## Develop

```sh
npm ci
npm test
```

The tests cover the socket protocol, the credential file, the settings exchange,
the `/dragonbyte/status` route the panel reads (including the machine name it
renders), the no-prompt exit path, and how the pairing page URL is built. The pairing
endpoint, the Firebase token check and the device store live in the tenant-side
[`dsh-dragonbyte`](../dsh-dragonbyte) package, because they run on edge01.

## License

MIT
