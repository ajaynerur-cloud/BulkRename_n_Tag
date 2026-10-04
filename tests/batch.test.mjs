// Option C: recipes and per-folder jobs. Two folders run at the same time with different recipes,
// numbering stays per folder, tags are written, and a second job on the same folder is refused.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeNativePlugin } from './native-mock.mjs';

const mp3 = new Uint8Array(fs.readFileSync(new URL('./fixtures/t.mp3', import.meta.url)));
const M = '/storage/emulated/0';
const files = {
  [`${M}/Music/Coke/au_uu_SzH34yR2.mp3`]: mp3, [`${M}/Music/Coke/Song_Two [dQw4w9WgXcQ].mp3`]: mp3, [`${M}/Music/Coke/CD2/x.mp3`]: 'x',
  [`${M}/Music/Rahman/a_one.mp3`]: mp3, [`${M}/Music/Rahman/b_two.mp3`]: mp3,
};
const plugin = makeNativePlugin(files);
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { NameTagFolders: plugin } } };
const { NativeRoot } = await import('../public/js/core/sources.js');
const R = await import('../public/js/batch/recipes.js');
const { startFolderJob, folderBusy } = await import('../public/js/batch/run.js');
const { readTags } = await import('../public/js/tagger/index.js');
const { whenIdle } = await import('../public/js/core/jobs.js');

const _w = console.warn; console.warn = (...a) => { if (a[0] !== 'history') _w(...a); };
let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, e.stack || e.message); process.exitCode = 1; } };
const names = () => [...plugin.files.keys()].map((k) => k.slice(M.length + 1)).filter((n) => !/nametag/.test(n)).sort();
const root = () => new NativeRoot({ items: [{ path: `${M}/Music`, isDir: true }] });

await t('folders are found from a scan', async () => {
  const entries = await root().list();
  const f = R.foldersOf(entries, (n) => /\.mp3$/.test(n));
  assert.deepEqual(f.map((x) => x.dir).sort(), ['Coke', 'Coke/CD2', 'Rahman']);
  assert.equal(f.find((x) => x.dir === 'Coke').audio, 2);
});

await t('tag templates', () => {
  assert.equal(R.expandTagTemplate('{parent} / {grandparent} #{n:2}/{total}', { path: 'Artist/Album/x.mp3', name: 'x.mp3', n: 3, total: 12, rootName: 'R' }), 'Album / Artist #03/12');
  assert.equal(R.expandTagTemplate('{name}', { path: 'a/Song One.mp3', name: 'Song One.mp3', n: 1, total: 1, rootName: 'R' }), 'Song One');
});

await t('two folders, two recipes, in parallel', async () => {
  const r = root(); const entries = await r.list();
  const tidy = R.builtinRecipes().find((x) => x.id === 'b-tidy-number');
  const tags = R.builtinRecipes().find((x) => x.id === 'b-tags-folder');
  assert.equal(await folderBusy(r, 'Coke'), null);
  const j1 = startFolderJob({ root: r, entries, dir: 'Coke', recipe: tidy });
  const j2 = startFolderJob({ root: r, entries, dir: 'Rahman', recipe: tags });
  assert.ok(await folderBusy(r, 'Coke'), 'second start on the same folder must be blocked while it runs');
  assert.equal(await folderBusy(r, 'Rahman') !== null, true);
  const [a, b] = await Promise.all([j1.promise, j2.promise]);
  assert.equal(a.status, 'done', JSON.stringify(a)); assert.equal(b.status, 'done', JSON.stringify(b));
  assert.equal(a.renamed, 2); assert.equal(b.tagsDone, 2);
  const n = names();
  assert.ok(n.includes('Music/Coke/01 - au uu.mp3'), n.join('\n'));
  assert.ok(n.includes('Music/Coke/02 - Song Two.mp3'), n.join('\n'));
  assert.ok(n.includes('Music/Coke/CD2/x.mp3'), 'sub-folder untouched');
  assert.ok(n.includes('Music/Rahman/a_one.mp3'), 'tag-only recipe does not rename');
  const m = await readTags(await r.getFile('Rahman/a_one.mp3'));
  assert.equal(m.fields.album, 'Rahman');
  assert.equal(m.fields.artist, 'Music');
  await whenIdle();
  assert.equal(await folderBusy(r, 'Coke'), null);
});

await t('a whole-source operation conflicts with a folder job, other folders do not', async () => {
  const { conflictFor } = await import('../public/js/core/jobs.js');
  const r = root(); const entries = await r.list();
  const slow = { id: 'x', name: 'slow', desc: '', rules: [{ type: 'cleanup', enabled: true, opts: {} }], tags: {} };
  const j = startFolderJob({ root: r, entries, dir: 'Rahman', recipe: slow });
  assert.ok(await conflictFor(r), 'renaming the whole source is blocked');
  const { scopeFor } = await import('../public/js/batch/run.js');
  assert.equal(await conflictFor(scopeFor(r, 'Coke')), null);
  await j.promise;
});

await t('recipe storage round trip and summaries', () => {
  const store = new Map(); globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const rec = R.newRecipe('Mine'); rec.rules = [{ type: 'codes', enabled: true, opts: { minLen: 5 } }, { type: 'nope', opts: {} }]; rec.tags = { artist: '{parent}' };
  R.saveUserRecipes([rec]);
  const back = R.loadUserRecipes();
  assert.equal(back.length, 1); assert.equal(back[0].rules.length, 1); assert.equal(back[0].rules[0].opts.minLen, 5);
  assert.equal(R.recipeSummary(back[0]), '1 rename rule + 1 tag');
  assert.ok(R.allRecipes().length >= 6);
});

console.log(`batch tests: ${pass} passed`);
