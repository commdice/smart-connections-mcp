// Run with: npm test (builds first). Uses only node:test, no extra deps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { validateConfig } from '../dist/security.js';
import { loadSmartConnectionsData } from '../dist/data.js';
import { handleToolCall, toolDefinitions } from '../dist/tools.js';
import { stripFrontmatter, extractSection } from '../dist/format.js';

const DIMS = 384;
let vault;
let ctx;

function vec(seed) {
  return Array.from({ length: DIMS }, (_, i) => Math.sin(i * 0.1 + seed));
}

const NOTE = `---
tags: [paint]
---
# Collision Repair

Intro text.

## Color Matching

Use a spectrophotometer.

\`\`\`
## not a heading
\`\`\`

### Variants

Pearl and tri-coat.

## Clear Coat

Two coats minimum.
`;

before(() => {
  vault = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-vault-'));
  const env = path.join(vault, '.smart-env');
  fs.mkdirSync(path.join(env, 'multi'), { recursive: true });
  fs.writeFileSync(path.join(env, 'smart_env.json'), JSON.stringify({
    smart_sources: { embed_model: { transformers: { model_key: 'BAAI/bge-small-en-v1.5' } } },
  }));
  const key = 'BAAI/bge-small-en-v1.5';
  const lines = [
    ['Shop/Collision_Repair.md', vec(1)],
    ['Shop/Color_Match.md', vec(1.05)],
    ['Side/Fence_Paint.md', vec(4)],
  ].map(([p, v]) => `"smart_sources:${p}": ${JSON.stringify({ embeddings: { [key]: { vec: v } } })},`);
  fs.writeFileSync(path.join(env, 'multi', 'a.ajson'), lines.join('\n'));
  fs.mkdirSync(path.join(vault, 'Shop'));
  fs.writeFileSync(path.join(vault, 'Shop', 'Collision_Repair.md'), NOTE);
  fs.writeFileSync(path.join(vault, 'Shop', 'Big.md'), 'x'.repeat(25000));

  const config = validateConfig(vault);
  ctx = { config, data: loadSmartConnectionsData(config) };
});

after(() => fs.rmSync(vault, { recursive: true, force: true }));

const call = async (name, args) => (await handleToolCall(name, args, ctx));
const text = async (name, args) => (await call(name, args)).content[0].text;

test('search_similar text format is score<TAB>path lines', async () => {
  const out = await text('search_similar', { notePath: 'Shop/Collision_Repair.md', threshold: 0 });
  const lines = out.split('\n');
  assert.match(lines[0], /^\d\.\d{3}\tShop\/Color_Match\.md$/);
  assert.ok(!out.includes('Collision_Repair'), 'query note excluded');
  assert.ok(!out.includes('{'), 'no JSON');
});

test('search_similar json format is minified and backward compatible', async () => {
  const out = await text('search_similar', { notePath: 'Shop/Collision_Repair.md', format: 'json', threshold: 0 });
  assert.ok(!out.includes('\n'));
  const parsed = JSON.parse(out);
  assert.equal(parsed.query, 'Shop/Collision_Repair.md');
  assert.equal(parsed.results[0].path, 'Shop/Color_Match.md');
  assert.equal(parsed.results[0].title, 'Color Match');
});

test('search with no matches says so briefly', async () => {
  const out = await text('search_similar', { notePath: 'Shop/Collision_Repair.md', threshold: 1 });
  assert.equal(out, 'No matches above threshold.');
});

test('list_indexed pages with a next offset hint', async () => {
  assert.equal(await text('list_indexed', { limit: 2 }),
    '3 notes (1-2); next offset=2\nShop/Collision_Repair.md\nShop/Color_Match.md');
  assert.equal(await text('list_indexed', { limit: 2, offset: 2 }), '3 notes (3-3)\nSide/Fence_Paint.md');
  assert.equal(await text('list_indexed', { pattern: 'Side/' }), '1 notes\nSide/Fence_Paint.md');
  assert.deepEqual(JSON.parse(await text('list_indexed', { limit: 1, format: 'json' })),
    { count: 3, offset: 0, nextOffset: 1, notes: ['Shop/Collision_Repair.md'] });
});

test('get_note returns raw content by default', async () => {
  assert.equal(await text('get_note', { notePath: 'Shop/Collision_Repair.md' }), NOTE);
});

test('get_note section extraction respects heading levels and code fences', async () => {
  const out = await text('get_note', { notePath: 'Shop/Collision_Repair.md', section: 'color matching' });
  assert.ok(out.startsWith('## Color Matching'));
  assert.ok(out.includes('### Variants'));
  assert.ok(out.includes('## not a heading'));
  assert.ok(!out.includes('Clear Coat'));
  const missing = await call('get_note', { notePath: 'Shop/Collision_Repair.md', section: 'Nope' });
  assert.equal(missing.isError, true);
});

test('get_note strips frontmatter', async () => {
  const out = await text('get_note', { notePath: 'Shop/Collision_Repair.md', stripFrontmatter: true });
  assert.ok(out.startsWith('# Collision Repair'));
  assert.equal(stripFrontmatter('no frontmatter'), 'no frontmatter');
});

test('get_note pages long notes and never exceeds the server cap', async () => {
  const first = await text('get_note', { notePath: 'Shop/Big.md', maxLength: 999999 });
  assert.ok(first.endsWith('[truncated: chars 0-10240 of 25000; next offset=10240]'));
  const json = JSON.parse(await text('get_note', { notePath: 'Shop/Big.md', offset: 20480, format: 'json' }));
  assert.equal(json.content.length, 4520);
  assert.equal(json.nextOffset, undefined);
  const small = await text('get_note', { notePath: 'Shop/Big.md', maxLength: 10 });
  assert.ok(small.startsWith('xxxxxxxxxx\n\n[truncated: chars 0-10 of 25000'));
});

test('get_note still blocks traversal', async () => {
  const r = await call('get_note', { notePath: '../etc/passwd.md' });
  assert.equal(r.isError, true);
});

test('extractSection returns null when absent', () => {
  assert.equal(extractSection('# A\ntext', 'B'), null);
  assert.equal(extractSection('# A\ntext\n# B\nmore', '# B'), '# B\nmore');
});

test('tool definitions are no larger than v0.2.0 (2194 chars)', () => {
  const size = JSON.stringify(toolDefinitions).length;
  assert.ok(size <= 2194, `tool definitions are ${size} chars`);
});
