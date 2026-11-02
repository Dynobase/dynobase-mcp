# dynobase-mcp

<!-- mcp-name: io.github.Dynobase/dynobase-mcp -->

This package connects AI tools that only launch stdio MCP servers, such as Claude Desktop, Codex and Windsurf, to the MCP server built into [Dynobase](https://dynobase.dev/), the desktop client for Amazon DynamoDB.

Dynobase 3.0 and later can run a [Model Context Protocol](https://modelcontextprotocol.io) server on your machine. AI tools can use it to list your tables, read their schemas and query your data through the AWS profiles Dynobase has loaded. It is read-only unless you allow writes. Claude Code and Cursor can connect to it over HTTP directly.

This package bridges every other client to it. It reads MCP messages on stdin, forwards them to Dynobase, and writes the answers to stdout. It has no dependencies.

The bridge is MIT-licensed. Dynobase itself is a paid app with a 7-day free trial.

## Requirements

- Dynobase 3.0 or later, open, with **Settings → AI → MCP server** turned on
- Node.js 18 or later. The Claude Desktop extension doesn't need it, because Claude Desktop includes Node.js on macOS and Windows.

## Setup

Turn on the MCP server in Dynobase, then add the bridge to your client. The bridge reads the port and token from Dynobase's settings, so your client config doesn't need the token.

**Claude Desktop extension**: download the `.mcpb` file from the [latest release](https://github.com/Dynobase/dynobase-mcp/releases/latest) and open it. Claude Desktop shows an install dialog. Leave the token and URL fields empty.

**Claude Desktop (manual config), Windsurf and other clients with an `mcpServers` file**

```json
{
  "mcpServers": {
    "dynobase": {
      "command": "npx",
      "args": ["-y", "github:Dynobase/dynobase-mcp"]
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.dynobase]
command = "npx"
args = ["-y", "github:Dynobase/dynobase-mcp"]
```

**Claude Code** also works with the bridge:

```sh
claude mcp add dynobase -- npx -y github:Dynobase/dynobase-mcp
```

Claude Code and Cursor can also skip the bridge and connect to Dynobase over HTTP. Dynobase's settings section shows the snippets for that.

To test the connection from a terminal:

```sh
npx -y github:Dynobase/dynobase-mcp --check
```

## Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--url <url>` | `DYNOBASE_MCP_URL` | `http://127.0.0.1:<port>/mcp`, using the port saved in Dynobase (41961 unless you changed it) |
| `--token <token>` | `DYNOBASE_MCP_TOKEN` | The token saved in Dynobase's settings |

Flags take precedence over environment variables, and environment variables take precedence over Dynobase's settings.

Dynobase saves its settings in `~/.dynobase`, or in `DYNOBASE_DATA_DIR` if that's set. If the bridge can't read that folder, for example because the client runs as a different user, pass the token explicitly.

## What your AI tool can do

These read tools are always available:

| Tool | What it does |
| --- | --- |
| `list_profiles` | Lists loaded profiles with their regions and table names |
| `list_tables` | Lists the table names of one profile |
| `describe_table` | Returns the full `DescribeTable` output plus TTL |
| `scan` | Returns one page of a Scan |
| `query` | Returns one page of a Query |
| `get_item` | Returns one item by primary key |
| `partiql` | Runs one PartiQL statement, `SELECT` only unless writes are allowed |
| `explain_query` | Says which index a key condition would use, and whether it's a Query or a Scan |

The write tools are `put_item`, `update_item`, `delete_item`, `batch_write` and PartiQL writes. They only work after you turn on **Allow writes** in Dynobase. Dynobase records each write an MCP client makes in the item's History, so you can revert it. PartiQL writes are the exception: they can't be reverted.

Each call returns up to about 1 MB of items and times out after 60 seconds. The tools come from your installed version of Dynobase, not from this package.

## Security

- Dynobase's MCP server listens on 127.0.0.1 only. It rejects requests whose Host header isn't a loopback name.
- Every request needs the bearer token. The bridge reads the token from your own settings folder, sends it only to the configured URL, and never logs it.
- The server is read-only unless you allow writes.
- Your AWS credentials stay in Dynobase. Clients only see tool results.

## Troubleshooting

`npx -y github:Dynobase/dynobase-mcp --check` reports what it finds. The bridge writes its logs to stderr, which most clients show in their MCP logs.

- **"Can't reach Dynobase"**: open Dynobase and check that **Settings → AI → MCP server** is on. If you changed the port, the bridge reads the new one from the settings, unless you set `--url` or `DYNOBASE_MCP_URL`.
- **"The MCP server is turned off in Dynobase"**: turn it on in **Settings → AI → MCP server**.
- **"Dynobase rejected the token"**: the token was regenerated. Update `--token` or `DYNOBASE_MCP_TOKEN`, or remove them so the bridge reads the current token from the settings.

## How it works

Each line on stdin is one JSON-RPC message. The bridge POSTs it to Dynobase's Streamable HTTP endpoint with `Authorization: Bearer <token>`. It then writes each JSON-RPC message in the answer to stdout, one per line. Answers can be JSON or an event stream, and requests run in parallel.

Some errors happen before Dynobase answers, such as a refused connection or a rejected token. The bridge returns those as JSON-RPC errors that say how to fix them.

## License

[MIT](LICENSE). Dynobase is a separate commercial product: https://dynobase.dev
