// Parallel renames and tag saves must give exactly the same result as doing them one by one:
// same final names (numbering included), same tags in the same files, and an exact undo after a
// failure or a Stop. Random trees with swaps, case-only renames, nested folder renames and numbering,
// executed with random delays so any ordering mistake shows up.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildPlan, executeOps, executeOpsParallel, opDependencies, reverseOps } from '../public/js/core/planner.js';
import { MockRoot } from '../public/js/core/sources.js';
import { makeRule, runPipeline } from '../public/js/renamer/rules.js';
import { normaliseInterrupted } from '../public/js/core/manifest.js';
import { startJob, cancelJob, activeFor, hasRunning, whenIdle, runPool, conflictFor } from '../public/js/core/jobs.js';
import { readTags } from '../public/js/tagger/index.js';
import { writeTagsOffThread } from '../public/js/tagger/pool.js';

let pass = 0;
const t = async (name, fn) => { try { await fn(); pass++; } catch (e) { console.error('FAIL', name, '\n  ', e.stack.split('\n').slice(0, 4).join('\n   ')); process.exitCode = 1; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// small seeded random generator so a failure can be reproduced
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };

/** A root whose calls take random time, remembers which original file each path holds, and checks ordering. */
class SlowRoot extends MockRoot {
  constructor(paths, rand, { failOn = null } = {}) {
    super(paths);
    for (const [k, e] of this.map) e.id = k;
    this.rand = rand; this.failOn = failOn; this.started = new Map(); this.ended = new Map(); this.tick = 0; this.running = 0; this.peak = 0;
  }
  async exists(p) { await sleep(this.rand() * 2); return MockRoot.prototype.exists.call(this, p); }
  async move(from, to) {
    const key = `${from}>${to}`;
    this.started.set(key, this.tick++); this.running++; this.peak = Math.max(this.peak, this.running);
    await sleep(this.rand() * 3);
    if (this.failOn === key) { this.running--; throw new Error('disk error (test)'); }
    MockRoot.prototype.move.call({ __proto__: this, exists: (x) => MockRoot.prototype.exists.call(this, x) }, from, to);
    await sleep(this.rand() * 2);
    this.running--; this.ended.set(key, this.tick++);
  }
  snapshot() { return [...this.map].map(([k, e]) => `${k}=${e.id}`).sort(); }
}

/** Random tree: folders (some nested), files with similar names so renames collide, swap and numbering cases. */
function makeTree(rand) {
  const dirs = ['']; const paths = [];
  const nd = 2 + Math.floor(rand() * 5);
  for (let i = 0; i < nd; i++) { const parent = dirs[Math.floor(rand() * dirs.length)]; const d = `${parent ? `${parent}/` : ''}d${i}`; dirs.push(d); paths.push(d); }
  for (const d of dirs) { const nf = 3 + Math.floor(rand() * 8); for (let i = 0; i < nf; i++) paths.push(`${d ? `${d}/` : ''}${['a', 'b', 'C', 'track'][Math.floor(rand() * 4)]}${i}.${['mp3', 'MP3', 'txt'][Math.floor(rand() * 3)]}`); }
  const unique = [...new Set(paths)];
  const entries = unique.map((p) => ({ path: p, name: p.split('/').pop(), isDir: dirs.includes(p) }));
  return { paths: unique, entries };
}
function makeProposals(entries, rand) {
  const m = new Map();
  const files = entries.filter((e) => !e.isDir);
  const byDir = new Map();
  for (const e of files) { const d = e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : ''; (byDir.get(d) || byDir.set(d, []).get(d)).push(e); }
  for (const list of byDir.values()) {
    list.forEach((e, i) => { // numbering within the folder, like the "Add numbers" rule
      const r = rand();
      if (r < 0.5) m.set(e.path, `${String(i + 1).padStart(3, '0')} - ${e.name}`);
      else if (r < 0.7) m.set(e.path, e.name.toUpperCase());
      else if (r < 0.8) m.set(e.path, e.name.toLowerCase());
    });
    for (let k = 0; k + 1 < list.length; k += 3) if (rand() < 0.5) { m.set(list[k].path, list[k + 1].name); m.set(list[k + 1].path, list[k].name); } // swaps
  }
  for (const e of entries) if (e.isDir && rand() < 0.7) m.set(e.path, `${e.name}_renamed`);
  return m;
}

await t('dependencies: independent folders do not wait for each other, swaps and parents do', () => {
  const ops = [
    { kind: 'file', from: 'a/x', to: 'a/y' },      // 0
    { kind: 'file', from: 'b/x', to: 'b/y' },      // 1  other folder: free
    { kind: 'file', from: 'a/y2', to: 'a/x' },     // 2  needs a/x to be freed by op 0
    { kind: 'dir', from: 'a', to: 'a2' },          // 3  folder rename waits for everything inside a
    { kind: 'file', from: 'c/p', to: 'c/.nametag-tmp-1' }, // 4
    { kind: 'file', from: 'c/q', to: 'c/p' },      // 5  takes the name op 4 freed
    { kind: 'file', from: 'c/.nametag-tmp-1', to: 'c/q' }, // 6 temp chain
  ];
  const d = opDependencies(ops);
  assert.deepEqual(d[0], []); assert.deepEqual(d[1], []);
  assert.deepEqual(d[2], [0]);
  assert.deepEqual(d[3].sort(), [0, 2]);
  assert.deepEqual(d[4], []); assert.deepEqual(d[5], [4]); assert.deepEqual(d[6].sort(), [4, 5]);
});

await t('parallel result equals sequential result (60 random trees, swaps, case changes, folder renames)', async () => {
  let peak = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = rng(seed);
    const { paths, entries } = makeTree(rand);
    const plan = buildPlan(entries, makeProposals(entries, rand), {});
    const seqRoot = new SlowRoot(paths, rng(seed + 1000)); const parRoot = new SlowRoot(paths, rng(seed + 2000));
    const a = await executeOps(seqRoot, plan.ops);
    const b = await executeOpsParallel(parRoot, plan.ops, { concurrency: 6 });
    assert.equal(a.error, null, `seed ${seed}: sequential failed: ${a.error?.message}`);
    assert.equal(b.error, null, `seed ${seed}: parallel failed: ${b.error?.message}`);
    assert.deepEqual(parRoot.snapshot(), seqRoot.snapshot(), `seed ${seed}: different result`);
    assert.deepEqual(b.done, plan.ops, `seed ${seed}: done list must be in plan order`);
    // nothing started before everything it depends on had finished
    const deps = opDependencies(plan.ops);
    plan.ops.forEach((op, j) => deps[j].forEach((i) => {
      const dj = parRoot.started.get(`${op.from}>${op.to}`); const di = parRoot.ended.get(`${plan.ops[i].from}>${plan.ops[i].to}`);
      assert.ok(di < dj, `seed ${seed}: op ${j} started before op ${i} finished`);
    }));
    peak = Math.max(peak, parRoot.peak);
    // and undoing in parallel restores every file to where it was
    const undo = await executeOpsParallel(parRoot, reverseOps(b.done), { concurrency: 6 });
    assert.equal(undo.error, null, `seed ${seed}: undo failed: ${undo.error?.message}`);
    assert.deepEqual(parRoot.snapshot(), new SlowRoot(paths, rng(1)).snapshot(), `seed ${seed}: undo did not restore`);
  }
  assert.ok(peak > 1, 'it should really run several at once');
  console.log(`   up to ${peak} renames in flight at once`);
});

