import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBridge, parseArgs, parseSse, resolveOptions } from "../lib/bridge.js";

const TOKEN = "test-token-0123456789abcdefghijklmnop";
const BIN = fileURLToPath(new URL("../bin/dynobase-mcp.js", import.meta.url));
const folders = [];

// Stands in for Dynobase's endpoint: loopback Host check, bearer token, JSON
// answers to requests, 202 for notifications. Method "fail" gets a transport
// error with id null, like the app's 500 handler.
const startFakeDynobase = async ({ sse = false } = {}) => {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ headers: req.headers, body });
      const json = (status, payload) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || "")) {
        return json(403, { error: "Only loopback Host headers are accepted" });
      }
      if (req.headers.authorization !== `Bearer ${TOKEN}`) {
        return json(401, { error: "Unauthorized" });
      }
      if (req.url !== "/mcp") {
        return json(404, { error: "Not found. The MCP endpoint is /mcp" });
      }
      const message = JSON.parse(body);
      if (message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      if (message.method === "fail") {
        return json(500, {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal server error" },
        });
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "dynobase", version: "3.0.8" },
            }
          : message.method === "tools/list"
            ? {
                tools: [
                  { name: "list_profiles", inputSchema: { type: "object" } },
                  { name: "scan", inputSchema: { type: "object" } },
                ],
              }
            : {};
      const answer = { jsonrpc: "2.0", id: message.id, result };
      if (sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(`event: message\r\ndata: ${JSON.stringify(answer)}\r\n\r\n`);
        return;
      }
      json(200, answer);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
};

const closedPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
};

// A Dynobase data directory holding only the MCP settings file.
const settingsFolder = (value, algorithm = "sha256") => {
  const dir = mkdtempSync(join(tmpdir(), "dynobase-mcp-test-"));
  folders.push(dir);
  const name = createHash(algorithm).update("mcpServer").digest("hex");
  writeFileSync(join(dir, name), JSON.stringify({ key: "mcpServer", value }));
  return dir;
};

const collect = () => {
  const lines = [];
  return { lines, write: (line) => lines.push(JSON.parse(line)) };
};

const request = (id, method, params = {}) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, params });

const run = (args, env, input = "") =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      env: { ...process.env, DYNOBASE_MCP_URL: "", DYNOBASE_MCP_TOKEN: "", ...env },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });

after(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
});

describe("options", () => {
  test("reads the port and token Dynobase saved", () => {
    const dir = settingsFolder({ enabled: true, port: 50123, allowWrites: false, token: TOKEN });
    const options = resolveOptions([], { DYNOBASE_DATA_DIR: dir });
    assert.equal(options.url, "http://127.0.0.1:50123/mcp");
    assert.equal(options.token, TOKEN);
    assert.equal(options.tokenSource, "settings");
    assert.equal(options.appEnabled, true);
  });

  test("falls back to the older MD5 file name", () => {
    const dir = settingsFolder({ enabled: false, port: 50124, token: TOKEN }, "md5");
    const options = resolveOptions([], { DYNOBASE_DATA_DIR: dir });
    assert.equal(options.url, "http://127.0.0.1:50124/mcp");
    assert.equal(options.token, TOKEN);
    assert.equal(options.appEnabled, false);
  });

  test("flags beat environment variables, which beat the settings", () => {
    const dir = settingsFolder({ enabled: true, port: 50125, token: TOKEN });
    const env = {
      DYNOBASE_DATA_DIR: dir,
      DYNOBASE_MCP_URL: "http://127.0.0.1:1234/mcp",
      DYNOBASE_MCP_TOKEN: "env-token",
    };
    const fromEnv = resolveOptions([], env);
    assert.equal(fromEnv.url, "http://127.0.0.1:1234/mcp");
    assert.equal(fromEnv.token, "env-token");
    assert.equal(fromEnv.tokenSource, "DYNOBASE_MCP_TOKEN");
    const fromFlags = resolveOptions(["--url", "http://localhost:9/mcp", "--token=flag-token"], env);
    assert.equal(fromFlags.url, "http://localhost:9/mcp");
    assert.equal(fromFlags.token, "flag-token");
    assert.equal(fromFlags.tokenSource, "--token");
  });

  test("uses the default port when there are no settings", () => {
    const dir = mkdtempSync(join(tmpdir(), "dynobase-mcp-test-"));
    folders.push(dir);
    const options = resolveOptions([], { DYNOBASE_DATA_DIR: dir });
    assert.equal(options.url, "http://127.0.0.1:41961/mcp");
    assert.equal(options.token, "");
    assert.equal(options.appEnabled, undefined);
  });

  test("accepts a URL as a positional argument and rejects unknown ones", () => {
    assert.deepEqual(parseArgs(["http://127.0.0.1:5/mcp"]), { url: "http://127.0.0.1:5/mcp" });
    assert.throws(() => parseArgs(["--nope"]), /unknown argument --nope/);
    assert.throws(() => parseArgs(["--token"]), /--token needs a value/);
  });
});

