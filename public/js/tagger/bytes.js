// Binary helpers shared by all tag readers/writers.
export async function readSlice(blob, start, end) {
  start = Math.max(0, start); end = Math.min(blob.size, end ?? blob.size);
  if (end <= start) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

export const u16be = (b, o) => (b[o] << 8) | b[o + 1];
export const u16le = (b, o) => b[o] | (b[o + 1] << 8);
export const u24be = (b, o) => (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
export const u32be = (b, o) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
export const u32le = (b, o) => ((b[o + 3] << 24) >>> 0) + ((b[o + 2] << 16) | (b[o + 1] << 8) | b[o]);
export const u64be = (b, o) => u32be(b, o) * 4294967296 + u32be(b, o + 4);
export const u64le = (b, o) => u32le(b, o + 4) * 4294967296 + u32le(b, o);
export const syncsafe = (b, o) => ((b[o] & 0x7f) << 21) | ((b[o + 1] & 0x7f) << 14) | ((b[o + 2] & 0x7f) << 7) | (b[o + 3] & 0x7f);

export function w16be(n) { return new Uint8Array([(n >> 8) & 255, n & 255]); }
export function w32be(n) { return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]); }
export function w32le(n) { return new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]); }
export function w64be(n) { const hi = Math.floor(n / 4294967296); return concat([w32be(hi), w32be(n >>> 0)]); }
export function wSyncsafe(n) { return new Uint8Array([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]); }
export function put32be(b, o, n) { b[o] = (n >>> 24) & 255; b[o + 1] = (n >>> 16) & 255; b[o + 2] = (n >>> 8) & 255; b[o + 3] = n & 255; }
export function put32le(b, o, n) { b[o] = n & 255; b[o + 1] = (n >>> 8) & 255; b[o + 2] = (n >>> 16) & 255; b[o + 3] = (n >>> 24) & 255; }

export function concat(arrs) {
  let len = 0; for (const a of arrs) len += a.length;
  const out = new Uint8Array(len); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}

export const ascii = (b, o = 0, n = b.length - o) => { let s = ''; for (let i = o; i < o + n && i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
export const asciiBytes = (s) => { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };

const td8 = new TextDecoder('utf-8');
const tdLatin1 = new TextDecoder('windows-1252');
const tdUtf16le = new TextDecoder('utf-16le');
const tdUtf16be = new TextDecoder('utf-16be');
const te = new TextEncoder();

export const utf8 = (b) => td8.decode(b);
export const utf8Bytes = (s) => te.encode(s);

export function latin1(b) {
  // ISO-8859-1 strictly: map bytes 1:1 (windows-1252 differs in 0x80–0x9F, but players commonly treat as cp1252)
  return tdLatin1.decode(b);
}
export function latin1Bytes(s) { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
export const isLatin1 = (s) => /^[\x00-\xff]*$/.test(s);

/** Decode ID3 text by encoding byte: 0 latin1, 1 utf16 w/ BOM, 2 utf16be, 3 utf8 */
export function decodeText(enc, b) {
  if (!b.length) return '';
  switch (enc) {
    case 1: {
      if (b[0] === 0xff && b[1] === 0xfe) return tdUtf16le.decode(b.subarray(2 - 0 + 0)).replace(/^\uFEFF/, '');
      if (b[0] === 0xfe && b[1] === 0xff) return tdUtf16be.decode(b.subarray(2));
      return tdUtf16le.decode(b);
    }
    case 2: return tdUtf16be.decode(b);
    case 3: return utf8(b);
    default: return latin1(b);
  }
}
export function encodeText(enc, s) {
  switch (enc) {
    case 1: { const u = new Uint8Array(2 + s.length * 2); u[0] = 0xff; u[1] = 0xfe; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[2 + i * 2] = c & 255; u[3 + i * 2] = c >> 8; } return u; }
    case 2: { const u = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); u[i * 2] = c >> 8; u[i * 2 + 1] = c & 255; } return u; }
    case 3: return utf8Bytes(s);
    default: return latin1Bytes(s);
  }
}
/** Find terminator for encoding (1 or 2 zero bytes aligned) from offset. Returns index of terminator start or -1. */
export function findTerm(b, o, enc) {
  if (enc === 1 || enc === 2) { for (let i = o; i + 1 < b.length; i += 2) if (b[i] === 0 && b[i + 1] === 0) return i; return -1; }
  for (let i = o; i < b.length; i++) if (b[i] === 0) return i;
  return -1;
}
export const termLen = (enc) => (enc === 1 || enc === 2 ? 2 : 1);

export function mimeFromBytes(b) {
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg';
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'image/webp';
  if (b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return 'image/jpeg';
}
export function imageSize(b) {
  try {
    if (b[0] === 0x89 && b[1] === 0x50) return { w: u32be(b, 16), h: u32be(b, 20) };
    if (b[0] === 0xff && b[1] === 0xd8) {
      let o = 2;
      while (o + 9 < b.length) {
        if (b[o] !== 0xff) { o++; continue; }
        const m = b[o + 1]; const len = u16be(b, o + 2);
        if ((m >= 0xc0 && m <= 0xc3) || (m >= 0xc5 && m <= 0xc7) || (m >= 0xc9 && m <= 0xcb) || (m >= 0xcd && m <= 0xcf)) return { h: u16be(b, o + 5), w: u16be(b, o + 7) };
        o += 2 + len;
      }
    }
    if (b[0] === 0x47 && b[1] === 0x49) return { w: u16le(b, 6), h: u16le(b, 8) };
  } catch { /* ignore */ }
  return null;
}

/* Ogg CRC32 (poly 0x04C11DB7, no reflection, init 0) */
let OGG_TABLE = null;
export function oggCrc(b) {
  if (!OGG_TABLE) {
    OGG_TABLE = new Uint32Array(256);
    for (let i = 0; i < 256; i++) { let r = i << 24; for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; OGG_TABLE[i] = r >>> 0; }
  }
  let crc = 0;
  for (let i = 0; i < b.length; i++) crc = ((crc << 8) ^ OGG_TABLE[((crc >>> 24) ^ b[i]) & 255]) >>> 0;
  return crc >>> 0;
}

/** 80-bit IEEE extended (AIFF sample rate) */
export function readExtended80(b, o) {
  const exp = ((b[o] & 0x7f) << 8) | b[o + 1];
  const hi = u32be(b, o + 2); const lo = u32be(b, o + 6);
  if (!exp && !hi && !lo) return 0;
  const sign = b[o] & 0x80 ? -1 : 1;
  return sign * (hi * 2 ** (exp - 16383 - 31) + lo * 2 ** (exp - 16383 - 63));
}
