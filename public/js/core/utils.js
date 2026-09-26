// NameTag core utilities (pure functions, no DOM) — usable in browser and Node tests.

const MULTI_EXT = ['tar.gz', 'tar.bz2', 'tar.xz', 'tar.zst', 'tar.lz', 'user.js'];

/** Split "a.tar.gz" -> {base:"a", ext:"tar.gz"}; dotfiles have no ext. isDir -> no ext. */
export function splitName(name, isDir = false) {
  if (isDir) return { base: name, ext: '' };
  const lower = name.toLowerCase();
  for (const m of MULTI_EXT) {
    if (lower.endsWith('.' + m) && lower.length > m.length + 1) {
      return { base: name.slice(0, -(m.length + 1)), ext: name.slice(-m.length) };
    }
  }
  const i = name.lastIndexOf('.');
  if (i <= 0 || i === name.length - 1) return { base: name, ext: '' };
  const ext = name.slice(i + 1);
  if (ext.length > 10 || /\s/.test(ext)) return { base: name, ext: '' };
  return { base: name.slice(0, i), ext };
}
export const joinName = (base, ext) => (ext ? `${base}.${ext}` : base);

export function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
export function basename(p) { const i = p.lastIndexOf('/'); return i < 0 ? p : p.slice(i + 1); }
export function joinPath(dir, name) { return dir ? `${dir}/${name}` : name; }

export const pad = (n, w = 2, ch = '0') => String(n).padStart(w, ch);

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Format date with tokens YYYY YY MMMM MMM MM M DD D dddd ddd HH H hh h mm ss A a; [literal] escapes. */
export function formatDate(d, fmt = 'YYYY-MM-DD') {
  if (!(d instanceof Date) || isNaN(d)) return '';
  const h = d.getHours();
  const map = {
    YYYY: d.getFullYear(), YY: pad(d.getFullYear() % 100), MMMM: MONTHS[d.getMonth()], MMM: MONTHS[d.getMonth()].slice(0, 3),
    MM: pad(d.getMonth() + 1), M: d.getMonth() + 1, DD: pad(d.getDate()), D: d.getDate(), dddd: DAYS[d.getDay()], ddd: DAYS[d.getDay()].slice(0, 3),
    HH: pad(h), H: h, hh: pad(h % 12 || 12), h: h % 12 || 12, mm: pad(d.getMinutes()), ss: pad(d.getSeconds()), A: h < 12 ? 'AM' : 'PM', a: h < 12 ? 'am' : 'pm',
  };
  return fmt.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|HH|H|hh|h|mm|ss|A|a/g, (m, lit) => (lit !== undefined ? lit : String(map[m])));
}

export const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const naturalCompare = (a, b) => collator.compare(a, b);

const SMALL = new Set('a an and as at but by en for if in nor of on or per the to v vs via with from into onto over up'.split(' '));
const isAcronym = (w) => /^[A-Z0-9]{2,}$/.test(w) && /[A-Z]/.test(w) && w.length <= 5;

export function titleCase(s, { smallWords = true, keepAcronyms = true, exceptions = [] } = {}) {
  const exc = new Map(exceptions.filter(Boolean).map((e) => [e.toLowerCase(), e]));
  const words = s.split(/(\s+|(?<=[-–—(\[{/])|(?=[)\]}]))/);
  let first = true;
  return words.map((w, i) => {
    if (!w || /^\s+$/.test(w) || /^[-–—(\[{/)\]}]$/.test(w)) return w;
    const low = w.toLowerCase();
    let out;
    if (exc.has(low)) out = exc.get(low);
    else if (keepAcronyms && isAcronym(w)) out = w;
    else if (/^(i{1,3}|iv|v|vi{1,3}|ix|x)$/i.test(w) && w.length > 1) out = w.toUpperCase();
    else if (smallWords && !first && SMALL.has(low) && i < words.length - 1) out = low;
    else out = low.replace(/^(['"‘“(]*)(\p{L})/u, (m, p, c) => p + c.toUpperCase()).replace(/(?<=\p{L})'(\p{L})(?=\p{L}{1,}\b)/gu, (m) => m);
    first = false;
    return out;
  }).join('');
}

export function splitWords(s) {
  return s
    .replace(/([\p{Ll}\d])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean);
}

export function changeCase(s, mode, opts = {}) {
  switch (mode) {
    case 'lower': return s.toLowerCase();
    case 'upper': return s.toUpperCase();
    case 'title': return titleCase(s, opts);
    case 'titleAll': return titleCase(s, { ...opts, smallWords: false });
    case 'sentence': { const l = s.toLowerCase(); return l.replace(/\p{L}/u, (c) => c.toUpperCase()); }
    case 'capitalize': return s.replace(/(^|[\s\-_(\[])(\p{L})/gu, (m, p, c) => p + c.toUpperCase());
    case 'invert': return [...s].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
    case 'camel': return splitWords(s).map((w, i) => (i ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w.toLowerCase())).join('');
    case 'pascal': return splitWords(s).map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join('');
    case 'snake': return splitWords(s).map((w) => w.toLowerCase()).join('_');
    case 'kebab': return splitWords(s).map((w) => w.toLowerCase()).join('-');
    case 'constant': return splitWords(s).map((w) => w.toUpperCase()).join('_');
    case 'dot': return splitWords(s).map((w) => w.toLowerCase()).join('.');
    default: return s;
  }
}

const TRANS = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
  α: 'a', β: 'v', γ: 'g', δ: 'd', ε: 'e', ζ: 'z', η: 'i', θ: 'th', ι: 'i', κ: 'k', λ: 'l', μ: 'm', ν: 'n', ξ: 'x', ο: 'o', π: 'p', ρ: 'r', σ: 's', ς: 's', τ: 't', υ: 'y', φ: 'f', χ: 'ch', ψ: 'ps', ω: 'o',
  ß: 'ss', æ: 'ae', ø: 'o', ł: 'l', đ: 'd', ð: 'd', þ: 'th', œ: 'oe', ı: 'i',
};
export function stripAccents(s) { return s.normalize('NFD').replace(/\p{M}/gu, '').normalize('NFC'); }
export function transliterate(s) {
  const out = [...s].map((c) => {
    const low = c.toLowerCase();
    const t = TRANS[low];
    if (t === undefined) return c;
    return c !== low ? (t.length > 1 ? t[0].toUpperCase() + t.slice(1) : t.toUpperCase()) : t;
  }).join('');
  return stripAccents(out);
}

export function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function bytesToBase64(u8) {
  if (typeof Buffer !== 'undefined') return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength).toString('base64');
  let s = ''; const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  return btoa(s);
}
export function base64ToBytes(b64) {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
  const s = atob(b64); const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

export function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function toCSV(rows) { return rows.map((r) => r.map(csvEscape).join(',')).join('\r\n'); }
export function parseCSV(text) {
  text = text.replace(/^\uFEFF/, '');
  const delim = (text.split('\n')[0].match(/;/g) || []).length > (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else q = false; } else field += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f !== ''));
}

/** Mulberry32 seeded PRNG */
export function seededRand(seed = Date.now()) {
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
export function randomString(n, rand = Math.random, alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789') {
  let s = ''; for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)]; return s;
}
export function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => { const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 3) | 8).toString(16); });
}