describe("bridge", () => {
  let fake;
  before(async () => {
    fake = await startFakeDynobase();
  });
  after(() => fake.close());

  test("forwards requests and sends the negotiated protocol version afterwards", async () => {
    fake.requests.length = 0;
    const out = collect();
    const bridge = createBridge({ url: fake.url, token: TOKEN, write: out.write });
    await bridge.handleLine(request(1, "initialize", { protocolVersion: "2025-06-18" }));
    await bridge.handleLine(request(2, "tools/list"));
    assert.equal(out.lines[0].id, 1);
    assert.equal(out.lines[0].result.serverInfo.name, "dynobase");
    assert.deepEqual(out.lines[1].result.tools.map((tool) => tool.name), ["list_profiles", "scan"]);
    assert.equal(fake.requests[0].headers.authorization, `Bearer ${TOKEN}`);
    assert.equal(fake.requests[0].headers["mcp-protocol-version"], undefined);
    assert.equal(fake.requests[1].headers["mcp-protocol-version"], "2025-06-18");
  });

  test("writes nothing for notifications", async () => {
    const out = collect();
    const bridge = createBridge({ url: fake.url, token: TOKEN, write: out.write });
    await bridge.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    assert.deepEqual(out.lines, []);
  });

  test("turns a 401 into an error that says where to get the token", async () => {
    const out = collect();
    const bridge = createBridge({
      url: fake.url,
      token: "wrong",
      tokenSource: "DYNOBASE_MCP_TOKEN",
      write: out.write,
    });
    await bridge.handleLine(request(7, "tools/list"));
    assert.equal(out.lines[0].id, 7);
    assert.match(out.lines[0].error.message, /rejected the token from DYNOBASE_MCP_TOKEN/);
    assert.match(out.lines[0].error.message, /Settings → AI → MCP server/);
  });

  test("gives a transport error with id null to the request that caused it", async () => {
    const out = collect();
    const bridge = createBridge({ url: fake.url, token: TOKEN, write: out.write });
    await bridge.handleLine(request(9, "fail"));
    assert.equal(out.lines[0].id, 9);
    assert.equal(out.lines[0].error.message, "Internal server error");
  });

  test("reports non-MCP errors such as a wrong path", async () => {
    const out = collect();
    const bridge = createBridge({ url: fake.url.replace("/mcp", "/nope"), token: TOKEN, write: out.write });
    await bridge.handleLine(request(10, "tools/list"));
    assert.equal(out.lines[0].id, 10);
    assert.match(out.lines[0].error.message, /HTTP 404: Not found/);
  });

  test("explains what to do when Dynobase isn't listening", async () => {
    const url = `http://127.0.0.1:${await closedPort()}/mcp`;
    const out = collect();
    await createBridge({ url, token: TOKEN, write: out.write }).handleLine(request(3, "tools/list"));
    assert.equal(out.lines[0].id, 3);
    assert.match(out.lines[0].error.message, /Can't reach Dynobase/);
    assert.match(out.lines[0].error.message, /Settings → AI → MCP server/);

    const off = collect();
    await createBridge({ url, token: TOKEN, appEnabled: false, write: off.write }).handleLine(
      request(4, "tools/list")
    );
    assert.match(off.lines[0].error.message, /turned off in Dynobase/);
  });

  test("answers a line that isn't JSON with a parse error", async () => {
    const out = collect();
    await createBridge({ url: fake.url, token: TOKEN, write: out.write }).handleLine("{nope");
    assert.equal(out.lines[0].id, null);
    assert.equal(out.lines[0].error.code, -32700);
  });

  test("reads event-stream answers", async () => {
    const streaming = await startFakeDynobase({ sse: true });
    try {
      const out = collect();
      await createBridge({ url: streaming.url, token: TOKEN, write: out.write }).handleLine(
        request(5, "tools/list")
      );
      assert.equal(out.lines[0].id, 5);
      assert.equal(out.lines[0].result.tools.length, 2);
    } finally {
      await streaming.close();
    }
  });

  test("parseSse keeps multi-line data and skips other fields", () => {
    const body = 'event: message\nid: 1\ndata: {"a":\ndata: 1}\n\n: comment\n\ndata: {"b":2}\n\n';
    assert.deepEqual(parseSse(body), ['{"a":\n1}', '{"b":2}']);
  });
});

describe("command line", () => {
  let fake;
  before(async () => {
    fake = await startFakeDynobase();
  });
  after(() => fake.close());

  test("bridges stdin to stdout using the settings Dynobase saved", async () => {
    const dir = settingsFolder({ enabled: true, port: fake.port, token: TOKEN });
    const input = [
      request(1, "initialize", { protocolVersion: "2025-06-18" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      request(2, "tools/list"),
    ].join("\n");
    const { code, stdout } = await run([], { DYNOBASE_DATA_DIR: dir }, `${input}\n`);
    assert.equal(code, 0);
    const answers = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .sort((a, b) => a.id - b.id);
    assert.deepEqual(answers.map((answer) => answer.id), [1, 2]);
    assert.equal(answers[1].result.tools.length, 2);
  });

  test("--check reports the server and its tools", async () => {
    const dir = settingsFolder({ enabled: true, port: fake.port, token: TOKEN });
    const { code, stdout } = await run(["--check"], { DYNOBASE_DATA_DIR: dir });
    assert.equal(code, 0);
    assert.match(stdout, /Connected to dynobase 3\.0\.8/);
    assert.match(stdout, /token from Dynobase's settings/);
    assert.match(stdout, /2 tools: list_profiles, scan/);
  });

  test("--check fails clearly when the server is turned off", async () => {
    const dir = settingsFolder({ enabled: false, port: await closedPort(), token: TOKEN });
    const { code, stdout } = await run(["--check"], { DYNOBASE_DATA_DIR: dir });
    assert.equal(code, 1);
    assert.match(stdout, /turned off in Dynobase/);
  });

  test("rejects unknown arguments with exit code 2", async () => {
    const { code, stderr } = await run(["--nope"], {});
    assert.equal(code, 2);
    assert.match(stderr, /unknown argument --nope/);
  });
});
