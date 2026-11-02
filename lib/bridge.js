// stdio ⇄ Streamable HTTP bridge for the MCP server built into Dynobase.
//
// MCP clients that only launch stdio servers (Claude Desktop, Codex,
// Windsurf...) start this process. It reads newline-delimited JSON-RPC
// messages from stdin, POSTs each one to Dynobase's local endpoint with the
// bearer token, and writes every JSON-RPC message in the answer to stdout,
// one per line. Logs go to stderr. Only Node built-ins are used.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export const DEFAULT_PORT = 41961;
export const SETTINGS_KEY = "mcpServer";
export const SETTINGS_HINT = "Dynobase → Settings → AI → MCP server";

export const VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8")
).version;

export class UsageError extends Error {}

export const parseArgs = (argv) => {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const equals = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (name === "--url" || name === "--token") {
      const value = inline ?? argv[(index += 1)];
      if (!value) throw new UsageError(`${name} needs a value`);
      flags[name.slice(2)] = value;
    } else if (name === "--check") {
      flags.check = true;
    } else if (name === "-h" || name === "--help") {
      flags.help = true;
    } else if (name === "-v" || name === "--version") {
      flags.version = true;
    } else if (/^https?:\/\//i.test(arg) && !flags.url) {
      flags.url = arg;
    } else {
      throw new UsageError(`unknown argument ${arg}`);
    }
  }
  return flags;
};

export const settingsDir = (env = process.env) =>
  env.DYNOBASE_DATA_DIR || join(homedir(), ".dynobase");

/**
 * Reads the MCP server settings Dynobase saved in its data directory. The app
 * stores them with node-persist: one JSON file per key, named by a hash of
 * the key (SHA-256 in current versions, MD5 in older ones).
 */
export const readAppSettings = (dir) => {
  for (const algorithm of ["sha256", "md5"]) {
    const name = createHash(algorithm).update(SETTINGS_KEY).digest("hex");
    try {
      const value = JSON.parse(readFileSync(join(dir, name), "utf8"))?.value;
      if (value && typeof value === "object") return value;
    } catch {
      // Missing or unreadable: try the older name.
    }
  }
  return undefined;
};

const isPort = (value) =>
  Number.isInteger(value) && value >= 1 && value <= 65535;

/**
 * Flags win over environment variables, which win over Dynobase's settings.
 * `tokenSource` names where the token came from, for error messages.
 */
export const resolveOptions = (
  argv = [],
  env = process.env,
  readSettings = readAppSettings
) => {
  const flags = parseArgs(argv);
  let url = flags.url || env.DYNOBASE_MCP_URL || "";
  let token = flags.token || env.DYNOBASE_MCP_TOKEN || "";
  let tokenSource = flags.token
    ? "--token"
    : env.DYNOBASE_MCP_TOKEN
      ? "DYNOBASE_MCP_TOKEN"
      : "";
  const settings = url && token ? undefined : readSettings(settingsDir(env));
  if (!url) {
    const port = isPort(settings?.port) ? settings.port : DEFAULT_PORT;
    url = `http://127.0.0.1:${port}/mcp`;
  }
  try {
    new URL(url);
  } catch {
    throw new UsageError(`not a valid URL: ${url}`);
  }
  if (!token && typeof settings?.token === "string" && settings.token) {
    token = settings.token;
    tokenSource = "settings";
  }
  return { ...flags, url, token, tokenSource, appEnabled: settings?.enabled };
};

/** Extracts the data payloads of a text/event-stream body. */
export const parseSse = (body) =>
  body
    .split(/\r?\n\r?\n/)
    .map((event) =>
      event
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
    )
    .filter((data) => data.trim());

export const post = (url, headers, body) =>
  new Promise((resolve, reject) => {
    const target = new URL(url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(
      target,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          })
        );
        response.on("error", reject);
      }
    );
    request.on("error", reject);
    request.end(body);
  });

