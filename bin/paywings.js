#!/usr/bin/env -S node --no-warnings
// Checked before importing anything else: older Node versions fail on node:sqlite
// with an error that does not say what to do.
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  console.error(`paywings requires Node 22.18 or newer (found ${process.versions.node}). Install a current LTS from https://nodejs.org.`);
  process.exit(1);
}
await import('../dist/cli.js');
