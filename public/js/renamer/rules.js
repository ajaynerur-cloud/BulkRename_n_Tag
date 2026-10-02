// Rule engine for the bulk renamer. Each rule has a schema (for the auto-generated form),
// optional prepare(states, opts) run once per preview, and apply(state, opts, ctx, prepared).
// A state is {base, ext, isDir, path, name, index, dirIndex, dirCount, total, parent, mtime, size, tags, detectedExt}.
import {
  splitName, joinName, formatDate, changeCase, transliterate, stripAccents, escapeRegex, pad, toRoman, toAlpha,
  randomString, uuid, commonPrefix, commonSuffix, formatDuration, naturalCompare, dirname,
} from '../core/utils.js';

/* ------------------------------------------------------------------ template engine */
export const TAG_VARS = ['artist', 'title', 'album', 'albumartist', 'track', 'tracktotal', 'disc', 'disctotal', 'year', 'genre', 'composer', 'comment', 'publisher', 'bitrate', 'duration', 'samplerate', 'codec'];
export const templateUsesTags = (tpl) => new RegExp(`\\{(${TAG_VARS.join('|')})(?=[:|}])`).test(tpl || '');

export function expandTemplate(tpl, st, ctx = {}) {
  if (!tpl) return '';
  return tpl.replace(/\{([a-z]+)(?::([^|}]*))?(?:\|([^}]*))?\}/gi, (m, key, arg, fallback) => {
    let v = templateVar(key.toLowerCase(), arg, st, ctx);
    if (v === undefined) return m; // unknown variable stays literal
    v = v == null ? '' : String(v);
    if (!v && fallback !== undefined) return fallback;
    return v;
  });
}

function templateVar(key, arg, st, ctx) {
  const words = () => st.base.split(/[\s_\-.]+/).filter(Boolean);
  const num = (n) => (arg && /^\d+$/.test(arg) ? pad(n, +arg) : String(n));
  const t = st.tags || {};
  switch (key) {
    case 'name': return st.base;
    case 'original': return splitName(st.name, st.isDir).base;
    case 'fullname': return st.name;
    case 'ext': return st.ext;
    case 'n': return num((ctx.start ?? 1) + st.index);
    case 'dn': return num(1 + st.dirIndex);
    case 'total': return num(st.total);
    case 'parent': {
      const segs = dirname(st.path).split('/').filter(Boolean);
      const lvl = arg && /^\d+$/.test(arg) ? +arg : 1;
      return segs.length >= lvl ? segs[segs.length - lvl] : (lvl === 1 ? ctx.rootName || '' : '');
    }
    case 'root': return ctx.rootName || '';
    case 'path': return dirname(st.path).replace(/\//g, arg || '-');
    case 'mdate': return st.mtime ? formatDate(new Date(st.mtime), arg || 'YYYY-MM-DD') : '';
    case 'now': return formatDate(ctx.now || new Date(), arg || 'YYYY-MM-DD');
    case 'size': return st.size == null ? '' : humanSize(st.size);
    case 'bytes': return st.size ?? '';
    case 'w': {
      const w = words(); let i = +(arg || 1); if (i < 0) i = w.length + i; else i -= 1;
      return w[i] ?? '';
    }
    case 'c': {
      const [a, b] = (arg || '1').split('-').map((x) => +x);
      return st.base.slice(Math.max(0, a - 1), b ? b : a);
    }
    case 'rand': return randomString(+(arg || 6), ctx.rand);
    case 'uuid': return uuid();
    case 'upper': return st.base.toUpperCase();
    case 'lower': return st.base.toLowerCase();
    // tags
    case 'artist': return t.artist ?? '';
    case 'title': return t.title ?? '';
    case 'album': return t.album ?? '';
    case 'albumartist': return t.albumartist || t.artist || '';
    case 'track': return t.track ? num(parseInt(t.track, 10) || t.track) : '';
    case 'tracktotal': return t.tracktotal ?? '';
    case 'disc': return t.disc ? num(parseInt(t.disc, 10) || t.disc) : '';
    case 'disctotal': return t.disctotal ?? '';
    case 'year': return (t.year || '').slice(0, 4);
    case 'genre': return t.genre ?? '';
    case 'composer': return t.composer ?? '';
    case 'comment': return t.comment ?? '';
    case 'publisher': return t.publisher ?? '';
    case 'bitrate': return t.bitrate ? `${t.bitrate}` : '';
    case 'duration': return t.duration ? formatDuration(t.duration).replace(/:/g, arg || '.') : '';
    case 'samplerate': return t.sampleRate ?? '';
    case 'codec': return t.codec ?? '';
    default: return undefined;
  }
}
function humanSize(b) { const u = ['B', 'KB', 'MB', 'GB']; let i = 0; while (b >= 1024 && i < 3) { b /= 1024; i++; } return `${i ? b.toFixed(1) : b}${u[i]}`; }

/* ------------------------------------------------------------------ helpers */
function withTarget(st, target, fn) {
  if (target === 'ext') { st.ext = fn(st.ext); return; }
  if (target === 'full') {
    const full = joinName(st.base, st.ext); const r = fn(full); const s = splitName(r, st.isDir);
    st.base = s.base; st.ext = s.ext; return;
  }
  st.base = fn(st.base);
}
export const collapse = (s) => s.replace(/\s{2,}/g, ' ').trim();

const QUALITY = /\b(?:2160p|1080p|720p|480p|4k|uhd|hdr10?|x26[45]|h\.?26[45]|hevc|avc|web-?dl|web-?rip|blu-?ray|brrip|bdrip|dvdrip|hdtv|aac(?:2\.0)?|ac3|dts|flac|mp3|320\s?kbps|256\s?kbps|128\s?kbps|v0|remux|proper|repack|hq|official\s+(?:music\s+)?video|official\s+audio|lyrics?\s+video|audio|hd)\b/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|io|ru|to|cc|me|tv)\b/gi;
const DUP_MARKERS = [/\s*\(\d+\)$/, /\s*-\s*copy(?:\s*\(\d+\))?$/i, /^copy of\s+/i, /\s+copy(?:\s*\d+)?$/i, /\s*-\s*kopie$/i, /\s*\[\d+\]$/];
const DATE_RE = /(?<!\d)(?:(19|20)\d{2}[-_. ]?(0[1-9]|1[0-2])[-_. ]?(0[1-9]|[12]\d|3[01])(?:[-_ T.]?([01]\d|2[0-3])[-_.:]?([0-5]\d)(?:[-_.:]?([0-5]\d))?)?|(0?[1-9]|[12]\d|3[01])[-_.](0?[1-9]|1[0-2])[-_.](19|20)\d{2})(?!\d)/g;

