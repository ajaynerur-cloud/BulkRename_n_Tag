// Analyzes a set of names: detects the current pattern, finds problems and proposes new patterns
// as ready-to-apply rule sets.
import { splitName, commonPrefix, commonSuffix } from '../core/utils.js';
import { makeRule, runPipeline, parseDateToken } from './rules.js';

const AUDIO = new Set(['mp3', 'flac', 'm4a', 'm4b', 'mp4', 'aac', 'ogg', 'oga', 'opus', 'wav', 'aif', 'aiff', 'wma', 'ape', 'wv']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'heic', 'heif', 'gif', 'webp', 'tif', 'tiff', 'raw', 'cr2', 'cr3', 'nef', 'arw', 'dng', 'orf', 'rw2']);
const VIDEO = new Set(['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'mts', '3gp']);
const CAMERA = /^(IMG|DSC|DSCN|DSCF|PXL|VID|MVIMG|PANO|GOPR|GH\d{2}|DJI|P\d{7}|Screenshot|Screen Shot|WhatsApp (?:Image|Video)|signal-|photo|image)[_\- ]/i;
const QUALITY = /\b(?:2160p|1080p|720p|480p|4k|x26[45]|h\.?26[45]|hevc|web-?dl|web-?rip|blu-?ray|bdrip|dvdrip|hdtv|320\s?kbps|official[\s_]+(?:music[\s_]+)?video|official[\s_]+audio|lyrics?[\s_]+video)\b/i;
const URLISH = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|ru|to|cc)\b/i;
const DUP = /\s*\(\d+\)$|\s*-\s*copy(?:\s*\(\d+\))?$|^copy of\s|\s+copy$/i;
const DATE = /(?<!\d)(?:(?:19|20)\d{2}[-_. ]?(?:0[1-9]|1[0-2])[-_. ]?(?:0[1-9]|[12]\d|3[01])|(?:0?[1-9]|[12]\d|3[01])[-_.](?:0?[1-9]|1[0-2])[-_.](?:19|20)\d{2})(?!\d)/;

const pct = (a, b) => (b ? a / b : 0);

function caseStyle(bases) {
  const letters = bases.filter((b) => /\p{L}/u.test(b));
  if (!letters.length) return 'none';
  const lower = letters.filter((b) => b === b.toLowerCase()).length;
  const upper = letters.filter((b) => b === b.toUpperCase()).length;
  const title = letters.filter((b) => b.split(/[\s_\-]+/).filter((w) => /^\p{L}/u.test(w)).every((w) => /^\p{Lu}/u.test(w))).length;
  const n = letters.length;
  if (pct(lower, n) > 0.8) return 'lower';
  if (pct(upper, n) > 0.8) return 'upper';
  if (pct(title, n) > 0.8) return 'title';
  return 'mixed';
}

function classify(values) {
  const n = values.length;
  const nums = values.filter((v) => /^\d+$/.test(v));
  if (pct(nums.length, n) >= 0.8) {
    const widths = new Set(nums.map((v) => v.length));
    return { type: 'number', width: Math.max(...nums.map((v) => v.length)), padded: nums.some((v) => v.length > 1 && v.startsWith('0')), mixedWidth: widths.size > 1 };
  }
  if (values.every((v) => v === values[0])) return { type: 'const', value: values[0] };
  if (pct(values.filter((v) => DATE.test(v) && v.replace(DATE, '').length <= 2).length, n) >= 0.8) return { type: 'date' };
  const cp = commonPrefix(values);
  if (cp.length >= 2 && values.every((v) => /^\d+$/.test(v.slice(cp.length)))) return { type: 'prefixed-number', prefix: cp, width: Math.max(...values.map((v) => v.length - cp.length)) };
  return { type: 'text' };
}

/** Detect a readable pattern like "[##] - [text]" or "IMG_[####]" */
export function detectPattern(bases) {
  if (!bases.length) return { pattern: '', sep: null, fields: [] };
  const seps = [' - ', ' – ', '_', ' . ', '. ', '-', '.', ' '];
  let best = null;
  for (const sep of seps) {
    const has = bases.filter((b) => b.includes(sep)).length;
    if (pct(has, bases.length) < 0.7) continue;
    const counts = new Map();
    for (const b of bases) { const c = b.split(sep).length; counts.set(c, (counts.get(c) || 0) + 1); }
    const [fieldCount, freq] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (pct(freq, bases.length) >= 0.6 && fieldCount <= 8) { best = { sep, fieldCount }; break; }
    if (!best) best = { sep, fieldCount: null };
  }
  const describe = (f) => (f.type === 'number' ? `[${'#'.repeat(Math.max(1, f.width))}]` : f.type === 'const' ? f.value : f.type === 'date' ? '[date]' : f.type === 'prefixed-number' ? `${f.prefix}[${'#'.repeat(f.width)}]` : '[text]');
  if (!best || !best.fieldCount) {
    // leading number without separator?
    const lead = bases.filter((b) => /^\d+/.test(b)).length;
    if (pct(lead, bases.length) >= 0.7) return { pattern: `[${'#'.repeat(Math.max(...bases.map((b) => (b.match(/^\d+/) || [''])[0].length)))}][text]`, sep: null, fields: [] };
    const single = classify(bases);
    return { pattern: describe(single), sep: null, fields: [single] };
  }
  const rows = bases.map((b) => b.split(best.sep)).filter((r) => r.length === best.fieldCount);
  const fields = [];
  for (let i = 0; i < best.fieldCount; i++) fields.push(classify(rows.map((r) => r[i])));
  // merge consecutive text fields separated by spaces into one
  let parts = fields.map(describe);
  if (best.sep === ' ') parts = parts.reduce((acc, p) => { if (p === '[text]' && acc[acc.length - 1] === '[text]') return acc; acc.push(p); return acc; }, []);
  return { pattern: parts.join(best.sep), sep: best.sep, fields, consistent: pct(rows.length, bases.length) };
}

export function analyze(entries, { scope = 'files' } = {}) {
  const items = entries.filter((e) => (scope === 'both' ? true : scope === 'dirs' ? e.isDir : !e.isDir));
  const split = items.map((e) => ({ e, ...splitName(e.name, e.isDir) }));
  const bases = split.map((s) => s.base);
  const n = bases.length;
  const findings = []; const suggestions = [];
  if (!n) return { count: 0, detected: detectPattern([]), findings, suggestions, proposed: '' };
  const add = (level, text) => findings.push({ level, text });

  const detected = detectPattern(bases);
  const exts = new Map(); for (const s of split) if (s.ext) { const k = s.ext.toLowerCase(); exts.set(k, (exts.get(k) || 0) + 1); }
  const audio = split.filter((s) => AUDIO.has(s.ext.toLowerCase())).length;
  const images = split.filter((s) => IMAGE.has(s.ext.toLowerCase())).length;
  const videos = split.filter((s) => VIDEO.has(s.ext.toLowerCase())).length;

  const underscores = bases.filter((b) => b.includes('_')).length;
  const dots = bases.filter((b) => /(?<!\d)\.(?!\d)/.test(b)).length;
  const encoded = bases.filter((b) => /%[0-9a-f]{2}/i.test(b)).length;
  const doubleSpace = bases.filter((b) => /\s{2,}|^\s|\s$/.test(b)).length;
  const dup = bases.filter((b) => DUP.test(b)).length;
  const quality = bases.filter((b) => QUALITY.test(b)).length;
  const urls = bases.filter((b) => URLISH.test(b)).length;
  const brackets = bases.filter((b) => /\[[^\]]*\]|\([^)]*\)/.test(b)).length;
  const camera = bases.filter((b) => CAMERA.test(b)).length;
  const dated = bases.filter((b) => DATE.test(b)).length;
  const invalid = bases.filter((b) => /[<>:"\\|?*]/.test(b)).length;
  const nonAscii = bases.filter((b) => /[^\x00-\x7F]/.test(b)).length;
  const emoji = bases.filter((b) => /\p{Extended_Pictographic}/u.test(b)).length;
  const long = items.filter((e) => e.name.length > 120).length;
  const cs = caseStyle(bases);
  const leadNums = bases.map((b) => b.match(/^\s*(?:(?:cd|disc)\s*\d+\s*[-_.]?\s*)?(\d{1,4})(?=[\s._\-)\]]|\p{Lu})/iu)).filter(Boolean);
  const trailNums = bases.filter((b) => /[\s_\-(]\d{1,5}\)?$/.test(b)).length;
  const cp = n >= 3 ? commonPrefix(bases) : ''; const cpClean = (cp.match(/^.*[\s_\-.)\]]/) || [''])[0];
  const csf = n >= 3 ? commonSuffix(bases) : ''; const csClean = (csf.match(/[\s_\-.(\[].*$/) || [''])[0];

  add('info', `${n} ${scope === 'dirs' ? 'folder' : 'item'}${n === 1 ? '' : 's'}. Detected pattern: ${detected.pattern || 'no common pattern'}${detected.consistent && detected.consistent < 1 ? ` (${Math.round(detected.consistent * 100)}% follow it)` : ''}.`);
  if (exts.size) add('info', `Extensions: ${[...exts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `.${k} ×${v}`).join(', ')}.`);

  // numbering
  let numInfo = null;
  if (pct(leadNums.length, n) >= 0.6) {
    const vals = leadNums.map((m) => +m[1]); const widths = new Set(leadNums.map((m) => m[1].length));
    const sorted = [...vals].sort((a, b) => a - b); const set = new Set(vals);
    const gaps = []; for (let v = sorted[0]; v <= sorted[sorted.length - 1] && gaps.length < 20; v++) if (!set.has(v)) gaps.push(v);
    const dups = vals.length - set.size;
    numInfo = { min: sorted[0], max: sorted[sorted.length - 1], mixedWidth: widths.size > 1, gaps, dups };
    add(numInfo.mixedWidth || gaps.length || dups ? 'warn' : 'ok', `Leading numbers ${numInfo.min}–${numInfo.max}${numInfo.mixedWidth ? ', inconsistent padding (sorts wrong: 1, 10, 2)' : ''}${gaps.length ? `, missing ${gaps.slice(0, 8).join(', ')}${gaps.length > 8 ? '…' : ''}` : ''}${dups ? `, ${dups} duplicate${dups > 1 ? 's' : ''}` : ''}.`);
  }
  if (underscores && pct(underscores, n) > 0.3 && !camera) add('warn', `${underscores} name${underscores > 1 ? 's use' : ' uses'} underscores instead of spaces.`);
  if (encoded) add('warn', `${encoded} name${encoded > 1 ? 's contain' : ' contains'} URL escapes like %20.`);
  if (doubleSpace) add('warn', `${doubleSpace} name${doubleSpace > 1 ? 's have' : ' has'} double or leading/trailing spaces.`);
  if (dup) add('warn', `${dup} duplicate marker${dup > 1 ? 's' : ''} like "(1)" or "- Copy".`);
  if (quality) add('warn', `${quality} name${quality > 1 ? 's contain' : ' contains'} release/quality tags.`);
  if (urls) add('warn', `${urls} name${urls > 1 ? 's contain' : ' contains'} website names.`);
  if (invalid) add('error', `${invalid} name${invalid > 1 ? 's contain' : ' contains'} characters that are invalid on Windows.`);
  if (long) add('warn', `${long} name${long > 1 ? 's are' : ' is'} longer than 120 characters.`);
  if (emoji) add('info', `${emoji} name${emoji > 1 ? 's contain' : ' contains'} emoji.`);
  if (cpClean && cpClean.trim().length >= 2) add('info', `All names start with "${cpClean}".`);
  if (csClean && csClean.trim().length >= 2) add('info', `All names end with "${csClean}".`);
  if (camera) add('info', `${camera} camera/phone style name${camera > 1 ? 's' : ''} (IMG_, PXL_, Screenshot…).`);
  if (cs !== 'mixed' && cs !== 'none') add('info', `Case style: ${cs === 'lower' ? 'all lowercase' : cs === 'upper' ? 'ALL UPPERCASE' : 'Title Case'}.`);
  else if (cs === 'mixed') add('info', 'Case style is mixed.');
  const extCase = [...exts.keys()].length !== new Set(split.map((s) => s.ext)).size - (split.some((s) => !s.ext) ? 1 : 0);
  const mixedExtCase = split.some((s) => s.ext && s.ext !== s.ext.toLowerCase());
  if (mixedExtCase) add('warn', 'Some extensions are uppercase (.JPG, .MP3).');
  if (exts.has('jpeg') && exts.has('jpg')) add('info', 'Both .jpg and .jpeg are used.');
  void extCase;

  // ---------- suggestions
  const cleanupOpts = {
    underscores: pct(underscores, n) > 0.3 && pct(camera, n) <= 0.5,
    dots: pct(dots, n) > 0.5 && !/\s/.test(bases.join('')),
    urlDecode: true, dupMarkers: true, fixSpacing: true, windows: 'replace',
    dashes: bases.some((b) => /\S-\s|\s-\S/.test(b)) ? 'spaced' : 'keep',
  };
  const needsStrip = quality || urls;
  const recommended = [];
  if (underscores || encoded || doubleSpace || dup || invalid || cleanupOpts.dots || cleanupOpts.dashes === 'spaced') recommended.push(makeRule('cleanup', cleanupOpts));
  if (needsStrip) recommended.push(makeRule('strip', { leading: false, quality: !!quality, urls: !!urls }));
  if (cs === 'lower' || cs === 'upper' || (cs === 'mixed' && pct(underscores, n) > 0.5)) {
    if (!(camera > n / 2)) recommended.push(makeRule('case', { mode: 'title' }));
  }
  if (numInfo && (numInfo.mixedWidth || numInfo.gaps.length)) {
    recommended.push(makeRule('strip', { leading: true }));
    recommended.push(makeRule('number', { position: 'prefix', sep: detected.sep && detected.sep.trim() ? detected.sep : ' - ', pad: 0 }));
  }
  if (mixedExtCase) recommended.push(makeRule('extension', { mode: 'lower' }));
  if (recommended.length) suggestions.push({ id: 'recommended', title: 'Recommended clean-up', why: 'Fixes the issues found above while keeping your names recognisable.', rules: recommended, recommended: true });

  if (numInfo) {
    suggestions.push({ id: 'renumber', title: 'Renumber consistently', why: `Removes the current numbers and numbers ${n} items again with even padding so they sort correctly.`, rules: [makeRule('strip', { leading: true }), makeRule('number', { position: 'prefix', sep: ' - ', pad: 0 })] });
    suggestions.push({ id: 'unnumber', title: 'Remove numbering', why: 'Strips track/sequence numbers from the start of names.', rules: [makeRule('strip', { leading: true })] });
  } else if (n > 1) {
    suggestions.push({ id: 'number', title: 'Add track-style numbering', why: 'Prefix names with 01, 02, 03 … in the current order.', rules: [makeRule('number', { position: 'prefix', sep: ' - ', pad: 0 })] });
  }
  if (audio && pct(audio, n) >= 0.5) {
    suggestions.push({ id: 'tags-track-title', title: 'Name from tags: 01 - Title', why: 'Uses the audio tags (track number and title). Files without tags keep their name.', rules: [makeRule('template', { tpl: '{track:2} - {title}' })], needsTags: true });
    suggestions.push({ id: 'tags-artist-title', title: 'Name from tags: Artist - Title', why: 'Good for mixed playlists and singles.', rules: [makeRule('template', { tpl: '{artist} - {title}' })], needsTags: true });
    if (detected.sep === ' - ' && detected.fields.length === 2 && detected.fields.every((f) => f.type === 'text')) {
      suggestions.push({ id: 'swap', title: 'Swap "Title - Artist" order', why: 'Names have two text parts; swap them if artist and title are reversed.', rules: [makeRule('swap', { sep: ' - ', order: '2,1' })] });
    }
  }
  if ((images + videos) && (camera || dated)) {
    suggestions.push({ id: 'photo-date', title: 'Photos by date', why: 'Names like 2024-05-01 14.32.10 sort chronologically everywhere. Uses file modified date.', rules: [makeRule('template', { tpl: '{mdate:YYYY-MM-DD HH.mm.ss}' }), makeRule('extension', { mode: 'normalize' }), makeRule('extension', { mode: 'lower' })] });
  }
  if (dated && !camera) {
    const sample = bases.find((b) => DATE.test(b)); const m = sample && sample.match(DATE); const ok = m && parseDateToken(m[0]);
    if (ok) suggestions.push({ id: 'date-iso', title: 'Standardise dates to YYYY-MM-DD', why: 'ISO dates sort correctly and are unambiguous.', rules: [makeRule('date', { mode: 'reformat', fmt: 'YYYY-MM-DD' })] });
  }
  if (cpClean.trim().length >= 2 || csClean.trim().length >= 2) {
    suggestions.push({ id: 'common', title: 'Remove shared prefix/suffix', why: `Removes text repeated in every name${cpClean ? ` ("${cpClean.trim()}")` : ''}.`, rules: [makeRule('strip', { leading: false, commonPrefix: !!cpClean.trim(), commonSuffix: !!csClean.trim() })] });
  }
  if (brackets && pct(brackets, n) > 0.3) suggestions.push({ id: 'brackets', title: 'Remove bracketed text', why: 'Drops things like [HD], (Remastered 2011), (1).', rules: [makeRule('cleanup', { brackets: 'all', underscores: false, dupMarkers: true })] });
  suggestions.push({ id: 'sequence', title: 'Sequential: Folder name 001', why: 'Replaces names with the parent folder name and a counter.', rules: [makeRule('template', { tpl: '{parent} {n:3}' })] });
  suggestions.push({ id: 'slug', title: 'Web-safe slug', why: 'lowercase-with-dashes, no accents or spaces — ideal for websites and servers.', rules: [makeRule('cleanup', { accents: 'translit', emoji: true, windows: 'remove', underscores: true }), makeRule('remove', { mode: 'nonalnum' }), makeRule('case', { mode: 'kebab', ext: 'lower' })] });
  if (nonAscii) suggestions.push({ id: 'ascii', title: 'Transliterate to ASCII', why: 'Converts accents and non-Latin scripts (é→e, Ж→Zh) for older devices and car stereos.', rules: [makeRule('cleanup', { accents: 'translit', underscores: false })] });

  // Proposed pattern = detected pattern after applying the top suggestion
  let proposed = detected.pattern;
  const top = suggestions.find((s) => !s.needsTags) || suggestions[0];
  if (top) {
    const sample = items.slice(0, 400);
    const { names } = runPipeline(sample, top.rules, { scope, rootName: '' });
    proposed = detectPattern(sample.map((e) => splitName(names.get(e.path) ?? e.name, e.isDir).base)).pattern || proposed;
    top.proposed = proposed;
  }
  return { count: n, detected, findings, suggestions, proposed, audio, images, videos };
}
