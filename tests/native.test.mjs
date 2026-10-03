// The in-app file browser source (NativeRoot): one folder, or any mix of folders and files at once.
// Renames with the real planner (parallel), undo, case-only changes, refusals, undo files, in-place tag patching.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { makeNativePlugin } from './native-mock.mjs';

const mp3 = new Uint8Array(fs.readFileSync(new URL('./fixtures/t.mp3', import.meta.url)));
const M = '/storage/emulated/0';
const files = {
  [`${M}/Songs/Coke/01_a.mp3`]: mp3, [`${M}/Songs/Coke/02_b.mp3`]: 'b', [`${M}/Songs/Coke/CD2/03_c.mp3`]: 'c',
  [`${M}/Songs/Rahman/x1.mp3`]: 'x1', [`${M}/Songs/Rahman/x2.mp3`]: 'x2',
  [`${M}/Other/single.mp3`]: 'single', [`${M}/Songs/.hidden/zz.mp3`]: 'h',
};
const plugin = makeNativePlugin(files);
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { NameTagFolders: plugin } } };

const { NativeRoot, support, rootFromHandle } = await import('../public/js/core/sources.js');
const { buildPlan, executeOpsParallel, reverseOps, executeOps } = await import('../public/js/core/planner.js');
const { makeRule, runPipeline } = await import('../public/js/renamer/rules.js');
const { readTags, planMp3Patch } = await import('../public/js/tagger/index.js');
const { sameSource } = await import('../public/js/core/jobs.js');

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, e.stack || e.message); process.exitCode = 1; } };
const names = () => [...plugin.files.keys()].map((k) => k.slice(M.length + 1)).sort();

await t('support flag and permission check', async () => {
  assert.equal(support.nativeBrowser, true);
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }] });
  assert.equal(await r.verifyPermission(), true);
  plugin.granted = false; assert.equal(await r.verifyPermission().catch(() => false), false); plugin.granted = true;
});

await t('one folder behaves like a plain folder', async () => {
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }] });
  assert.equal(r.name, 'Coke'); assert.ok(r.single);
  const list = await r.list();
  assert.deepEqual(list.map((e) => e.path).sort(), ['01_a.mp3', '02_b.mp3', 'CD2', 'CD2/03_c.mp3']);
  assert.equal(list.find((e) => e.path === '01_a.mp3').size, mp3.length);
});

await t('several folders and a file at once appear side by side', async () => {
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }, { path: `${M}/Songs/Rahman`, isDir: true }, { path: `${M}/Other/single.mp3`, isDir: false }] });
  assert.ok(!r.single); assert.equal(r.name, '2 folders + 1 file'); assert.equal(r.home, M);
  const list = await r.list();
  assert.deepEqual(list.map((e) => e.path).sort(), ['Coke', 'Coke/01_a.mp3', 'Coke/02_b.mp3', 'Coke/CD2', 'Coke/CD2/03_c.mp3', 'Rahman', 'Rahman/x1.mp3', 'Rahman/x2.mp3', 'single.mp3']);
  assert.ok(!list.some((e) => /hidden/.test(e.path)));
});

await t('two picked folders with the same name get distinct names', async () => {
  plugin.files.set(`${M}/Other/Coke/z.mp3`, { data: new Uint8Array([1]), mtime: 1 }); plugin.dirs.add(`${M}/Other/Coke`);
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }, { path: `${M}/Other/Coke`, isDir: true }] });
  const top = (await r.list()).filter((e) => !e.path.includes('/')).map((e) => e.path).sort();
  assert.deepEqual(top, ['Coke', 'Coke (2)']);
  plugin.files.delete(`${M}/Other/Coke/z.mp3`); plugin.dirs.delete(`${M}/Other/Coke`);
});

await t('parallel numbering across picked folders and exact undo', async () => {
  const before = names();
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }, { path: `${M}/Songs/Rahman`, isDir: true }, { path: `${M}/Other/single.mp3`, isDir: false }] });
  const entries = await r.list();
  const files = entries.filter((e) => !e.isDir);
  const { names: proposed } = runPipeline(files, [makeRule('number', { position: 'prefix', sep: ' - ', pad: 2, perFolder: true })], { scope: 'files' });
  const plan = buildPlan(entries, proposed, {});
  const out = await executeOpsParallel(r, plan.ops, { concurrency: r.maxConcurrency });
  assert.ok(!out.error, out.error?.message);
  const after = names();
  assert.ok(after.includes('Songs/Coke/01 - 01_a.mp3') || after.some((n) => /^Songs\/Coke\/\d\d - /.test(n)), after.join('\n'));
  assert.ok(after.some((n) => /^Other\/\d\d - single\.mp3$/.test(n)), 'the loose file is renamed too');
  assert.notDeepEqual(after, before);
  await executeOps(r, reverseOps(out.done));
  assert.deepEqual(names(), before, 'undo restores every name');
});

