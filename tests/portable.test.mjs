// Portable restore (undo files used on another computer) and the extension renamer.
import assert from 'node:assert/strict';
import { buildPlan, executeOps, reverseOps, simulateOps } from '../public/js/core/planner.js';
import { MockRoot } from '../public/js/core/sources.js';
import { detectRemap, countMatches, remapOps, mapPath, currentPathsAfter } from '../public/js/core/remap.js';
import { extensionProposals, newNameFor, extGroups } from '../public/js/renamer/extensions.js';

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, e.message); process.exitCode = 1; } };

// A rename made on computer 1 inside folder "Album" (paths are relative to Album).
const orig = ['01_one.mp3', '02_two.mp3', 'CD2', 'CD2/01_three.mp3', 'cover.JPEG'];
const entries = orig.map((p) => ({ path: p, name: p.split('/').pop(), isDir: p === 'CD2' }));
const proposals = new Map([['01_one.mp3', '01 - One.mp3'], ['02_two.mp3', '02 - Two.mp3'], ['CD2/01_three.mp3', '01 - Three.mp3'], ['cover.JPEG', 'cover.jpg']]);
const plan = buildPlan(entries, proposals, {});
const ops = plan.ops.map(({ kind, from, to }) => ({ kind, from, to }));
const saved = currentPathsAfter(ops);

await t('current paths after ops', () => assert.deepEqual(saved.sort(), ['01 - One.mp3', '02 - Two.mp3', 'CD2/01 - Three.mp3', 'cover.jpg']));
await t('current paths follow folder renames', () => {
  const o = [{ kind: 'file', from: 'd/a.txt', to: 'd/b.txt' }, { kind: 'dir', from: 'd', to: 'D2' }];
  assert.deepEqual(currentPathsAfter(o).sort(), ['D2', 'D2/b.txt']);
});

// Computer 2 scenarios: what the person opened, and the expected mapping.
const renamed = ['01 - One.mp3', '02 - Two.mp3', 'CD2', 'CD2/01 - Three.mp3', 'cover.jpg'];
const scenarios = [
  ['same folder', renamed, 0, ''],
  ['parent folder opened', ['Album', ...renamed.map((p) => `Album/${p}`), 'Other/x.mp3'], 0, 'Album'],
  ['ZIP extracted into two extra folders', ['dl', 'dl/Album-renamed', ...renamed.map((p) => `dl/Album-renamed/${p}`)], 0, 'dl/Album-renamed'],
];
for (const [name, present, strip, prefix] of scenarios) {
  await t(`detect: ${name}`, async () => {
    const rm = detectRemap(saved, present, { allowDirs: false });
    assert.equal(rm.strip, strip); assert.equal(rm.prefix, prefix);
    assert.equal(countMatches(saved, present, rm), saved.length);
    // and the restore really works on that layout
    const root = new MockRoot(present);
    const rops = remapOps(reverseOps(ops), rm);
    const sim = simulateOps([...root.map.keys()], rops);
    assert.equal(sim.conflict, 0);
    const res = await executeOps(root, sim.results.filter((r) => r.status === 'ok'));
    assert.equal(res.error, null);
    const base = prefix ? `${prefix}/` : '';
    for (const p of ['01_one.mp3', '02_two.mp3', 'CD2/01_three.mp3', 'cover.JPEG']) assert.ok(root.map.has(base + p), `restored ${base + p}`);
  });
}

await t('detect: saved paths include a top folder, the folder itself was opened', () => {
  const s2 = saved.map((p) => `Album/${p}`);
  const rm = detectRemap(s2, renamed, { allowDirs: false });
  assert.equal(rm.strip, 1); assert.equal(rm.prefix, '');
  assert.equal(countMatches(s2, renamed, rm), s2.length);
});

await t('detect: hint picks the folder where the undo file was found', () => {
  const present = ['A/01 - One.mp3', 'B/01 - One.mp3'];
  const rm = detectRemap(['01 - One.mp3'], present, { allowDirs: false, hint: 'B' });
  assert.equal(rm.prefix, 'B');
});

await t('moved subfolder found by unique file names', () => {
  const s = ['CD1/a.mp3', 'CD1/b.mp3', 'CD2/c.mp3', 'cover.jpg'];
  const present = ['Disc 1/a.mp3', 'Disc 1/b.mp3', 'CD2/c.mp3', 'cover.jpg'];
  const rm = detectRemap(s, present, { allowDirs: true });
  assert.deepEqual(rm.dirs, [['CD1', 'Disc 1']]);
  assert.equal(mapPath('CD1/a.mp3', rm), 'Disc 1/a.mp3');
  assert.equal(countMatches(s, present, rm), 4);
});