/* ------------------------------------------------------------------ rules */
export const RULE_GROUPS = [['clean', 'Clean up'], ['edit', 'Edit text'], ['build', 'Build new names'], ['advanced', 'Advanced']];

export const RULES = {
  cleanup: {
    label: 'Tidy up names', icon: 'sparkles', group: 'clean',
    desc: 'Turn _ and %20 into spaces, drop junk like "(1)" or "- Copy", fix spacing and invalid characters.',
    fields: [
      { key: 'underscores', type: 'bool', label: 'Underscores to spaces', default: true },
      { key: 'dots', type: 'bool', label: 'Dots to spaces (keeps 1.5, 2.0)', default: false },
      { key: 'dashes', type: 'select', label: 'Dashes', options: [['keep', 'Keep'], ['spaced', 'Normalise to " - "'], ['space', 'Replace with space'], ['remove', 'Remove']], default: 'keep' },
      { key: 'camel', type: 'bool', label: 'Split camelCase words', default: false },
      { key: 'urlDecode', type: 'bool', label: 'Decode %20 and URL escapes', default: true },
      { key: 'brackets', type: 'select', label: 'Remove bracketed text', options: [['none', 'None'], ['round', '( ) only'], ['square', '[ ] only'], ['curly', '{ } only'], ['all', 'All brackets']], default: 'none' },
      { key: 'junk', type: 'text', label: 'Junk words to remove (comma separated)', default: '', placeholder: 'e.g. official video, lyrics, www.site.com' },
      { key: 'dupMarkers', type: 'bool', label: 'Remove "(1)", "- Copy", "Copy of"', default: true },
      { key: 'accents', type: 'select', label: 'Accents & scripts', options: [['keep', 'Keep'], ['strip', 'Strip accents (é→e)'], ['translit', 'Transliterate (Ж→Zh, ß→ss)']], default: 'keep' },
      { key: 'emoji', type: 'bool', label: 'Remove emoji & symbols', default: false },
      { key: 'windows', type: 'select', label: 'Characters invalid on Windows', options: [['replace', 'Replace with safe look-alikes'], ['remove', 'Remove'], ['keep', 'Keep']], default: 'replace' },
      { key: 'fixSpacing', type: 'bool', label: 'Fix spacing around - , ( )', default: true },
    ],
    apply(st, o) {
      let s = st.base;
      if (o.urlDecode && /%[0-9a-f]{2}/i.test(s)) { try { s = decodeURIComponent(s.replace(/\+/g, ' ')); } catch { s = s.replace(/%20/gi, ' '); } }
      if (o.underscores) s = s.replace(/_+/g, ' ');
      if (o.dots) s = s.replace(/(?<!\d)\.|\.(?!\d)/g, ' ');
      if (o.camel) s = s.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2');
      if (o.brackets && o.brackets !== 'none') {
        const pats = { round: [/\s*\([^()]*\)/g], square: [/\s*\[[^\[\]]*\]/g], curly: [/\s*\{[^{}]*\}/g] };
        const list = o.brackets === 'all' ? [...pats.round, ...pats.square, ...pats.curly] : pats[o.brackets];
        for (const re of list) s = s.replace(re, '');
      }
      if (o.junk) for (const w of o.junk.split(',').map((x) => x.trim()).filter(Boolean)) s = s.replace(new RegExp(`(?<![\\p{L}\\d])${escapeRegex(w)}(?![\\p{L}\\d])`, 'giu'), '');
      if (o.dupMarkers) for (const re of DUP_MARKERS) s = s.replace(re, '');
      if (o.accents === 'strip') s = stripAccents(s); else if (o.accents === 'translit') s = transliterate(s);
      if (o.emoji) s = s.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]|[\u2600-\u27BF]|[\u{1F1E6}-\u{1F1FF}]/gu, '').replace(/[©®™★☆♪♫•·]/g, '');
      if (o.windows === 'replace') s = s.replace(/[<>:"\\|?*]/g, (c) => ({ '<': '‹', '>': '›', ':': ' -', '"': "'", '\\': '-', '|': '-', '?': '', '*': '' })[c]);
      else if (o.windows === 'remove') s = s.replace(/[<>:"\\|?*]/g, '');
      if (o.dashes === 'spaced') s = s.replace(/\s*(?<!\d)[-–—]+(?!\d)\s*/g, ' - ').replace(/\s+-\s+/g, ' - ');
      else if (o.dashes === 'space') s = s.replace(/[-–—]+/g, ' ');
      else if (o.dashes === 'remove') s = s.replace(/\s*[-–—]+\s*/g, (m) => (/\s/.test(m) ? ' ' : ''));
      if (o.fixSpacing) {
        s = s.replace(/\s+,/g, ',').replace(/,(?=\S)/g, ', ').replace(/\(\s+/g, '(').replace(/\s+\)/g, ')').replace(/\[\s+/g, '[').replace(/\s+\]/g, ']')
          .replace(/(\S)\((?=\p{L})/gu, '$1 (').replace(/\s+-\s*|\s*-\s+/g, (m) => (m.trim() === '-' && /\s/.test(m) ? ' - ' : m))
          .replace(/(\s*-\s*){2,}/g, ' - ').replace(/\(\s*\)|\[\s*\]|\{\s*\}/g, '');
      }
      s = collapse(s).replace(/^[\s\-_.,]+|[\s\-_,]+$/g, '');
      st.base = s || st.base;
    },
  },

  replace: {
    label: 'Find and replace', icon: 'replace', group: 'edit',
    desc: 'Replace text or a regular expression. Use $1, $2 for regex groups; replacement supports {variables}.',
    fields: [
      { key: 'find', type: 'text', label: 'Find', default: '' },
      { key: 'with', type: 'text', label: 'Replace with', default: '' },
      { key: 'regex', type: 'bool', label: 'Regular expression', default: false },
      { key: 'matchCase', type: 'bool', label: 'Match case', default: false },
      { key: 'wholeWord', type: 'bool', label: 'Whole words only', default: false },
      { key: 'occurrence', type: 'select', label: 'Occurrences', options: [['all', 'All'], ['first', 'First only'], ['last', 'Last only']], default: 'all' },
      { key: 'target', type: 'select', label: 'Apply to', options: [['name', 'Name'], ['ext', 'Extension'], ['full', 'Name + extension']], default: 'name' },
    ],
    validate(o) { if (o.regex && o.find) { try { new RegExp(o.find, 'u'); } catch (e) { return `Invalid regex: ${e.message}`; } } return null; },
    apply(st, o, ctx) {
      if (!o.find) return;
      let src = o.regex ? o.find : escapeRegex(o.find);
      if (o.wholeWord) src = `(?<![\\p{L}\\p{N}_])(?:${src})(?![\\p{L}\\p{N}_])`;
      let re; try { re = new RegExp(src, 'gu' + (o.matchCase ? '' : 'i')); } catch { return; }
      const repl = expandTemplate(o.with || '', st, ctx);
      const r = o.regex ? repl : repl.replace(/\$/g, '$$$$');
      withTarget(st, o.target, (s) => {
        if (o.occurrence === 'all') return s.replace(re, r);
        const matches = [...s.matchAll(re)]; if (!matches.length) return s;
        const m = o.occurrence === 'first' ? matches[0] : matches[matches.length - 1];
        const one = new RegExp(re.source, re.flags.replace('g', ''));
        return s.slice(0, m.index) + m[0].replace(one, r) + s.slice(m.index + m[0].length);
      });
    },
  },

  replaceList: {
    label: 'Replace many at once', icon: 'list', group: 'edit',
    desc: 'Several find-and-replace pairs in one rule, one per line: old => new.',
    fields: [
      { key: 'pairs', type: 'textarea', label: 'Pairs (one per line)', default: '', placeholder: 'feat. => ft.\n& => and' },
      { key: 'matchCase', type: 'bool', label: 'Match case', default: false },
      { key: 'wholeWord', type: 'bool', label: 'Whole words only', default: false },
    ],
    apply(st, o) {
      for (const line of (o.pairs || '').split('\n')) {
        const m = line.split(/\s*=>\s*|\t/); if (m.length < 2 || !m[0]) continue;
        let src = escapeRegex(m[0].trim() ? m[0] : m[0]);
        if (o.wholeWord) src = `(?<![\\p{L}\\p{N}])${src}(?![\\p{L}\\p{N}])`;
        st.base = st.base.replace(new RegExp(src, 'gu' + (o.matchCase ? '' : 'i')), m.slice(1).join('=>').replace(/\$/g, '$$$$'));
      }
    },
  },

  remove: {
    label: 'Remove characters', icon: 'scissors', group: 'edit',
    desc: 'Cut characters by position, specific text, digits, symbols, or everything before/after a marker.',
    fields: [
      { key: 'mode', type: 'select', label: 'Remove', options: [['first', 'First N characters'], ['last', 'Last N characters'], ['range', 'Characters from … to …'], ['text', 'Specific words/text (comma separated)'], ['chars', 'Specific characters'], ['digits', 'Digits'], ['before', 'Everything before marker'], ['after', 'Everything after marker'], ['nonalnum', 'All non letters/digits (keeps spaces)'], ['spaces', 'All spaces']], default: 'first' },
      { key: 'n', type: 'number', label: 'N', default: 1, min: 0, show: (o) => ['first', 'last'].includes(o.mode) },
      { key: 'from', type: 'number', label: 'From position (1-based)', default: 1, min: 1, show: (o) => o.mode === 'range' },
      { key: 'to', type: 'number', label: 'To position (inclusive)', default: 3, min: 1, show: (o) => o.mode === 'range' },
      { key: 'text', type: 'text', label: 'Text', default: '', show: (o) => ['text', 'chars'].includes(o.mode) },
      { key: 'digits', type: 'select', label: 'Which digits', options: [['all', 'All'], ['leading', 'Leading'], ['trailing', 'Trailing']], default: 'leading', show: (o) => o.mode === 'digits' },
      { key: 'marker', type: 'text', label: 'Marker', default: ' - ', show: (o) => ['before', 'after'].includes(o.mode) },
      { key: 'useLast', type: 'bool', label: 'Use last occurrence of marker', default: false, show: (o) => ['before', 'after'].includes(o.mode) },
      { key: 'inclusive', type: 'bool', label: 'Also remove the marker', default: true, show: (o) => ['before', 'after'].includes(o.mode) },
      { key: 'matchCase', type: 'bool', label: 'Match case', default: false, show: (o) => o.mode === 'text' },
    ],
    apply(st, o) {
      let s = st.base; const n = Math.max(0, +o.n || 0);
      switch (o.mode) {
        case 'first': s = [...s].slice(n).join(''); break;
        case 'last': s = n ? [...s].slice(0, -n).join('') : s; break;
        case 'range': { const a = [...s]; const f = Math.max(1, +o.from) - 1; const t = Math.max(f, +o.to); a.splice(f, t - f); s = a.join(''); break; }
        case 'text': for (const w of (o.text || '').split(',').map((x) => x.trim()).filter(Boolean)) s = s.replace(new RegExp(escapeRegex(w), 'gu' + (o.matchCase ? '' : 'i')), ''); break;
        case 'chars': if (o.text) s = s.replace(new RegExp(`[${escapeRegex(o.text).replace(/-/g, '\\-')}]`, 'gu'), ''); break;
        case 'digits': s = o.digits === 'all' ? s.replace(/\d/g, '') : o.digits === 'trailing' ? s.replace(/[\s._-]*\d+$/, '') : s.replace(/^\d+[\s._-]*/, ''); break;
        case 'before': case 'after': {
          if (!o.marker) break;
          const i = o.useLast ? s.lastIndexOf(o.marker) : s.indexOf(o.marker); if (i < 0) break;
          if (o.mode === 'before') s = s.slice(o.inclusive ? i + o.marker.length : i);
          else s = s.slice(0, o.inclusive ? i : i + o.marker.length);
          break;
        }
        case 'nonalnum': s = s.replace(/[^\p{L}\p{N}\s]/gu, ''); break;
        case 'spaces': s = s.replace(/\s+/g, ''); break;
        default:
      }
      st.base = collapse(s);
    },
  },

  case: {
    label: 'Change letter case', icon: 'type', group: 'clean',
    desc: 'Title Case, Sentence case, lower, UPPER, camelCase, snake_case and more. Smart Title Case keeps small words and acronyms right.',
    fields: [
      { key: 'mode', type: 'select', label: 'Case', options: [['title', 'Title Case (smart)'], ['titleAll', 'Title Case (every word)'], ['sentence', 'Sentence case'], ['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['capitalize', 'Capitalize first letters only'], ['invert', 'iNVERT cASE'], ['camel', 'camelCase'], ['pascal', 'PascalCase'], ['snake', 'snake_case'], ['kebab', 'kebab-case'], ['constant', 'CONSTANT_CASE'], ['dot', 'dot.case']], default: 'title' },
      { key: 'exceptions', type: 'text', label: 'Always write these words exactly (comma separated)', default: 'DJ, feat., ft., vs., MTV, USA, UK, OK, TV', show: (o) => o.mode?.startsWith('title') || o.mode === 'sentence' },
      { key: 'ext', type: 'select', label: 'Extension', options: [['keep', 'Keep'], ['lower', 'lowercase'], ['upper', 'UPPERCASE']], default: 'lower' },
    ],
    apply(st, o) {
      const exceptions = (o.exceptions || '').split(',').map((x) => x.trim()).filter(Boolean);
      let s = changeCase(st.base, o.mode, { exceptions });
      if (o.mode === 'sentence' && exceptions.length) for (const e of exceptions) s = s.replace(new RegExp(`(?<![\\p{L}])${escapeRegex(e)}(?![\\p{L}])`, 'giu'), e);
      st.base = s;
      if (o.ext === 'lower') st.ext = st.ext.toLowerCase(); else if (o.ext === 'upper') st.ext = st.ext.toUpperCase();
    },
  },

  add: {
    label: 'Add text', icon: 'plus', group: 'build',
    desc: 'Add text before or after the name, or insert it at a position. Supports {variables}.',
    fields: [
      { key: 'prefix', type: 'text', label: 'Prefix', default: '' },
      { key: 'suffix', type: 'text', label: 'Suffix', default: '' },
      { key: 'insert', type: 'text', label: 'Insert text', default: '' },
      { key: 'at', type: 'number', label: 'Insert at position', default: 0, min: 0 },
      { key: 'fromEnd', type: 'bool', label: 'Count position from end', default: false },
    ],
    apply(st, o, ctx) {
      let s = st.base;
      if (o.insert) {
        const a = [...s]; const ins = expandTemplate(o.insert, st, ctx);
        const at = Math.min(a.length, Math.max(0, +o.at || 0));
        a.splice(o.fromEnd ? a.length - at : at, 0, ins); s = a.join('');
      }
      s = expandTemplate(o.prefix || '', st, ctx) + s + expandTemplate(o.suffix || '', st, ctx);
      st.base = s;
    },
  },

  number: {
    label: 'Add numbers', icon: 'list-ordered', group: 'build',
    desc: 'Number items 1, 2, 3 (or 01, a, I…) before, after or instead of the name. Can restart in each folder.',
    fields: [
      { key: 'position', type: 'select', label: 'Position', options: [['prefix', 'Before name'], ['suffix', 'After name'], ['insert', 'At position'], ['replace', 'Replace whole name']], default: 'prefix' },
      { key: 'at', type: 'number', label: 'Position', default: 0, min: 0, show: (o) => o.position === 'insert' },
      { key: 'start', type: 'number', label: 'Start at', default: 1 },
      { key: 'step', type: 'number', label: 'Step', default: 1 },
      { key: 'pad', type: 'number', label: 'Digits (0 = automatic)', default: 0, min: 0, max: 12 },
      { key: 'sep', type: 'text', label: 'Separator', default: ' - ' },
      { key: 'style', type: 'select', label: 'Style', options: [['decimal', '1, 2, 3'], ['alpha', 'a, b, c'], ['ALPHA', 'A, B, C'], ['roman', 'I, II, III'], ['hex', 'hex 0a, 0b']], default: 'decimal' },
      { key: 'perFolder', type: 'bool', label: 'Restart in every folder', default: true },
      { key: 'order', type: 'select', label: 'Order', options: [['list', 'As listed (natural sort)'], ['mdate', 'Modified date'], ['size', 'Size'], ['newName', 'Name after previous rules']], default: 'list' },
      { key: 'dirs', type: 'bool', label: 'Number folders too', default: false },
    ],
    prepare(states, o) {
      const idx = new Map(); const groups = new Map();
      for (const s of states) {
        if (s.isDir && !o.dirs) continue;
        const k = o.perFolder ? dirname(s.path) : '';
        if (!groups.has(k)) groups.set(k, []); groups.get(k).push(s);
      }
      let maxCount = 0;
      for (const g of groups.values()) {
        if (o.order === 'mdate') g.sort((a, b) => (a.mtime || 0) - (b.mtime || 0));
        else if (o.order === 'size') g.sort((a, b) => (a.size || 0) - (b.size || 0));
        else if (o.order === 'newName') g.sort((a, b) => naturalCompare(a.base, b.base));
        g.forEach((s, i) => idx.set(s, i)); maxCount = Math.max(maxCount, g.length);
      }
      const last = (+o.start || 0) + (maxCount - 1) * (+o.step || 1);
      const auto = Math.max(2, String(Math.abs(last)).length);
      return { idx, width: +o.pad > 0 ? +o.pad : auto };
    },
    apply(st, o, ctx, prep) {
      if (!prep.idx.has(st)) return;
      const n = (+o.start || 0) + prep.idx.get(st) * (o.step === '' ? 1 : +o.step);
      let v;
      switch (o.style) {
        case 'alpha': v = toAlpha(n); break;
        case 'ALPHA': v = toAlpha(n).toUpperCase(); break;
        case 'roman': v = toRoman(n); break;
        case 'hex': v = n.toString(16).padStart(prep.width, '0'); break;
        default: v = n < 0 ? '-' + pad(-n, prep.width) : pad(n, prep.width);
      }
      const sep = o.sep ?? '';
      if (o.position === 'prefix') st.base = v + sep + st.base;
      else if (o.position === 'suffix') st.base = st.base + sep + v;
      else if (o.position === 'replace') st.base = v;
      else { const a = [...st.base]; a.splice(Math.min(a.length, +o.at || 0), 0, v); st.base = a.join(''); }
    },
  },

  template: {
    label: 'Build from template', icon: 'code', group: 'build',
    desc: 'Write the whole new name from variables, e.g. {track:2} - {title} or {parent} {n:3}.',
    fields: [
      { key: 'tpl', type: 'template', label: 'New name (without extension)', default: '{name}' },
      { key: 'onlyIfTags', type: 'bool', label: 'Skip files where the template resolves to empty', default: true },
    ],
    apply(st, o, ctx) {
      const out = collapse(expandTemplate(o.tpl || '{name}', st, ctx)).replace(/^[\s\-_.]+|[\s\-_]+$/g, '');
      if (!out && o.onlyIfTags) return;
      if (templateUsesTags(o.tpl) && o.onlyIfTags && !st.tags) return;
      st.base = out.replace(/\//g, '-');
    },
  },

  extension: {
    label: 'Change extension', icon: 'file-text', group: 'build',
    desc: 'Lower/upper case, replace, remove or fix extensions, or detect the real type from the file contents.',
    fields: [
      { key: 'mode', type: 'select', label: 'Action', options: [['lower', 'lowercase'], ['upper', 'UPPERCASE'], ['replace', 'Replace with'], ['remove', 'Remove'], ['add', 'Add extension'], ['fixDouble', 'Fix double extensions (a.jpg.jpg)'], ['normalize', 'Normalise (jpeg→jpg, tif→tiff, htm→html)'], ['detect', 'Detect from file contents']], default: 'lower' },
      { key: 'value', type: 'text', label: 'Extension', default: '', show: (o) => ['replace', 'add'].includes(o.mode) },
      { key: 'onlyExt', type: 'text', label: 'Only for extensions (comma separated, empty = all)', default: '' },
    ],
    needsMagic: (o) => o.mode === 'detect',
    apply(st, o) {
      if (st.isDir) return;
      const only = (o.onlyExt || '').split(',').map((x) => x.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
      if (only.length && !only.includes(st.ext.toLowerCase())) return;
      const v = (o.value || '').replace(/^\./, '');
      switch (o.mode) {
        case 'lower': st.ext = st.ext.toLowerCase(); break;
        case 'upper': st.ext = st.ext.toUpperCase(); break;
        case 'replace': if (st.ext) st.ext = v; break;
        case 'remove': st.ext = ''; break;
        case 'add': if (v) { st.base = joinName(st.base, st.ext); st.ext = v; } break;
        case 'fixDouble': { const s = splitName(st.base); if (s.ext && s.ext.toLowerCase() === st.ext.toLowerCase()) st.base = s.base; break; }
        case 'normalize': st.ext = ({ jpeg: 'jpg', jpe: 'jpg', tif: 'tiff', htm: 'html', mpeg: 'mpg', aif: 'aiff', yml: 'yaml' })[st.ext.toLowerCase()] ?? st.ext; break;
        case 'detect': if (st.detectedExt && st.detectedExt !== st.ext.toLowerCase() && !(st.detectedExt === 'jpg' && /^jpe?g$/i.test(st.ext))) st.ext = st.detectedExt; break;
        default:
      }
    },
  },

  swap: {
    label: 'Swap parts', icon: 'arrow-left-right', group: 'edit',
    desc: 'Split the name at a separator and reorder the parts, e.g. "Title - Artist" → "Artist - Title".',
    fields: [
      { key: 'sep', type: 'text', label: 'Separator', default: ' - ' },
      { key: 'order', type: 'text', label: 'New order (e.g. 2,1 or 3,1,2; * = remaining)', default: '2,1' },
      { key: 'join', type: 'text', label: 'Join with (empty = same separator)', default: '' },
    ],
    apply(st, o) {
      if (!o.sep) return;
      const parts = st.base.split(o.sep); if (parts.length < 2) return;
      const used = new Set(); const out = [];
      for (const tok of (o.order || '2,1').split(',').map((x) => x.trim())) {
        if (tok === '*') { parts.forEach((p, i) => { if (!used.has(i)) { out.push(p); used.add(i); } }); continue; }
        const i = +tok - 1; if (parts[i] !== undefined && !used.has(i)) { out.push(parts[i]); used.add(i); }
      }
      if (!(o.order || '').includes('*')) parts.forEach((p, i) => { if (!used.has(i)) out.push(p); });
      st.base = out.map((p) => p.trim()).filter(Boolean).join(o.join || o.sep);
    },
  },

  trim: {
    label: 'Keep only part', icon: 'text-cursor-input', group: 'edit',
    desc: 'Keep just the text before, after or between markers, or cut names to a maximum length.',
    fields: [
      { key: 'mode', type: 'select', label: 'Keep', options: [['before', 'Text before marker'], ['after', 'Text after marker'], ['between', 'Text between two markers'], ['max', 'First N characters (max length)']], default: 'before' },
      { key: 'marker', type: 'text', label: 'Marker', default: ' - ', show: (o) => o.mode !== 'max' },
      { key: 'marker2', type: 'text', label: 'Second marker', default: ')', show: (o) => o.mode === 'between' },
      { key: 'useLast', type: 'bool', label: 'Use last occurrence', default: false, show: (o) => o.mode !== 'max' },
      { key: 'n', type: 'number', label: 'Max length', default: 60, min: 1, show: (o) => o.mode === 'max' },
      { key: 'wordBoundary', type: 'bool', label: 'Cut at word boundary', default: true, show: (o) => o.mode === 'max' },
    ],
    apply(st, o) {
      const s = st.base;
      if (o.mode === 'max') {
        const a = [...s]; if (a.length <= +o.n) return;
        let cut = a.slice(0, +o.n).join('');
        if (o.wordBoundary) { const i = cut.lastIndexOf(' '); if (i > +o.n * 0.5) cut = cut.slice(0, i); }
        st.base = cut.replace(/[\s\-_,.]+$/, ''); return;
      }
      if (!o.marker) return;
      const i = o.useLast ? s.lastIndexOf(o.marker) : s.indexOf(o.marker); if (i < 0) return;
      if (o.mode === 'before') st.base = s.slice(0, i).trim() || s;
      else if (o.mode === 'after') st.base = s.slice(i + o.marker.length).trim() || s;
      else { const rest = s.slice(i + o.marker.length); const j = o.marker2 ? rest.indexOf(o.marker2) : -1; st.base = (j < 0 ? rest : rest.slice(0, j)).trim() || s; }
    },
  },

  strip: {
    label: 'Strip numbers and tags', icon: 'brackets', group: 'clean',
    desc: 'Remove old track numbers, dates, shared prefixes/suffixes, quality tags (1080p, 320kbps) and URLs.',
    fields: [
      { key: 'leading', type: 'bool', label: 'Leading track/sequence numbers (01, 1., CD1-02, Track 3)', default: true },
      { key: 'trailing', type: 'bool', label: 'Trailing numbers (name 001, name_2)', default: false },
      { key: 'dates', type: 'bool', label: 'Dates (2024-05-01, 20240501, 01.05.2024)', default: false },
      { key: 'commonPrefix', type: 'bool', label: 'Text shared by all names at the start', default: false },
      { key: 'commonSuffix', type: 'bool', label: 'Text shared by all names at the end', default: false },
      { key: 'quality', type: 'bool', label: 'Release/quality tags (1080p, x264, 320kbps, Official Video)', default: false },
      { key: 'urls', type: 'bool', label: 'Website names and URLs', default: false },
    ],
    prepare(states, o) {
      const files = states.filter((s) => !s.isDir);
      const bases = files.map((s) => s.base);
      let pre = ''; let suf = '';
      if (bases.length >= 2) {
        if (o.commonPrefix) { pre = commonPrefix(bases); const m = pre.match(/^.*[\s_\-.)\]]/); pre = m ? m[0] : ''; if (bases.some((b) => b.length <= pre.length)) pre = ''; }
        if (o.commonSuffix) { suf = commonSuffix(bases); const m = suf.match(/[\s_\-.(\[].*$/); suf = m ? m[0] : ''; if (bases.some((b) => b.length <= suf.length + pre.length)) suf = ''; }
      }
      return { pre, suf };
    },
    apply(st, o, ctx, prep) {
      let s = st.base;
      if (prep.pre && !st.isDir && s.startsWith(prep.pre)) s = s.slice(prep.pre.length);
      if (prep.suf && !st.isDir && s.endsWith(prep.suf)) s = s.slice(0, -prep.suf.length);
      if (o.urls) s = s.replace(URL_RE, '');
      if (o.quality) s = s.replace(/[\[(]\s*[\])]/g, '').replace(QUALITY, '').replace(/[\[(]\s*[\])]/g, '');
      if (o.dates) s = s.replace(DATE_RE, '');
      if (o.leading) s = s.replace(/^\s*(?:(?:cd|disc|disk)\s*\d+\s*[-_.]?\s*)?(?:(?:track|trk|tr|no\.?|#)\s*)?\d{1,4}(?:\s*[-_./]\s*\d{1,3})?(?:\s*(?:[-_.)\]]|\s)\s*|(?=\p{Lu}))/iu, '');
      if (o.trailing) s = s.replace(/(?:[\s_\-.(\[]+)(?:\d{1,5})[)\]]?\s*$/, '');
      s = collapse(s.replace(/\(\s*\)|\[\s*\]/g, '')).replace(/^[\s\-_.,)\]]+|[\s\-_,(\[]+$/g, '');
      if (s) st.base = s;
    },
  },

  date: {
    label: 'Add or reformat date', icon: 'calendar', group: 'build',
    desc: 'Insert the modified date or today, or rewrite dates already in names into one format.',
    fields: [
      { key: 'mode', type: 'select', label: 'Action', options: [['mdate', 'Insert file modified date'], ['now', 'Insert current date'], ['reformat', 'Reformat dates found in the name']], default: 'mdate' },
      { key: 'fmt', type: 'text', label: 'Format (YYYY MM DD HH mm ss, [literal])', default: 'YYYY-MM-DD' },
      { key: 'position', type: 'select', label: 'Position', options: [['prefix', 'Before name'], ['suffix', 'After name'], ['replace', 'Replace name']], default: 'prefix', show: (o) => o.mode !== 'reformat' },
      { key: 'sep', type: 'text', label: 'Separator', default: ' ', show: (o) => o.mode !== 'reformat' },
      { key: 'input', type: 'select', label: 'Numeric dates like 03.04.2024 are', options: [['dmy', 'Day.Month.Year'], ['mdy', 'Month.Day.Year']], default: 'dmy', show: (o) => o.mode === 'reformat' },
    ],
    apply(st, o, ctx) {
      if (o.mode === 'reformat') {
        st.base = st.base.replace(DATE_RE, (m) => {
          const d = parseDateToken(m, o.input); return d ? formatDate(d, o.fmt || 'YYYY-MM-DD') : m;
        });
        return;
      }
      const d = o.mode === 'now' ? (ctx.now || new Date()) : st.mtime ? new Date(st.mtime) : null;
      if (!d) return;
      const v = formatDate(d, o.fmt || 'YYYY-MM-DD');
      if (o.position === 'replace') st.base = v; else if (o.position === 'suffix') st.base = st.base + (o.sep ?? '') + v; else st.base = v + (o.sep ?? '') + st.base;
    },
  },

  list: {
    label: 'Rename from a list', icon: 'clipboard-paste', group: 'advanced',
    desc: 'Paste new names, one per line, applied in the listed order (e.g. from a spreadsheet).',
    fields: [
      { key: 'names', type: 'textarea', label: 'New names (one per line)', default: '' },
      { key: 'keepExt', type: 'bool', label: 'Keep original extension', default: true },
    ],
    prepare(states) { const idx = new Map(); let i = 0; for (const s of states) if (!s.isDir) idx.set(s, i++); return { idx }; },
    apply(st, o, ctx, prep) {
      if (!prep.idx.has(st)) return;
      const lines = (o.names || '').split(/\r?\n/);
      const n = lines[prep.idx.get(st)]?.trim(); if (!n) return;
      if (o.keepExt) st.base = n; else { const s = splitName(n); st.base = s.base; st.ext = s.ext; }
    },
  },

  script: {
    label: 'Custom script (JavaScript)', icon: 'zap', group: 'advanced',
    desc: 'JavaScript: return the new name. Variables: name, ext, index, dirIndex, total, path, parent, mtime, size, tags, isDir.',
    fields: [{ key: 'code', type: 'code', label: 'Function body', default: "return name.replace(/\\s+/g, ' ');" }],
    validate(o) { try { new Function('name', 'ext', 'index', 'dirIndex', 'total', 'path', 'parent', 'mtime', 'size', 'tags', 'isDir', o.code || ''); } catch (e) { return `Script error: ${e.message}`; } return null; },
    prepare(states, o) { try { return { fn: new Function('name', 'ext', 'index', 'dirIndex', 'total', 'path', 'parent', 'mtime', 'size', 'tags', 'isDir', o.code || 'return name;') }; } catch { return { fn: null }; } },
    apply(st, o, ctx, prep) {
      if (!prep.fn) return;
      const parent = dirname(st.path).split('/').pop() || ctx.rootName || '';
      const r = prep.fn(st.base, st.ext, st.index, st.dirIndex, st.total, st.path, parent, st.mtime, st.size, st.tags || {}, st.isDir);
      if (typeof r === 'string') st.base = r;
      else if (r && typeof r === 'object') { if (typeof r.name === 'string') st.base = r.name; if (typeof r.ext === 'string') st.ext = r.ext; }
    },
  },
};

export function parseDateToken(m, input = 'dmy') {
  const digits = m.replace(/\D/g, '');
  let y; let mo; let d; let h = 0; let mi = 0; let s = 0;
  if (/^(19|20)\d{2}/.test(m)) {
    const g = m.match(/^((?:19|20)\d{2})\D?(\d{2})\D?(\d{2})(?:\D?(\d{2})\D?(\d{2})(?:\D?(\d{2}))?)?/);
    if (!g) return null; [y, mo, d, h = 0, mi = 0, s = 0] = g.slice(1).map((x) => (x === undefined ? 0 : +x));
  } else {
    const g = m.split(/\D/).map(Number); if (g.length < 3) return null;
    if (input === 'mdy') [mo, d, y] = g; else [d, mo, y] = g;
  }
  if (!digits || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  return new Date(y, mo - 1, d, h, mi, s);
}

export function defaultOptions(type) {
  const o = {}; for (const f of RULES[type].fields) o[f.key] = f.default; return o;
}
export function makeRule(type, opts = {}) { return { id: randomString(8), type, enabled: true, opts: { ...defaultOptions(type), ...opts } }; }

/** Run pipeline: items = [{path,name,isDir,mtime,size,tags,detectedExt}] -> Map path -> newName */
export function runPipeline(items, rules, ctx = {}) {
  const dirCounters = new Map(); const dirTotals = new Map();
  for (const it of items) { const d = dirname(it.path); dirTotals.set(d, (dirTotals.get(d) || 0) + 1); }
  const states = items.map((it, index) => {
    const { base, ext } = splitName(it.name, it.isDir);
    const d = dirname(it.path); const dirIndex = dirCounters.get(d) || 0; dirCounters.set(d, dirIndex + 1);
    return { ...it, base, ext, index, dirIndex, dirCount: dirTotals.get(d), total: items.length };
  });
  const errors = [];
  const scope = ctx.scope || 'files';
  const active = states.filter((s) => (scope === 'both' ? true : scope === 'dirs' ? s.isDir : !s.isDir));
  for (const r of rules) {
    if (!r.enabled || !RULES[r.type]) continue;
    const def = RULES[r.type];
    const err = def.validate?.(r.opts); if (err) { errors.push({ rule: r.id, msg: err }); continue; }
    let prep = {};
    try { prep = def.prepare ? def.prepare(active, r.opts, ctx) : {}; } catch (e) { errors.push({ rule: r.id, msg: e.message }); continue; }
    for (const st of active) {
      try { def.apply(st, r.opts, ctx, prep); } catch (e) { errors.push({ rule: r.id, msg: e.message, path: st.path }); break; }
    }
  }
  const out = new Map();
  for (const st of active) out.set(st.path, joinName(st.base, st.ext));
  return { names: out, errors };
}
