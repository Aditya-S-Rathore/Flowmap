#!/usr/bin/env node
const [major] = process.versions.node.split(".").map(Number);
if (major < 24) {
  console.error(`FlowMap needs Node 24+ (found ${process.version}). Try: nvm use 24`);
  process.exit(1);
}
await import("../src/cli.ts");