await t('a failure in the middle leaves an exact undo (40 random trees)', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed * 7);
    const { paths, entries } = makeTree(rand);
    const plan = buildPlan(entries, makeProposals(entries, rand), {});
    if (plan.ops.length < 4) continue;
    const bad = plan.ops[Math.floor(rand() * plan.ops.length)];
    const root = new SlowRoot(paths, rng(seed), { failOn: `${bad.from}>${bad.to}` });
    const r = await executeOpsParallel(root, plan.ops, { concurrency: 6 });
    assert.ok(r.error, `seed ${seed}: expected an error`);
    // done is closed under dependencies, so reversing exactly `done` is a valid undo
    const deps = opDependencies(plan.ops); const doneSet = new Set(r.doneIdx);
    for (const j of doneSet) for (const i of deps[j]) assert.ok(doneSet.has(i), `seed ${seed}: op ${j} done but its dependency ${i} is not`);
    root.failOn = null;
    const undo = await executeOps(root, reverseOps(r.done));
    assert.equal(undo.error, null, `seed ${seed}: ${undo.error?.message}`);
    assert.deepEqual(root.snapshot(), new SlowRoot(paths, rng(1)).snapshot(), `seed ${seed}: undo after failure did not restore`);
  }
});

await t('Stop part way: finished work is reported exactly and can be undone (40 random trees)', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rand = rng(seed * 13);
    const { paths, entries } = makeTree(rand);
    const plan = buildPlan(entries, makeProposals(entries, rand), {});
    if (plan.ops.length < 6) continue;
    const ctl = new AbortController(); const stopAt = 1 + Math.floor(rand() * (plan.ops.length - 2));
    const root = new SlowRoot(paths, rng(seed));
    const r = await executeOpsParallel(root, plan.ops, { concurrency: 5, signal: ctl.signal, onStep: (n) => { if (n === stopAt) ctl.abort(); } });
    assert.equal(r.error?.message, 'Cancelled', `seed ${seed}`);
    assert.ok(r.done.length >= stopAt && r.done.length < plan.ops.length, `seed ${seed}: ${r.done.length} done of ${plan.ops.length}`);
    assert.equal(root.running, 0, 'nothing may still be running when it returns');
    const undo = await executeOps(root, reverseOps(r.done));
    assert.equal(undo.error, null);
    assert.deepEqual(root.snapshot(), new SlowRoot(paths, rng(1)).snapshot(), `seed ${seed}: undo after Stop did not restore`);
  }
});

