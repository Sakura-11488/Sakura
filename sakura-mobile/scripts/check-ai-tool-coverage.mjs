#!/usr/bin/env node
/**
 * Every tool the server offers must be one some client can actually run.
 *
 * The catalogue lives on the server (supabase/functions/sakura-ai-chat/tools.ts)
 * and dispatch lives in the client (lib/sakura-ai.ts). Nothing links them, so
 * adding a tool to one and forgetting the other is a single-line mistake with a
 * user-visible result: the model calls the tool, dispatch falls through to
 * `default`, and "Unknown tool: series_facts" lands in the transcript looking
 * exactly like the AI is broken.
 *
 * That is precisely what happened when series_facts / my_progress / open_in_app
 * were added to the catalogue during Stage 1. This check exists so the next one
 * fails in CI instead of in front of a user.
 *
 *   node scripts/check-ai-tool-coverage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const toolsSrc = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/sakura-ai-chat/tools.ts'),
  'utf8',
);
const clientSrc = fs.readFileSync(path.join(ROOT, 'lib/sakura-ai.ts'), 'utf8');

// t('group', 'executor', 'tool_name', ...)
const declared = [...toolsSrc.matchAll(/\bt\(\s*'([a-z]+)'\s*,\s*'(server|client)'\s*,\s*'([a-z_]+)'/g)].map(
  (m) => ({ group: m[1], executor: m[2], name: m[3] }),
);

if (declared.length === 0) {
  console.error('FAIL: parsed zero tools from tools.ts — the declaration shape must have changed.');
  process.exit(1);
}

const dispatched = new Set(
  [...clientSrc.matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1]),
);

const clientTools = declared.filter((t) => t.executor === 'client');
const serverTools = declared.filter((t) => t.executor === 'server');

let failures = 0;

const missing = clientTools.filter((t) => !dispatched.has(t.name));
if (missing.length) {
  failures++;
  console.error('FAIL: client-executed tools with no dispatcher case in lib/sakura-ai.ts:');
  for (const t of missing) console.error(`  - ${t.name}  (group: ${t.group})`);
  console.error('  The model will call these and the user will see "Unknown tool: <name>".');
} else {
  console.log(`PASS  all ${clientTools.length} client tools have a dispatcher case`);
}

// A server tool reaching client dispatch would mean the executor tag is wrong.
const leaked = serverTools.filter((t) => dispatched.has(t.name));
if (leaked.length) {
  failures++;
  console.error('FAIL: server-executed tools also have a client dispatcher case:');
  for (const t of leaked) console.error(`  - ${t.name}`);
  console.error('  These run inside the edge function and never reach the client.');
} else {
  console.log(`PASS  none of the ${serverTools.length} server tools are dispatched client-side`);
}

// Capability lists must agree, or a surface can request a group that yields nothing.
const groupsInCatalogue = new Set(declared.map((t) => t.group));
const requestableMatch = toolsSrc.match(/REQUESTABLE_GROUPS:\s*ToolGroup\[\]\s*=\s*\[([^\]]*)\]/);
const requestable = new Set(
  (requestableMatch?.[1] ?? '').match(/'([a-z]+)'/g)?.map((s) => s.slice(1, -1)) ?? [],
);
const capMatch = clientSrc.match(/export type AiCapability\s*=\s*([^;]+);/);
const capabilities = new Set(
  (capMatch?.[1] ?? '').match(/'([a-z]+)'/g)?.map((s) => s.slice(1, -1)) ?? [],
);

const requestableNotOffered = [...requestable].filter((g) => !groupsInCatalogue.has(g));
const capabilityMismatch = [...requestable].filter((g) => !capabilities.has(g));

if (requestableNotOffered.length) {
  failures++;
  console.error(`FAIL: REQUESTABLE_GROUPS lists groups no tool belongs to: ${requestableNotOffered.join(', ')}`);
} else {
  console.log('PASS  every requestable group has at least one tool');
}

if (capabilityMismatch.length) {
  failures++;
  console.error(`FAIL: server offers groups the client's AiCapability type cannot name: ${capabilityMismatch.join(', ')}`);
} else {
  console.log('PASS  AiCapability covers every requestable group');
}

console.log(`\n${failures === 0 ? 'Tool coverage OK.' : `${failures} problem(s).`}`);
process.exit(failures === 0 ? 0 : 1);
