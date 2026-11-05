#!/usr/bin/env node
// node:sqlite is still experimental on Node 22. Hide only that warning; shebang flags
// such as --no-warnings are ignored by npm's Windows shims, so filter it here instead.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && String(warning).includes('SQLite')) return;
  return emitWarning.call(process, warning, ...rest);
};

await import('../dist/cli.js');