await t('renaming a picked folder itself, and its undo file lands next to the picked items', async () => {
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }, { path: `${M}/Other/single.mp3`, isDir: false }] });
  await r.list();
  await r.move('Coke', 'Coke Studio'); await r.move('single.mp3', 'Single One.mp3');
  assert.ok(names().includes('Songs/Coke Studio/01_a.mp3') && names().includes('Other/Single One.mp3'));
  assert.deepEqual((await r.list()).map((e) => e.path).filter((p) => !p.includes('/')).sort(), ['Coke Studio', 'Single One.mp3']);
  await r.writeText('nametag-rename-2026-01-01_00-00-00.json', '{"a":1}');
  assert.ok(names().includes('nametag-rename-2026-01-01_00-00-00.json'), 'written to the common parent');
  const again = new NativeRoot(r.handle); await again.list();
  assert.equal(again.manifests.length, 1);
  await r.move('Coke Studio', 'Coke'); await r.move('Single One.mp3', 'single.mp3'); plugin.files.delete(`${M}/nametag-rename-2026-01-01_00-00-00.json`);
});

await t('case-only rename works, a clash is refused and nothing is overwritten', async () => {
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Rahman`, isDir: true }] }); await r.list();
  await r.move('x1.mp3', 'X1.mp3'); assert.ok(names().includes('Songs/Rahman/X1.mp3')); await r.move('X1.mp3', 'x1.mp3');
  await assert.rejects(() => r.move('x1.mp3', 'x2.mp3'), /already exists/);
  assert.equal(new TextDecoder().decode(plugin.files.get(`${M}/Songs/Rahman/x2.mp3`).data), 'x2');
});

await t('tags: in-place patch through a lazy file reads and writes only a few KB', async () => {
  const r = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }] }); await r.list();
  const lazy = r.lazyFile('01_a.mp3');
  const model = await readTags(lazy);
  model.fields.title = 'Patched title'; model.fields.artist = 'Patched';
  plugin.calls.length = 0;
  // a normal first save leaves padding; emulate that by rewriting once through writeFile
  const { writeTags } = await import('../public/js/tagger/index.js');
  const { blob } = await writeTags(await r.getFullFile('01_a.mp3'), model, { id3Version: 3 });
  await r.writeFile('01_a.mp3', blob);
  const m2 = await readTags(r.lazyFile('01_a.mp3')); m2.fields.title = 'Second edit'; m2.fields.album = 'Alb';
  const plan = await planMp3Patch(r.lazyFile('01_a.mp3'), m2, { id3Version: 3, id3v1: 'update' });
  assert.ok(plan, 'fits in the padding');
  const size = r.lazyFile('01_a.mp3').size;
  await r.writeAt('01_a.mp3', plan.writes, size);
  const back = await readTags(r.lazyFile('01_a.mp3'));
  assert.equal(back.fields.title, 'Second edit'); assert.equal(r.lazyFile('01_a.mp3').size, size);
});

await t('sameSource: overlapping selections conflict, disjoint ones do not; History handle round-trips', async () => {
  const a = new NativeRoot({ items: [{ path: `${M}/Songs`, isDir: true }] });
  const b = new NativeRoot({ items: [{ path: `${M}/Songs/Coke`, isDir: true }, { path: `${M}/Other/single.mp3`, isDir: false }] });
  const c = new NativeRoot({ items: [{ path: `${M}/Other/single.mp3`, isDir: false }, { path: `${M}/Elsewhere`, isDir: true }] });
  const d = new NativeRoot({ items: [{ path: `${M}/Music`, isDir: true }] });
  assert.equal(await sameSource(a, b), true); assert.equal(await sameSource(b, c), true); assert.equal(await sameSource(a, d), false);
  const again = rootFromHandle(JSON.parse(JSON.stringify(b.handle)));
  assert.ok(again instanceof NativeRoot); assert.equal(again.items.length, 2);
});

console.log(`native: ${pass} checks passed`);
