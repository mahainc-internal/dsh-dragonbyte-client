# dsh-dragonbyte-client

Share the MCP servers running on **your own machine** with a DSH tenant, without
opening a port, without a public name, and without moving the servers off your
laptop.

```sh
# 1. in DSH: Settings -> Local MCP, enter your servers, Create token
# 2. here, once:
npx -y github:mahainc-internal/dsh-dragonbyte-client
#    paste the token; answer once for each MCP server
```

After that the credential is saved in `~/.config/dsh-dragonbyte/credential.json`
and the host renews its own token before it expires. Nothing else to run.

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

- **16 servers** per machine, **32 tools' worth of catalog**; a name must match
  `[a-z][a-z0-9-]{0,31}`.
- **A tool result over 4 MiB is refused.** Serving large files as base64 through
  this path will not work.
- **A server that fails to connect is skipped**, and the others still serve. If
  none connect, the host exits rather than binding a tenant to nothing.
- **Calls are at-most-once.** A timed-out call is reported as "may have run" and
  is never retried, because a local MCP tool is an arbitrary side effect.

## Where settings live

| What | Where |
| --- | --- |
| MCP servers, tenant binding, revocation | the DSH gateway, written from `Settings -> Local MCP` |
| `token`, `refreshToken`, `expiresAt`, `tenantId` | `~/.config/dsh-dragonbyte/credential.json` (0600) |

The server list is fetched from the gateway each time the host starts, so
editing it in Settings takes effect on the next start — there is nothing to edit
on this machine. Note that a server's `env` and `headers` are stored on the
gateway, not just here; do not put a secret in one you would not want stored
server-side.

Override the config location with `DSH_DRAGONBYTE_CONFIG_DIR`.

## Run it

```sh
# first run: reads the token from the prompt (or DSH_DRAGONBYTE_TOKEN)
dsh-dragonbyte-host

# later runs: everything comes from the credential file
dsh-dragonbyte-host --bridge wss://edge01.snapai.app/dragonbyte/ws
```

| Flag / variable | Meaning |
| --- | --- |
| `--bridge <url>` | bridge WebSocket; defaults to `DSH_DRAGONBYTE_BRIDGE` or the edge01 URL |
| `--mcp <mcp.json>` | a standard `{ "mcpServers": { … } }` file instead of the saved list |
| `--tenant <id>` | required only when this address owns more than one tenant |
| `DSH_DRAGONBYTE_TOKEN` | the device token, for a first run without a prompt |
| `DSH_DRAGONBYTE_CONFIG_DIR` | where `credential.json` lives |

`--help` exits without prompting, and a run with a saved credential never asks
for input — which is what lets it run under a supervisor or a login item.

## Revoking a machine

Settings -> Local MCP -> Revoke. The bridge re-reads the revocation list on its
15-second sweep and closes an already-open socket, so the tenant's tools go away
within about half a minute rather than when the machine happens to reconnect.

## Requirements

Node.js **>= 22.5** (the global `WebSocket`, and `@modelcontextprotocol/client`).

## Develop

```sh
npm ci
npm test
```

The tests cover the socket protocol, the credential file, the settings exchange
and the no-prompt exit path. The Settings panel itself lives in the tenant-side
`dsh-dragonbyte` package, not here.

## License

MIT
