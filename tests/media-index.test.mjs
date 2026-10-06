// Android media library re-index: every rename / tag save job on the phone ends with a scanMedia call that
// lists exactly the changed files (old and new paths), by default. Covers both Android sources.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeNativePlugin } from './native-mock.mjs';
import { makeSafPlugin } from './saf-mock.mjs';

const M = '/storage/emulated/0';
const native = makeNativePlugin({ [`${M}/Music/A/01_a.mp3`]: 'a', [`${M}/Music/A/02_b.mp3`]: 'b', [`${M}/Music/A/Sub/03_c.mp3`]: 'c' });
const scans = [];
const scanMedia = async (req) => { scans.push(req); return { requested: (req.paths || req.ids).length, scanned: (req.paths || req.ids).length }; };
native.scanMedia = scanMedia;
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { NameTagFolders: native } } };

const { NativeRoot, SafRoot } = await import('../public/js/core/sources.js');
const { startJob } = await import('../public/js/core/jobs.js');
const { executeOpsParallel } = await import('../public/js/core/planner.js');
const { setMediaIndexEnabled } = await import('../public/js/core/media-index.js');

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, e.stack || e.message); process.exitCode = 1; } };

await t('rename job re-indexes old and new paths, including files inside a renamed folder', async () => {
  const root = new NativeRoot({ items: [{ path: `${M}/Music/A`, isDir: true }] });
  await root.list();
  scans.length = 0;
  const job = startJob({ kind: 'rename', title: 'x', root, run: async () => {
    await executeOpsParallel(root, [{ from: '01_a.mp3', to: '01 - a.mp3' }, { from: 'Sub/03_c.mp3', to: 'Sub/03 - c.mp3' }, { from: 'Sub', to: 'Disc 1' }], { concurrency: 1 });
    return { status: 'done' };
  } });
  await job.promise;
  assert.equal(scans.length, 1);
  const p = new Set(scans[0].paths);
  for (const x of ['01_a.mp3', '01 - a.mp3', 'Sub', 'Disc 1', 'Sub/03 - c.mp3', 'Disc 1/03 - c.mp3']) assert.ok(p.has(`${M}/Music/A/${x}`), x);
  assert.ok(!p.has(`${M}/Music/A/02_b.mp3`), 'untouched file is not rescanned');
  assert.equal(job.mediaIndexed, p.size);
});

await t('tag save (full write and in-place patch) re-indexes the saved files', async () => {
  const root = new NativeRoot({ items: [{ path: `${M}/Music/A`, isDir: true }] });
  await root.list();
  scans.length = 0;
  await startJob({ kind: 'tags', title: 'x', root, run: async () => {
    await root.writeFile('02_b.mp3', new Blob(['bb']));
    await root.writeAt('01 - a.mp3', [{ offset: 0, bytes: new Uint8Array([65]) }], 1);
    return { status: 'done' };
  } }).promise;
  assert.deepEqual(scans[0].paths.sort(), [`${M}/Music/A/01 - a.mp3`, `${M}/Music/A/02_b.mp3`]);
});

await t('runs after Stop / error too, and nothing is sent when nothing changed', async () => {
  const root = new NativeRoot({ items: [{ path: `${M}/Music/A`, isDir: true }] });
  await root.list();
  scans.length = 0;
  await startJob({ kind: 'rename', title: 'x', root, run: async () => { await root.move('02_b.mp3', '02 - b.mp3'); throw new Error('boom'); } }).promise;
  assert.equal(scans.length, 1);
  await startJob({ kind: 'rename', title: 'x', root, run: async () => ({ status: 'done' }) }).promise;
  assert.equal(scans.length, 1, 'no changes -> no scan');
});

await t('picked folder (SAF): sends document ids of old and new names', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-media-'));
  fs.mkdirSync(path.join(dir, 'CD1')); fs.writeFileSync(path.join(dir, 'CD1', 'x.mp3'), 'x'); fs.writeFileSync(path.join(dir, 'y.mp3'), 'y');
  const saf = makeSafPlugin(dir); saf.scanMedia = scanMedia;
  window.Capacitor.Plugins.NameTagFolders = saf;
  const root = new SafRoot({ saf: 'content://com.android.externalstorage.documents/tree/primary%3AMusic', rootId: 'primary:', name: 'Music' });
  await root.list();
  scans.length = 0;
  await startJob({ kind: 'rename', title: 'x', root, run: async () => { await root.move('y.mp3', 'Y song.mp3'); await root.move('CD1', 'Disc 1'); return { status: 'done' }; } }).promise;
  const ids = new Set(scans[0].ids);
  assert.equal(scans[0].uri, root.uri);
  for (const id of ['primary:y.mp3', 'primary:Y song.mp3', 'primary:CD1', 'primary:Disc 1', 'primary:CD1/x.mp3', 'primary:Disc 1/x.mp3']) assert.ok(ids.has(id), id);
  window.Capacitor.Plugins.NameTagFolders = native;
  fs.rmSync(dir, { recursive: true, force: true });
});

await t('opt-out switch and old app builds without scanMedia never break a job', async () => {
  const root = new NativeRoot({ items: [{ path: `${M}/Music/A`, isDir: true }] });
  await root.list();
  scans.length = 0;
  setMediaIndexEnabled(false);
  await startJob({ kind: 'rename', title: 'x', root, run: async () => { await root.move('02 - b.mp3', '02_b.mp3'); return { status: 'done' }; } }).promise;
  assert.equal(scans.length, 0);
  setMediaIndexEnabled(true);
  delete native.scanMedia;
  const r = await startJob({ kind: 'rename', title: 'x', root, run: async () => { await root.move('02_b.mp3', '02 - b.mp3'); return { status: 'done' }; } }).promise;
  assert.equal(r.status, 'done');
  native.scanMedia = scanMedia;
});

console.log(`media index: ${pass} checks passed`);
setTimeout(() => process.exit(process.exitCode || 0), 50);