await t('extra top folder plus a renamed subfolder', () => {
  const s = ['CD1/t.flac', 'CD1/t.mp3', 'CD2/t.ogg'];
  const present = ['Music/Alb/Disc 1/t.flac', 'Music/Alb/Disc 1/t.mp3', 'Music/Alb/CD2/t.ogg'];
  const rm = detectRemap(s, present, { allowDirs: true });
  assert.equal(rm.strip, 0); assert.equal(rm.prefix, 'Music/Alb');
  assert.deepEqual(rm.dirs, [['Music/Alb/CD1', 'Music/Alb/Disc 1']]);
  assert.equal(countMatches(s, present, rm), 3);
});

await t('nothing matches: no false mapping', () => {
  const rm = detectRemap(saved, ['x.txt', 'y.txt'], { allowDirs: true });
  assert.equal(countMatches(saved, ['x.txt', 'y.txt'], rm), 0);
  assert.equal(rm.dirs.length, 0);
});

// Extension renamer
const files = ['a.JPEG', 'b.jpeg', 'c.jpg', 'd.PNG', 'notes', 'arch.tar.gz', 'e.htm', 'f.JPG'].map((n) => ({ path: `x/${n}`, name: n, isDir: false }));
const base = { map: {}, case: 'keep', unify: false, fixContent: false, addMissing: false, compound: true };
await t('ext: groups', () => assert.deepEqual(extGroups(files).map((g) => g.ext).sort(), ['', 'JPEG', 'JPG', 'PNG', 'htm', 'jpeg', 'jpg', 'tar.gz']));
await t('ext: unify keeps upper-case style', () => { const m = extensionProposals(files, { ...base, unify: true }); assert.equal(m.get('x/a.JPEG'), 'a.JPG'); assert.equal(m.get('x/b.jpeg'), 'b.jpg'); assert.equal(m.get('x/e.htm'), 'e.html'); });
await t('ext: unify + lower', () => { const m = extensionProposals(files, { ...base, unify: true, case: 'lower' }); assert.equal(m.get('x/a.JPEG'), 'a.jpg'); assert.equal(m.get('x/f.JPG'), 'f.jpg'); assert.equal(m.get('x/d.PNG'), 'd.png'); });
await t('ext: typed mapping wins and is exact', () => { const m = extensionProposals(files, { ...base, map: { PNG: 'webp', 'tar.gz': 'tgz', jpg: '-' }, case: 'lower' }); assert.equal(m.get('x/d.PNG'), 'd.webp'); assert.equal(m.get('x/arch.tar.gz'), 'arch.tgz'); assert.equal(m.get('x/c.jpg'), 'c'); });
await t('ext: fix by content and add missing', () => {
  const magic = new Map([['x/d.PNG', 'jpg'], ['x/notes', 'pdf'], ['x/a.JPEG', 'jpg']]);
  const m = extensionProposals(files, { ...base, fixContent: true, addMissing: true }, magic);
  assert.equal(m.get('x/d.PNG'), 'd.JPG'); assert.equal(m.get('x/notes'), 'notes.pdf'); assert.equal(m.get('x/a.JPEG'), 'a.JPEG');
});
await t('ext: compound off', () => assert.equal(newNameFor({ name: 'arch.tar.gz' }, { ...base, compound: false, map: { gz: 'gzip' } }).name, 'arch.tar.gzip'));
await t('ext: plan + undo round trip', async () => {
  const paths = files.map((f) => f.path).concat('x');
  const root = new MockRoot(paths);
  const ents = paths.map((p) => ({ path: p, name: p.split('/').pop(), isDir: p === 'x' }));
  const p = buildPlan(ents, extensionProposals(files, { ...base, unify: true, case: 'lower' }), {});
  const r1 = await executeOps(root, p.ops); assert.equal(r1.error, null);
  assert.ok(root.map.has('x/a.jpg') && root.map.has('x/f (2).jpg') === false);
  const r2 = await executeOps(root, reverseOps(p.ops)); assert.equal(r2.error, null);
  assert.deepEqual([...root.map.keys()].sort(), paths.sort());
});
console.log(`portable restore + extensions: ${pass} checks passed`);
