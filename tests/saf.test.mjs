// Android folder access (SafRoot) against a provider-like mock: in-place renames with the real planner,
// folder renames (ids change), case-only renames, collisions, undo files, partial reads and tag saving.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeSafPlugin } from './saf-mock.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'saf-'));
const put = (rel, data = 'x') => { fs.mkdirSync(path.dirname(path.join(tmp, rel)), { recursive: true }); fs.writeFileSync(path.join(tmp, rel), data); };
const mp3 = fs.readFileSync(new URL('./fixtures/t.mp3', import.meta.url));
// Pad to a realistic size (repeat the audio frames region) so partial reads are meaningful.
put('01_one.mp3', Buffer.concat([mp3, ...Array(160).fill(mp3.subarray(mp3.length - 16000))]));
put('02_two.mp3'); put('CD 2/01_three.mp3'); put('cover.JPG'); put('.hidden/secret.txt');
const plugin = makeSafPlugin(tmp);
globalThis.window = { Capacitor: { isNativePlatform: () => true, Plugins: { NameTagFolders: plugin } } };
globalThis.atob ??= (s) => Buffer.from(s, 'base64').toString('binary');
globalThis.btoa ??= (s) => Buffer.from(s, 'binary').toString('base64');

const { SafRoot, support, pickFolderRoot } = await import('../public/js/core/sources.js');
const { buildPlan, executeOps, reverseOps, simulateOps } = await import('../public/js/core/planner.js');
const { readTags, writeTags } = await import('../public/js/tagger/index.js');

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, e.stack || e.message); process.exitCode = 1; } };
const disk = () => { const out = []; const walk = (d, p) => { for (const n of fs.readdirSync(d).sort()) { const r = p ? `${p}/${n}` : n; if (fs.statSync(path.join(d, n)).isDirectory()) { out.push(`${r}/`); walk(path.join(d, n), r); } else out.push(r); } }; walk(tmp, ''); return out; };

await t('support flags and picker', async () => {
  assert.equal(support.safPicker, true); assert.equal(support.folderPicker, true);
  const r = await pickFolderRoot(); assert.ok(r instanceof SafRoot); assert.equal(r.kind, 'dir');
});
const root = await pickFolderRoot();
const entries = await root.list({ recursive: true });
await t('list skips hidden folders', () => assert.deepEqual(entries.map((e) => e.path), ['CD 2', '01_one.mp3', '02_two.mp3', 'cover.JPG', 'CD 2/01_three.mp3']));

await t('partial reads: tags read without loading the whole file', async () => {
  plugin.calls.length = 0;
  const f = await entries.find((e) => e.name === '01_one.mp3').getFile();
  const m = await readTags(f);
  assert.equal(m.fields.title, 'Orig Title');
  const bytesRead = plugin.calls.filter((c) => c.startsWith('read:')).reduce((s, c) => s + Number(c.slice(5)), 0);
  assert.ok(bytesRead < f.size, `read ${bytesRead} of ${f.size} bytes`);
});

let ops;
await t('in-place rename with the planner: files, a folder, a case-only change', async () => {
  const proposals = new Map([['01_one.mp3', '01 - One.mp3'], ['02_two.mp3', '02 - Two.mp3'], ['CD 2', 'Disc 2'], ['CD 2/01_three.mp3', '01 - Three.mp3'], ['cover.JPG', 'cover.jpg']]);
  const plan = buildPlan(entries, proposals, {});
  ops = plan.ops;
  const res = await executeOps(root, ops);
  assert.equal(res.error, null, res.error?.message);
  assert.deepEqual(disk(), ['.hidden/', '.hidden/secret.txt', '01 - One.mp3', '02 - Two.mp3', 'Disc 2/', 'Disc 2/01 - Three.mp3', 'cover.jpg']);
});

await t('undo file written into the folder, then restore in reverse', async () => {
  await root.writeText('nametag-rename-test.json', JSON.stringify({ ok: 1 }));
  assert.ok(fs.existsSync(path.join(tmp, 'nametag-rename-test.json')));
  await root.list({ recursive: true });
  assert.equal(root.manifests.length, 1);
  assert.equal(JSON.parse(await (await root.manifests[0].getFile()).text()).ok, 1);
  const res = await executeOps(root, reverseOps(ops));
  assert.equal(res.error, null, res.error?.message);
  assert.deepEqual(disk().filter((p) => !p.startsWith('nametag')), ['.hidden/', '.hidden/secret.txt', '01_one.mp3', '02_two.mp3', 'CD 2/', 'CD 2/01_three.mp3', 'cover.JPG']);
});

await t('collision: provider would add " (1)", so the rename is undone and reported', async () => {
  await root.list({ recursive: true });
  await assert.rejects(() => root.move('02_two.mp3', '01_ONE.mp3'), /instead of/);
  assert.ok(fs.existsSync(path.join(tmp, '02_two.mp3')));
  assert.equal(await root.exists('01_ONE.mp3'), true); // case-insensitive, like Android storage
});

await t('save tags in place (chunked write of a full file)', async () => {
  await root.list({ recursive: true });
  const file = await root.getFullFile('01_one.mp3');
  const m = await readTags(file); m.fields.title = 'Saved on Android'; m.fields.lyrics = 'la '.repeat(2_000_000); // ~6 MB, several chunks
  const { blob } = await writeTags(file, m, {});
  await root.writeFile('01_one.mp3', blob);
  const back = await readTags(new File([fs.readFileSync(path.join(tmp, '01_one.mp3'))], 'x.mp3'));
  assert.equal(back.fields.title, 'Saved on Android'); assert.equal(back.fields.lyrics.length, 6_000_000);
});

await t('new file in a subfolder', async () => {
  await root.writeFile('CD 2/notes.txt', new Blob(['hello']));
  assert.equal(fs.readFileSync(path.join(tmp, 'CD 2/notes.txt'), 'utf8'), 'hello');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`android folders: ${pass} checks passed`);