export function toRoman(n) {
  if (n <= 0 || n >= 4000) return String(n);
  const t = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = ''; for (const [v, r] of t) while (n >= v) { s += r; n -= v; } return s;
}
export function toAlpha(n) { // 1 -> a, 27 -> aa
  let s = ''; n = Math.max(1, n);
  while (n > 0) { n--; s = String.fromCharCode(97 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

export function formatBytes(b) {
  if (b == null) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; let v = b;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}
export function formatDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec); const h = Math.floor(sec / 3600); const m = Math.floor((sec % 3600) / 60); const s = sec % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
export function timestampForFile(d = new Date()) { return formatDate(d, 'YYYY-MM-DD_HH-mm-ss'); }

export const utf8len = (s) => new TextEncoder().encode(s).length;

export function debounce(fn, ms = 150) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/** Longest common prefix of strings */
export function commonPrefix(arr) {
  if (!arr.length) return '';
  let p = arr[0];
  for (const s of arr) { let i = 0; while (i < p.length && i < s.length && p[i] === s[i]) i++; p = p.slice(0, i); if (!p) break; }
  return p;
}
export function commonSuffix(arr) {
  const rev = arr.map((s) => [...s].reverse().join(''));
  return [...commonPrefix(rev)].reverse().join('');
}

/** Character-level diff for highlighting: returns [{t:'same'|'add'|'del', s}] (LCS; falls back to prefix/suffix for long strings) */
export function diffChars(a, b) {
  if (a === b) return [{ t: 'same', s: a }];
  let p = 0; while (p < a.length && p < b.length && a[p] === b[p]) p++;
  let s = 0; while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s++;
  const A = a.slice(p, a.length - s); const B = b.slice(p, b.length - s);
  const mid = [];
  if (A.length * B.length > 40000) {
    if (A) mid.push({ t: 'del', s: A }); if (B) mid.push({ t: 'add', s: B });
  } else {
    const m = A.length; const n = B.length;
    const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
    for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0; let j = 0;
    const push = (t, c) => { const l = mid[mid.length - 1]; if (l && l.t === t) l.s += c; else mid.push({ t, s: c }); };
    while (i < m && j < n) { if (A[i] === B[j]) { push('same', A[i]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]); else push('add', B[j++]); }
    while (i < m) push('del', A[i++]); while (j < n) push('add', B[j++]);
  }
  const out = [];
  if (p) out.push({ t: 'same', s: a.slice(0, p) });
  out.push(...mid);
  if (s) out.push({ t: 'same', s: a.slice(a.length - s) });
  return out;
}

export const IGNORED_NAMES = new Set(['desktop.ini', 'thumbs.db', '.ds_store', 'ehthumbs.db', '$recycle.bin', 'system volume information', '__macosx']);
export const MANIFEST_RE = /^nametag-(rename|tags)-.*\.json$/i;
export function isIgnoredName(name, { includeHidden = false, includeTemp = false } = {}) {
  const l = name.toLowerCase();
  if (IGNORED_NAMES.has(l)) return true;
  if (l.startsWith('.nametag-tmp-')) return !includeTemp;
  if (l.endsWith('.crswap')) return true;
  if (!includeHidden && name.startsWith('.')) return true;
  return false;
}
