// Tag tools: Filename → Tag, pattern suggestions, auto numbering, CSV, playlists, cover helpers.
import { splitName, escapeRegex, dirname, basename, naturalCompare, toCSV, parseCSV, formatDuration } from '../core/utils.js';
import { detectPattern } from '../renamer/analyzer.js';
import { FIELDS, FIELD_KEYS } from './model.js';

export const PATTERN_FIELDS = [...FIELD_KEYS, 'dummy'];

/** Compile "%track% - %artist% - %title%" (may contain / for folders) into a matcher */
export function compileFilenamePattern(pattern) {
  const keys = []; let src = '';
  const parts = pattern.split(/(%[a-z]+%)/i).filter((p) => p !== '');
  parts.forEach((p, i) => {
    const m = p.match(/^%([a-z]+)%$/i);
    if (m) {
      const k = m[1].toLowerCase(); keys.push(k);
      const isLast = i === parts.length - 1;
      if (['track', 'disc', 'tracktotal', 'disctotal', 'year', 'bpm'].includes(k)) src += '(\\d+)';
      else src += isLast ? '(.+)' : '(.+?)';
    } else src += escapeRegex(p).replace(/\\\//g, '/').replace(/ /g, '\\s*');
  });
  const depth = (pattern.match(/\//g) || []).length;
  return { re: new RegExp(`^${src}$`, 'iu'), keys, depth };
}

/** Parse a path with a compiled pattern. Returns fields or null. */
export function parseFilename(path, compiled) {
  const segs = path.split('/');
  const last = segs.slice(-(compiled.depth + 1));
  last[last.length - 1] = splitName(last[last.length - 1]).base;
  const m = last.join('/').match(compiled.re);
  if (!m) return null;
  const out = {};
  compiled.keys.forEach((k, i) => { if (k !== 'dummy') out[k] = k === 'track' || k === 'disc' ? String(parseInt(m[i + 1], 10)) : m[i + 1].trim(); });
  return out;
}

/** Suggest Filename→Tag patterns based on the detected name pattern */
export function suggestFilenamePatterns(paths) {
  const bases = paths.map((p) => splitName(basename(p)).base);
  const d = detectPattern(bases); const out = [];
  if (d.sep && d.fields.length) {
    const sep = d.sep;
    const types = d.fields.map((f) => f.type);
    const textCount = types.filter((t) => t === 'text').length;
    const textNames = textCount >= 3 ? ['artist', 'album', 'title'] : textCount === 2 ? ['artist', 'title'] : ['title'];
    let ti = 0;
    const pat = d.fields.map((f) => (f.type === 'number' ? '%track%' : f.type === 'text' ? `%${textNames[ti++]}%` : f.type === 'const' ? f.value : f.type === 'date' ? '%year%' : '%dummy%')).join(sep);
    out.push(pat);
    if (textCount === 2) { ti = 0; const alt = ['title', 'artist']; out.push(d.fields.map((f) => (f.type === 'number' ? '%track%' : f.type === 'text' ? `%${alt[ti++]}%` : f.type === 'const' ? f.value : '%dummy%')).join(sep)); }
  }
  const leadNum = bases.filter((b) => /^\d{1,3}[\s._-]/.test(b)).length > bases.length * 0.6;
  if (leadNum) {
    const sample = bases.find((b) => /^\d{1,3}[\s._-]/.test(b));
    const sepm = sample.match(/^\d+(\s*[._-]\s*|\s+)/); const s = sepm ? sepm[1] : ' ';
    out.push(`%track%${s}%title%`);
    if (bases.some((b) => / - /.test(b.replace(/^\d+[\s._-]+/, '')))) out.push(`%track%${s}%artist% - %title%`);
  }
  out.push('%artist% - %title%', '%track% - %title%', '%artist%/%album%/%track% - %title%', '%album%/%track% %title%');
  return [...new Set(out)];
}

/** Expand "%artist% - %title%" style format with field values (for Tag→Tag formatting) */
export function formatFields(fmt, fields) {
  return fmt.replace(/%([a-z]+)(?::(\d+))?%/gi, (m, k, p) => { const v = fields[k.toLowerCase()] ?? ''; return p && /^\d+$/.test(v) ? v.padStart(+p, '0') : v; });
}

/** Auto-number: rows [{path, model}] in current order → Map path -> {track, tracktotal, disc?} */
export function autoNumber(rows, { perFolder = true, start = 1, setTotal = true, discFromFolder = false, sortBy = 'list' } = {}) {
  const groups = new Map();
  for (const r of rows) { const k = perFolder ? dirname(r.path) : ''; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const out = new Map(); let discIdx = 0;
  for (const [dir, g] of groups) {
    discIdx++;
    if (sortBy === 'name') g.sort((a, b) => naturalCompare(basename(a.path), basename(b.path)));
    g.forEach((r, i) => {
      const v = { track: String(start + i) };
      if (setTotal) v.tracktotal = String(g.length);
      if (discFromFolder) { const m = basename(dir).match(/(?:cd|disc|disk)\s*(\d+)/i); v.disc = m ? String(+m[1]) : String(discIdx); v.disctotal = String(groups.size); }
      out.set(r.path, v);
    });
  }
  return out;
}

export const CSV_FIELDS = ['title', 'artist', 'album', 'albumartist', 'track', 'tracktotal', 'disc', 'disctotal', 'year', 'genre', 'composer', 'comment', 'publisher', 'bpm', 'isrc'];

export function exportCSV(rows) {
  const head = ['path', ...CSV_FIELDS, 'duration', 'bitrate', 'format'];
  const data = rows.map((r) => [r.path, ...CSV_FIELDS.map((k) => r.model.fields[k] ?? ''), r.model.props?.duration ? formatDuration(r.model.props.duration) : '', r.model.props?.bitrate ?? '', r.model.format || '']);
  return '\uFEFF' + toCSV([head, ...data]);
}
/** Returns Map path -> fields (only known field columns) */
export function importCSV(text) {
  const rows = parseCSV(text); if (!rows.length) return new Map();
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const pi = head.indexOf('path'); if (pi < 0) throw new Error('CSV needs a "path" column');
  const out = new Map();
  for (const r of rows.slice(1)) {
    const f = {}; head.forEach((h, i) => { if (FIELD_KEYS.includes(h)) f[h] = r[i] ?? ''; });
    out.set(r[pi], f);
  }
  return out;
}

export function buildM3U8(rows) {
  const lines = ['#EXTM3U'];
  for (const r of rows) {
    const d = Math.round(r.model.props?.duration || -1); const f = r.model.fields;
    lines.push(`#EXTINF:${d},${[f.artist, f.title].filter(Boolean).join(' - ') || splitName(basename(r.path)).base}`, r.path);
  }
  return lines.join('\n') + '\n';
}

export const COVER_NAMES = /^(cover|folder|front|albumart(?:small|_\{.*\}_large)?|album|artwork|art)\.(jpe?g|png|webp)$/i;

/** Resize/convert an image to JPEG (browser only). Returns Uint8Array. */
export async function resizeImage(bytes, mime, maxSize = 1000, quality = 0.9) {
  const blob = new Blob([bytes], { type: mime });
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, maxSize / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * scale); const h = Math.round(bmp.height * scale);
  let out;
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h); c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    out = await c.convertToBlob({ type: 'image/jpeg', quality });
  } else {
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h);
    out = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  }
  return { data: new Uint8Array(await out.arrayBuffer()), mime: 'image/jpeg', w, h };
}

export { FIELDS };
