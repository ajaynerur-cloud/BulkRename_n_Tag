// Runs one recipe on one folder as its own background job. Many of these can run at the same time:
// each touches only the files directly inside its folder, and jobs.js refuses two jobs on the same folder.
import { basename, dirname } from '../core/utils.js';
import { executeOpsParallel } from '../core/planner.js';
import { startJob, runPool, memoryBudget, conflictFor } from '../core/jobs.js';
import { createRenameManifest, createTagManifest, manifestFileName } from '../core/manifest.js';
import { addHistory, updateHistory } from '../core/history.js';
import { readTags, writeTags, planMp3Patch, AUDIO_EXT } from '../tagger/index.js';
import { cloneModel, picturesEqual } from '../tagger/model.js';
import { writeTagsOffThread } from '../tagger/pool.js';
import { hasRename, hasTags, needsTagRead, planTagEdits, planFolderRename, entriesIn } from './recipes.js';

const nf = (n) => Number(n).toLocaleString('en-US');
const MAX_FILES_IN_MEMORY = 6;
const fieldsOf = (m) => ({ ...m.fields, bitrate: m.props?.bitrate, duration: m.props?.duration, sampleRate: m.props?.sampleRate, codec: m.props?.codec });

/** A stand-in "source" for the job tray: the whole source object plus the one folder this job works in. */
export const scopeFor = (root, dir) => ({ scopeOf: root, dir, kind: root.kind, name: dir ? basename(dir) : root.name });

/** Can this folder be started right now? (A job from another screen on the same folder blocks it.) */
export async function folderBusy(root, dir) { return conflictFor(scopeFor(root, dir)); }

/**
 * startFolderJob({ root, entries, dir, recipe, opts, tagOpts, label }) -> job
 * `entries` is the full scan of `root`. The job resolves like any job; result.details lists problems.
 */