await t('numbering: "Add numbers" gives each file the same number in parallel as one by one', async () => {
  const paths = []; for (const d of ['One', 'Two', 'Three']) { paths.push(d); for (let i = 0; i < 120; i++) paths.push(`${d}/song ${i}.mp3`); }
  const entries = paths.map((p) => ({ path: p, name: p.split('/').pop(), isDir: !p.includes('/') }));
  const files = entries.filter((e) => !e.isDir).map((e) => ({ ...e, mtime: 0, size: 1 }));
  const { names } = runPipeline(files, [makeRule('number', { position: 'prefix', sep: ' - ', pad: 3, perFolder: true })], { scope: 'files' });
  const plan = buildPlan(entries, names, {});
  const seq = new SlowRoot(paths, rng(5)); const par = new SlowRoot(paths, rng(6));
  await executeOps(seq, plan.ops); const res = await executeOpsParallel(par, plan.ops, { concurrency: 8 });
  assert.equal(res.error, null);
  assert.deepEqual(par.snapshot(), seq.snapshot());
  // every file kept its place in the sequence: song 0 is 001, song 1 is 002 ... inside each folder
  for (const [k, e] of par.map) { const m = /^(\w+)\/(\d{3}) - song (\d+)\.mp3$/.exec(k); if (m) assert.equal(Number(m[2]), Number(m[3]) + 1, `${k} (was ${e.id})`); }
});

await t('interrupted undo file: only finished steps are undone, the rest can be resumed', () => {
  const m = { status: 'in-progress', operations: [{ kind: 'file', from: 'a', to: 'b' }, { kind: 'file', from: 'c', to: 'd' }, { kind: 'file', from: 'e', to: 'f' }], doneIdx: [2, 0] };
  normaliseInterrupted(m);
  assert.deepEqual(m.operations.map((o) => o.from), ['a', 'e']);
  assert.deepEqual(m.remaining.map((o) => o.from), ['c']);
  assert.equal(m.status, 'partial'); assert.equal(m.interrupted, true); assert.equal(m.doneIdx, undefined);
});