export const errorMessage = (id, code, message) =>
  JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

const isRequest = (message) =>
  Boolean(message) &&
  typeof message === "object" &&
  typeof message.method === "string" &&
  message.id !== undefined &&
  message.id !== null;

const isJsonRpc = (value) =>
  Boolean(value) && typeof value === "object" && value.jsonrpc === "2.0";

export const createBridge = ({
  url,
  token = "",
  tokenSource = "",
  appEnabled,
  write,
  log = () => {},
  send = post,
}) => {
  let sessionId;
  let protocolVersion;

  // Requests get a JSON-RPC error; notifications can only be logged.
  const fail = (ids, text) => {
    if (ids.length === 0) {
      log(text);
      return;
    }
    for (const id of ids) write(errorMessage(id, -32000, text));
  };

  const unreachable = (error) => {
    if (appEnabled === false) {
      return `The MCP server is turned off in Dynobase. Turn it on in ${SETTINGS_HINT}, then try again.`;
    }
    const reason =
      error.code === "ECONNREFUSED" ? "nothing is listening there" : error.message;
    return `Can't reach Dynobase at ${url} (${reason}). Open Dynobase and check that ${SETTINGS_HINT} is turned on and uses this port.`;
  };

  const unauthorized = () => {
    if (!token) {
      return `Dynobase needs a token. Copy it from ${SETTINGS_HINT} and pass it with --token or DYNOBASE_MCP_TOKEN.`;
    }
    if (tokenSource === "settings") {
      return `Dynobase rejected the token saved in its settings. Copy the current token from ${SETTINGS_HINT} and pass it with --token or DYNOBASE_MCP_TOKEN.`;
    }
    return `Dynobase rejected the token from ${tokenSource || "the configuration"}. Copy the current token from ${SETTINGS_HINT}.`;
  };

  const handleLine = async (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(errorMessage(null, -32700, "Parse error: a line on stdin is not valid JSON."));
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    const ids = messages.filter(isRequest).map((item) => item.id);
    const initializeId = messages.find(
      (item) => isRequest(item) && item.method === "initialize"
    )?.id;

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "User-Agent": `dynobase-mcp/${VERSION}`,
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (sessionId) headers["Mcp-Session-Id"] = sessionId;
    if (protocolVersion && initializeId === undefined) {
      headers["MCP-Protocol-Version"] = protocolVersion;
    }

    let response;
    try {
      response = await send(url, headers, line);
    } catch (error) {
      fail(ids, unreachable(error));
      return;
    }

    const newSessionId = response.headers["mcp-session-id"];
    if (typeof newSessionId === "string" && newSessionId) sessionId = newSessionId;

    if (response.status === 401) {
      fail(ids, unauthorized());
      return;
    }
    if (!response.body.trim()) {
      if (response.status >= 400) fail(ids, `Dynobase answered HTTP ${response.status}.`);
      return;
    }

    let payloads;
    try {
      const contentType = String(response.headers["content-type"] || "");
      payloads = contentType.includes("text/event-stream")
        ? parseSse(response.body).map((data) => JSON.parse(data))
        : [JSON.parse(response.body)];
    } catch {
      fail(ids, `Dynobase answered HTTP ${response.status} with a body that isn't JSON.`);
      return;
    }
    payloads = payloads.flat();

    // Errors outside MCP, such as {"error": "..."} for a wrong path.
    const foreign = payloads.find((payload) => !isJsonRpc(payload));
    if (foreign !== undefined) {
      const detail =
        typeof foreign?.error === "string" ? foreign.error : JSON.stringify(foreign);
      fail(ids, `Dynobase answered HTTP ${response.status}: ${detail}`);
      return;
    }

    for (const payload of payloads) {
      // Transport errors carry id null; give them to the one request we sent.
      if (payload.id === null && payload.error && ids.length === 1) {
        payload.id = ids[0];
      }
      if (
        initializeId !== undefined &&
        payload.id === initializeId &&
        typeof payload.result?.protocolVersion === "string"
      ) {
        protocolVersion = payload.result.protocolVersion;
      }
      write(JSON.stringify(payload));
    }
  };

  return { handleLine };
};

