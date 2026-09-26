// Node tests for the renamer engine: rules, analyser, planner (incl. case-only renames, cycles and restore).
import assert from 'node:assert/strict';
import { RULES, makeRule, runPipeline } from '../public/js/renamer/rules.js';
import { analyze } from '../public/js/renamer/analyzer.js';
import { BUILTIN_PRESETS } from '../public/js/renamer/presets.js';
import { buildPlan, executeOps, reverseOps, simulateOps } from '../public/js/core/planner.js';
import { MockRoot } from '../public/js/core/sources.js';

const names = ['01_my_song%20name.MP3', '02_another-track (1).MP3', '03_THIRD_song.mp3', '10_last_one.mp3'];
const items = names.map((n) => ({ path: `Album/${n}`, name: n, isDir: false, mtime: Date.UTC(2024, 0, 2), size: 10 }));
let pass = 0;
const t = (name, fn) => { try { fn(); pass++; } catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; } };

for (const type of Object.keys(RULES)) t(`rule ${type} runs with defaults`, () => { const r = runPipeline(items, [makeRule(type)], { scope: 'both', rootName: 'Root' }); assert.equal(r.names.size, items.length); });
t('cleanup + case + number', () => {
  const r = runPipeline(items, [makeRule('strip', { leading: true }), makeRule('cleanup'), makeRule('case', { mode: 'title' }), makeRule('number', { position: 'prefix', sep: ' - ' })], { scope: 'files' });
  const out = [...r.names.values()];
  console.log('   sample:', out.join(' | '));
  assert.ok(out[0].startsWith('1 - ') || out[0].startsWith('01 - '));
  assert.ok(out.every((n) => n.endsWith('.mp3')));
});
t('template', () => { const r = runPipeline(items, [makeRule('template', { tpl: '{parent} {n:3}' })], { scope: 'files' }); assert.equal([...r.names.values()][0], 'Album 001.MP3'); });
for (const p of BUILTIN_PRESETS) t(`preset ${p.id}`, () => runPipeline(items, p.rules(), { scope: 'files' }));
t('analyzer', () => { const a = analyze(items); console.log('   proposed:', a.proposed, '| detected:', a.detected.pattern, '|', a.suggestions.map((s) => s.title).join(', ')); assert.ok(a.suggestions.length); });

// planner: swap cycle + case-only rename on case-insensitive FS, then restore
const paths = ['a.txt', 'b.txt', 'Readme.md', 'dir', 'dir/x.txt'];
const entries = paths.map((p) => ({ path: p, name: p.split('/').pop(), isDir: p === 'dir' }));
const proposals = new Map([['a.txt', 'b.txt'], ['b.txt', 'a.txt'], ['Readme.md', 'README.md'], ['dir', 'Folder'], ['dir/x.txt', 'y.txt']]);
const plan = buildPlan(entries, proposals, {});
const root = new MockRoot(paths);
const res = await executeOps(root, plan.ops);
t('execute ok', () => { assert.equal(res.error, null); const keys = [...root.map.keys()].sort(); assert.deepEqual(keys, ['Folder', 'Folder/y.txt', 'README.md', 'a.txt', 'b.txt']); });
const sim = simulateOps([...root.map.keys()], reverseOps(plan.ops));
t('restore simulate', () => assert.equal(sim.ok, plan.ops.length));
const res2 = await executeOps(root, reverseOps(plan.ops));
t('restore ok', () => { assert.equal(res2.error, null); assert.deepEqual([...root.map.keys()].sort(), [...paths].sort()); });
t('conflict suffix', () => { const p = buildPlan(entries, new Map([['a.txt', 'Readme.md']]), {}); assert.equal(p.rows.get('a.txt').newName, 'Readme (2).md'); });
t('invalid name', () => { const p = buildPlan(entries, new Map([['a.txt', 'x/y']]), {}); assert.equal(p.rows.get('a.txt').status, 'invalid'); });
console.log(`renamer: ${pass} checks passed`);