export function startFolderJob({ root, entries, dir, recipe, opts = {}, tagOpts = { id3Version: 3, id3v1: 'keep' }, label = '', onFinish = null }) {
  const files = entriesIn(entries, dir).filter((e) => !e.isDir);
  const audio = files.filter((e) => AUDIO_EXT.test(e.name));
  const wantTags = hasTags(recipe) && audio.length > 0;
  const wantRename = hasRename(recipe);
  const folderLabel = label || (dir ? basename(dir) : root.name) || 'Folder';
  const scope = scopeFor(root, dir);
  const job = startJob({
    kind: 'batch', title: `${folderLabel}: ${recipe.name}`, root: scope, total: Math.max(1, (wantTags ? audio.length : 0) + (wantRename ? files.length : 0)),
    run: async (ctx) => {
      const details = []; let tagsDone = 0; let renamed = 0; let stoppedEarly = false;
      const readFields = new Map();
      const models = new Map();
      ctx.set(0, null, 'Starting…');
      let step = 0; const total = () => (wantTags ? audio.length : 0) + (wantRename ? files.length : 0);

      /* ---- tags ---- */
      if (wantTags || (wantRename && needsTagRead(recipe))) {
        const toRead = wantTags ? audio : audio; // renaming from tags needs them as well
        await runPool(toRead, async (e) => {
          try { const f = await (e.getFile ? e.getFile() : root.getFile(e.path)); const m = await readTags(f); models.set(e.path, m); readFields.set(e.path, fieldsOf(m)); } catch (err) { readFields.set(e.path, null); if (wantTags) details.push(`${e.name}: ${err.message}`); }
        }, { limit: root.isSaf ? 6 : 3, shouldStop: () => ctx.cancelled });
      }
      if (wantTags && !ctx.cancelled) {
        const edits = planTagEdits(audio.filter((e) => models.has(e.path)), recipe.tags, new Map([...models].map(([p, m]) => [p, m.fields])), root.name);
        const targets = audio.filter((e) => edits.has(e.path)).map((e) => {
          const orig = models.get(e.path); const model = cloneModel(orig);
          for (const [k, v] of Object.entries(edits.get(e.path))) model.fields[k] = v;
          return { e, path: e.path, name: e.name, orig, model, size: e.size || 0 };
        });
        step += audio.length - targets.length; // untouched files count as done
        if (targets.length) {
          const manifest = createTagManifest({ root: root.name, source: root.kind, options: { ...tagOpts, recipe: recipe.name }, files: targets.map((t) => ({ path: t.path, format: t.model.format, before: { fields: t.orig.fields, custom: t.orig.custom, pictures: null }, after: { fields: t.model.fields, custom: t.model.custom, pictures: null } })) });
          const mName = manifestFileName('tags');
          let wrote = false;
          try { await root.writeText(mName, JSON.stringify(manifest, null, 2)); wrote = true; } catch { /* kept in History */ }
          await addHistory({ id: manifest.id, type: 'tags', createdAt: manifest.createdAt, rootName: root.name, source: root.kind, manifestName: mName, manifest, handle: root.handle || null, status: 'in-progress' });
          const errors = []; const saved = [];
          await runPool(targets, async (it) => {
            try {
              let patched = false;
              if (root.canPatch && /\.mp3$/i.test(it.path)) {
                try { const lazy = root.lazyFile(it.path); const plan = lazy && await planMp3Patch(lazy, it.model, tagOpts); if (plan) { await root.writeAt(it.path, plan.writes, lazy.size); patched = true; } } catch (err) { if (/size while patching/.test(err.message)) throw err; }
              }
              if (!patched) { const file = root.getFullFile ? await root.getFullFile(it.path) : await it.e.getFile(); const { blob } = await writeTagsOffThread(file, it.model, tagOpts); await root.writeFile(it.path, blob); }
              saved.push(it.path); tagsDone++;
              readFields.set(it.path, fieldsOf(it.model));
            } catch (err) { errors.push(`${it.name}: ${err.message}`); }
            ctx.set(++step, total(), it.name);
          }, { limit: root.isSaf ? 6 : 3, weight: (it) => (root.canPatch && /\.mp3$/i.test(it.path) ? Math.min(it.size, 1 << 20) : it.size), maxWeight: MAX_FILES_IN_MEMORY, budget: memoryBudget, shouldStop: () => ctx.cancelled });
          manifest.status = errors.length || saved.length < targets.length ? 'partial' : 'complete';
          manifest.completed = saved.length; manifest.savedPaths = saved; if (errors.length) manifest.errors = errors;
          try { if (wrote) await root.writeText(mName, JSON.stringify(manifest, null, 2)); } catch { /* ignore */ }
          await updateHistory(manifest.id, { manifest, status: manifest.status });
          details.push(...errors);
        } else ctx.set(step, total(), 'Tags already match');
      } else if (wantTags) step += audio.length;
      if (ctx.cancelled) stoppedEarly = true;

      /* ---- rename ---- */
      if (wantRename && !stoppedEarly) {
        const tagsByPath = new Map([...readFields].filter(([, v]) => v));
        const plan = planFolderRename({ entries, dir, rules: recipe.rules, tagsByPath, rootName: root.name, opts });
        for (const er of plan.errors) details.push(`Rule problem: ${er.msg}`);
        const ops = plan.ops;
        step += files.length - ops.length;
        if (ops.length) {
          root.allowCopyFallback = !!opts.copyFallback;
          const manifest = createRenameManifest({ root: root.name, source: root.kind, ops, stats: plan.stats, tool: 'renamer', rules: recipe.rules.filter((r) => r.enabled !== false).map(({ type, opts: o }) => ({ type, opts: o })) });
          const mName = manifestFileName('rename');
          let wrote = false;
          manifest.operations = ops; manifest.status = 'in-progress';
          try { await root.writeText(mName, JSON.stringify(manifest, null, 2)); wrote = true; } catch { /* kept in History */ }
          await addHistory({ id: manifest.id, type: 'rename', createdAt: manifest.createdAt, rootName: root.name, source: root.kind, manifestName: mName, manifest, handle: root.handle || null, status: 'in-progress' });
          const live = new Set(); let saving = false; let lastSaved = -1;
          const checkpoint = async () => { if (!wrote || saving || live.size === lastSaved) return; saving = true; lastSaved = live.size; try { await root.writeText(mName, JSON.stringify({ ...manifest, doneIdx: [...live] })); } catch { /* final write reports */ } saving = false; };
          const timer = setInterval(checkpoint, Math.max(2000, Math.min(15000, ops.length * 0.2)));
          const res = await executeOpsParallel(root, ops, { concurrency: root.maxConcurrency, signal: ctx.signal, onStep: (count, op, idx) => { live.add(idx); renamed = count; ctx.set(step + count, total(), basename(op.to)); } });
          clearInterval(timer); while (saving) await new Promise((r) => setTimeout(r, 5));
          renamed = res.done.length;
          manifest.operations = res.done.map((o) => ({ kind: o.kind, from: o.from, to: o.to }));
          delete manifest.doneIdx; delete manifest.interrupted;
          manifest.status = res.error ? 'partial' : 'complete'; manifest.completed = res.done.length; manifest.planned = ops.length;
          const doneSet = new Set(res.doneIdx);
          const left = ops.filter((_, i) => !doneSet.has(i)).map(({ kind, from, to }) => ({ kind, from, to }));
          if (left.length) manifest.remaining = left; else delete manifest.remaining;
          if (res.error) { manifest.error = res.error.message; details.push(res.error.message); }
          try { if (wrote) await root.writeText(mName, JSON.stringify(manifest, null, 2)); } catch { /* ignore */ }
          await updateHistory(manifest.id, { manifest, status: manifest.status });
          if (res.error?.message === 'Cancelled') stoppedEarly = true;
        }
      }
      const bits = [];
      if (wantTags) bits.push(`tags changed in ${nf(tagsDone)} file${tagsDone === 1 ? '' : 's'}`);
      if (wantRename) bits.push(`${nf(renamed)} file${renamed === 1 ? '' : 's'} renamed`);
      const msg = bits.length ? bits.join(', ') : 'Nothing to do';
      const res = { status: stoppedEarly ? 'partial' : details.length ? 'partial' : 'done', details, message: stoppedEarly ? `Stopped: ${msg}. Undo files cover what was done.` : `${msg.charAt(0).toUpperCase()}${msg.slice(1)}.`, tagsDone, renamed };
      return res;
    },
  });
  if (onFinish) job.promise.then((r) => onFinish(r, job));
  return job;
}
export { dirname };