const describeTokenSource = (source) =>
  ({
    "--token": "token from --token",
    DYNOBASE_MCP_TOKEN: "token from DYNOBASE_MCP_TOKEN",
    settings: "token from Dynobase's settings",
  })[source] || "no token";

/** Connects once and reports what the server says. Returns an exit code. */
export const check = async (options, out = (text) => process.stdout.write(text)) => {
  const answers = new Map();
  const bridge = createBridge({
    ...options,
    write: (line) => {
      const message = JSON.parse(line);
      answers.set(message.id, message);
    },
    log: (text) => out(`${text}\n`),
  });
  await bridge.handleLine(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "dynobase-mcp --check", version: VERSION },
      },
    })
  );
  const initialized = answers.get(1);
  if (!initialized || initialized.error) {
    out(`Not connected: ${initialized?.error?.message ?? "no answer"}\n`);
    return 1;
  }
  await bridge.handleLine(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })
  );
  await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
  const listed = answers.get(2);
  if (!listed || listed.error) {
    out(`Connected, but listing tools failed: ${listed?.error?.message ?? "no answer"}\n`);
    return 1;
  }
  const server = initialized.result?.serverInfo ?? {};
  const tools = (listed.result?.tools ?? []).map((tool) => tool.name);
  out(
    `Connected to ${[server.name, server.version].filter(Boolean).join(" ") || "the server"} ` +
      `at ${options.url} (${describeTokenSource(options.tokenSource)}).\n` +
      `Protocol ${initialized.result?.protocolVersion ?? "unknown"}. ` +
      `${tools.length} tools: ${tools.join(", ")}\n`
  );
  return 0;
};

export const HELP = `dynobase-mcp ${VERSION}: stdio bridge to the MCP server built into Dynobase

Usage: dynobase-mcp [--url <url>] [--token <token>]
       dynobase-mcp --check

  --url <url>      MCP endpoint. Default: http://127.0.0.1:<port>/mcp with the
                   port saved in Dynobase's settings (41961 unless changed).
                   Environment: DYNOBASE_MCP_URL
  --token <token>  Bearer token. Default: the token saved in Dynobase's
                   settings (~/.dynobase). Environment: DYNOBASE_MCP_TOKEN
  --check          Connect once, print what the server reports, and exit
  -h, --help       Show this help
  -v, --version    Show the version

Turn the server on in ${SETTINGS_HINT}.
Docs: https://dynobase.dev/dynamodb-mcp-server/
`;

export const main = async (argv = process.argv.slice(2), env = process.env) => {
  const log = (text) => process.stderr.write(`dynobase-mcp: ${text}\n`);
  let options;
  try {
    options = resolveOptions(argv, env);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    log(`${error.message}. Run dynobase-mcp --help for usage.`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (options.check) {
    process.exitCode = await check(options);
    return;
  }
  if (!options.token) {
    log(
      `no token: pass --token, set DYNOBASE_MCP_TOKEN, or open Dynobase once so it saves one (${SETTINGS_HINT}).`
    );
  }

  process.stdout.on("error", (error) => {
    if (error.code === "EPIPE") process.exit(0);
    throw error;
  });
  const write = (line) => process.stdout.write(`${line}\n`);
  const bridge = createBridge({ ...options, write, log });
  const pending = new Set();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const task = bridge
      .handleLine(trimmed)
      .catch((error) => log(error?.stack || String(error)))
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  lines.on("close", () => {
    // Let answers in flight reach stdout, then exit; give up after 10 s.
    setTimeout(() => process.exit(0), 10_000).unref();
    Promise.allSettled([...pending]).then(() =>
      process.stdout.write("", () => process.exit(0))
    );
  });
};
