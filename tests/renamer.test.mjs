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

// ---- alphanumeric removal and the newer rules
const one = (type, o, name, ctx = {}) => [...runPipeline([{ path: 'Artist/Album/' + name, name, isDir: false }], [makeRule(type, o)], ctx).names.values()][0];
t('codes: random token', () => assert.equal(one('codes', {}, 'au_uu_SzH34yR2.mp3'), 'au_uu.mp3'));
t('codes: youtube id and uuid', () => { assert.equal(one('codes', {}, 'Song [dQw4w9WgXcQ].mp3'), 'Song.mp3'); assert.equal(one('codes', {}, 'Track 3f2a9c1b-1234-4abc-8def-0123456789ab.mp3'), 'Track.mp3'); });
t('codes: keeps normal words and years', () => assert.equal(one('codes', {}, 'Hello World 2024.mp3'), 'Hello World 2024.mp3'));
t('codes: long numbers only when asked', () => { assert.equal(one('codes', { tokens: false, longNum: 6 }, 'clip 123456789 final.mp4'), 'clip final.mp4'); assert.equal(one('codes', { tokens: false }, 'clip 123456789.mp4'), 'clip 123456789.mp4'); });
t('remove: keep only letters and digits', () => assert.equal(one('remove', { mode: 'keepalnum' }, 'a-b_c 1!.mp3'), 'abc1.mp3'));
t('remove: keep only letters / digits', () => { assert.equal(one('remove', { mode: 'keepletters' }, 'a1-b2.mp3'), 'ab.mp3'); assert.equal(one('remove', { mode: 'keepdigits' }, 'a1-b2.mp3'), '12.mp3'); });
t('remove: letters, digits, letters+digits, non-ascii', () => {
  assert.equal(one('remove', { mode: 'alnum' }, 'ab-12.mp3'), '-.mp3');
  assert.equal(one('remove', { mode: 'letters' }, 'ab12.mp3'), '12.mp3');
  assert.equal(one('remove', { mode: 'nonascii' }, 'Héllo Жук.mp3'), 'Hllo .mp3'.replace(' .', '.'));
  assert.equal(one('remove', { mode: 'alnumcode' }, 'au uu SzH34yR2.mp3'), 'au uu.mp3');
});
t('keep only', () => { assert.equal(one('keep', { extra: '-' }, 'Hé llo_wörld!.mp3'), 'Hé llowörld.mp3'); assert.equal(one('keep', { ascii: true, extra: '' }, 'Hé llo wörld!.mp3'), 'H llo wrld.mp3'); assert.equal(one('keep', { extra: '', replaceWith: '-' }, 'a_b.mp3'), 'a-b.mp3'); });
t('padnum', () => { assert.equal(one('padnum', {}, 'Track 3 of 12.mp3'), 'Track 003 of 012.mp3'); assert.equal(one('padnum', { mode: 'trim' }, '007 song.mp3'), '7 song.mp3'); assert.equal(one('padnum', { which: 'first' }, 'a 1 b 2.mp3'), 'a 001 b 2.mp3'); });
t('separator', () => { assert.equal(one('separator', { from: 'space', to: '_' }, 'a b  c 1.5.mp3'), 'a_b_c_1.5.mp3'); assert.equal(one('separator', { from: '_', to: 'space' }, 'a_b__c.mp3'), 'a b c.mp3'); });
t('dedupe', () => assert.equal(one('dedupe', {}, 'Song Song - Artist - Artist.mp3'), 'Song - Artist.mp3'));
t('foldername', () => { assert.equal(one('foldername', {}, 'x.mp3'), 'Album - x.mp3'); assert.equal(one('foldername', { level: '2', position: 'suffix' }, 'x.mp3'), 'x - Artist.mp3'); });
t('every rule has fields, label, icon', () => { for (const [k, d] of Object.entries(RULES)) { assert.ok(d.label && d.icon && d.group && d.desc, k); assert.ok(Array.isArray(d.fields), k); } });
console.log(`renamer: ${pass} checks passed`);
