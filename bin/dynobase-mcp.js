#!/usr/bin/env node
import { main } from "../lib/bridge.js";

main().catch((error) => {
  process.stderr.write(`dynobase-mcp: ${error?.stack || error}\n`);
  process.exit(1);
});