await t('jobs: progress, Stop, one job per folder, idle notification', async () => {
  const root = {}; const other = {};
  let release; const gate = new Promise((r) => { release = r; });
  const job = startJob({ kind: 'rename', title: 'x', root, total: 10, run: async (ctx) => { ctx.set(3, 10, 'three'); await gate; return { status: 'done', message: 'ok' }; } });
  assert.ok(hasRunning()); assert.equal(activeFor(root), job); assert.equal(activeFor(other), null);
  assert.equal(await conflictFor(root), job);
  assert.equal(job.done, 3); assert.equal(job.label, 'three');
  let idle = false; whenIdle().then(() => { idle = true; });
  await sleep(5); assert.equal(idle, false, 'not idle while a job runs');
  release(); const res = await job.promise;
  assert.equal(res.status, 'done'); assert.equal(job.status, 'done'); assert.ok(!hasRunning());
  await sleep(5); assert.equal(idle, true);
  const stopper = startJob({ kind: 'rename', title: 's', root, total: 5, run: async (ctx) => { for (let i = 0; i < 5 && !ctx.cancelled; i++) { ctx.set(i, 5); await sleep(5); } return { status: 'done' }; } });
  await sleep(8); cancelJob(stopper);
  assert.equal((await stopper.promise).status, 'cancelled');
  const failing = startJob({ kind: 'rename', title: 'f', root, run: async () => { throw new Error('boom'); } });
  assert.equal((await failing.promise).status, 'error');
});

await t('pool: respects the limit and the memory budget, keeps result order, honours stop', async () => {
  let cur = 0; let peak = 0; let heavy = 0; let heavyPeak = 0;
  const items = Array.from({ length: 40 }, (_, i) => ({ i, w: i % 5 === 0 ? 100 : 10 }));
  const out = await runPool(items, async (it) => { cur++; heavy += it.w; peak = Math.max(peak, cur); heavyPeak = Math.max(heavyPeak, heavy); await sleep(Math.random() * 4); cur--; heavy -= it.w; return it.i * 2; },
    { limit: 4, weight: (it) => it.w, maxWeight: 150 });
  assert.equal(peak <= 4, true); assert.ok(heavyPeak <= 150, `memory budget exceeded: ${heavyPeak}`);
  assert.deepEqual(out.map((r) => r.value), items.map((it) => it.i * 2));
  let started = 0;
  const stopped = await runPool(items, async () => { started++; await sleep(2); }, { limit: 2, shouldStop: () => started >= 6 });
  assert.ok(started >= 6 && started <= 8 && stopped.filter(Boolean).length === started);
});

await t('tags: 36 files saved at the same time each keep their own tags', async () => {
  const dir = new URL('./fixtures/', import.meta.url);
  const kinds = ['t.mp3', 't.flac', 'fast.m4a', 't.ogg', 't.opus', 't.wav', 't.aiff'];
  const jobs = [];
  for (let i = 0; i < 36; i++) {
    const n = kinds[i % kinds.length];
    jobs.push({ i, n, file: new File([readFileSync(new URL(n, dir))], `${i}-${n}`) });
  }
  for (const j of jobs) { j.model = await readTags(j.file); Object.assign(j.model.fields, { title: `Title #${j.i}`, artist: `Artist ${j.i % 5}`, track: String(j.i + 1), album: `Album ${j.i % 3}` }); }
  const res = await runPool(jobs, async (j) => {
    await sleep(Math.random() * 6);
    const { blob } = await writeTagsOffThread(j.file, j.model, { id3Version: 3, id3v1: 'update' });
    return new File([await blob.arrayBuffer()], j.file.name);
  }, { limit: 6 });
  for (const j of jobs) {
    assert.ok(res[j.i].ok, `${j.n}: ${res[j.i].error?.message}`);
    const back = await readTags(res[j.i].value);
    assert.equal(back.fields.title, `Title #${j.i}`, `file ${j.i} (${j.n}) has someone else's title`);
    assert.equal(back.fields.artist, `Artist ${j.i % 5}`);
    assert.equal(String(parseInt(back.fields.track, 10)), String(j.i + 1), `file ${j.i} track number`);
    assert.equal(back.fields.album, `Album ${j.i % 3}`);
  }
});

console.log(`parallel: ${pass} checks passed`);
