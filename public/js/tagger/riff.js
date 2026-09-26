// WAV (RIFF) and AIFF/AIFC: tags stored in an "id3 " chunk (+ LIST/INFO for WAV).
import { readSlice, ascii, asciiBytes, u32le, u32be, u16le, u16be, w32le, w32be, concat, latin1, latin1Bytes, readExtended80 } from './bytes.js';
import { parseID3v2, id3ToModel, buildID3v2 } from './id3.js';
import { emptyModel } from './model.js';

const INFO = { INAM: 'title', IART: 'artist', IPRD: 'album', ICMT: 'comment', ICRD: 'year', IGNR: 'genre', ITRK: 'track', IPRT: 'track', ICOP: 'copyright', IENG: 'encodedby', ICMS: 'composer' };
const INFO_W = { title: 'INAM', artist: 'IART', album: 'IPRD', comment: 'ICMT', year: 'ICRD', genre: 'IGNR', track: 'ITRK', copyright: 'ICOP', composer: 'ICMS' };

async function chunks(file, le) {
  const h = await readSlice(file, 0, 12);
  const out = []; let o = 12;
  const riffSize = le ? u32le(h, 4) : u32be(h, 4);
  const end = Math.min(file.size, 8 + riffSize + 1);
  while (o + 8 <= end) {
    const c = await readSlice(file, o, o + 8);
    const id = ascii(c, 0, 4); const size = le ? u32le(c, 4) : u32be(c, 4);
    if (!/^[\x20-\x7e]{4}$/.test(id)) break;
    out.push({ id, off: o, size });
    o += 8 + size + (size & 1);
  }
  return { form: ascii(h, 8, 4), list: out, end: o };
}

export async function readRiff(file) {
  const head = await readSlice(file, 0, 12);
  const isWav = ascii(head, 0, 4) === 'RIFF';
  const le = isWav;
  const { form, list } = await chunks(file, le);
  const model = emptyModel(isWav ? 'WAV' : form === 'AIFC' ? 'AIFF-C' : 'AIFF');
  let info = {};
  for (const c of list) {
    const body = () => readSlice(file, c.off + 8, c.off + 8 + c.size);
    if (isWav && c.id === 'fmt ') {
      const b = await body(); const fmt = u16le(b, 0);
      model.props = { codec: fmt === 1 ? 'PCM' : fmt === 3 ? 'PCM float' : fmt === 0xfffe ? 'PCM (extensible)' : `WAV format ${fmt}`, channels: u16le(b, 2), sampleRate: u32le(b, 4), byteRate: u32le(b, 8), bitsPerSample: u16le(b, 14) };
    } else if (isWav && c.id === 'data') {
      model.props.dataSize = c.size;
    } else if (!isWav && c.id === 'COMM') {
      const b = await body(); const ch = u16be(b, 0); const frames = u32be(b, 2); const bits = u16be(b, 6); const rate = readExtended80(b, 8);
      model.props = { codec: form === 'AIFC' ? `AIFF-C ${ascii(b, 18, 4)}` : 'PCM', channels: ch, sampleRate: Math.round(rate), bitsPerSample: bits, duration: rate ? frames / rate : 0 };
      model.props.bitrate = Math.round((rate * ch * bits) / 1000);
    } else if (c.id === 'id3 ' || c.id === 'ID3 ') {
      const b = await body();
      if (ascii(b, 0, 3) === 'ID3') { const tag = parseID3v2(b); id3ToModel(tag, model); model.props.id3 = `2.${tag.major}`; }
    } else if (isWav && c.id === 'LIST') {
      const b = await body();
      if (ascii(b, 0, 4) === 'INFO') {
        let o = 4;
        while (o + 8 <= b.length) {
          const id = ascii(b, o, 4); const sz = u32le(b, o + 4);
          const v = latin1(b.subarray(o + 8, o + 8 + sz)).replace(/\0+$/, '').trim();
          if (INFO[id] && v) info[INFO[id]] = v;
          o += 8 + sz + (sz & 1);
        }
      }
    } else if (!isWav && ['NAME', 'AUTH', '(c) ', 'ANNO'].includes(c.id)) {
      const v = latin1(await body()).replace(/\0+$/, '').trim();
      info[{ NAME: 'title', AUTH: 'artist', '(c) ': 'copyright', ANNO: 'comment' }[c.id]] = v;
    }
  }
  for (const [k, v] of Object.entries(info)) if (!model.fields[k]) model.fields[k] = v;
  if (isWav && model.props.byteRate && model.props.dataSize) {
    model.props.duration = model.props.dataSize / model.props.byteRate;
    model.props.bitrate = Math.round((model.props.byteRate * 8) / 1000);
  }
  return model;
}

function chunk(id, body, le) {
  const parts = [asciiBytes(id), le ? w32le(body.length) : w32be(body.length), body];
  if (body.length & 1) parts.push(new Uint8Array(1));
  return concat(parts);
}

export async function writeRiff(file, model, { id3Version = 3, writeInfo = true } = {}) {
  const head = await readSlice(file, 0, 12);
  const isWav = ascii(head, 0, 4) === 'RIFF'; const le = isWav;
  const { list } = await chunks(file, le);
  let origTag = null;
  const parts = [];
  for (const c of list) {
    if (c.id === 'id3 ' || c.id === 'ID3 ') {
      const b = await readSlice(file, c.off + 8, c.off + 8 + c.size);
      if (ascii(b, 0, 3) === 'ID3') { origTag = parseID3v2(b); id3ToModel(origTag, emptyModel()); }
      continue;
    }
    if (isWav && c.id === 'LIST') {
      const t = ascii(await readSlice(file, c.off + 8, c.off + 12));
      if (t === 'INFO') continue;
    }
    const len = 8 + c.size + (c.size & 1);
    parts.push(file.slice(c.off, Math.min(file.size, c.off + len)));
    if (c.off + len > file.size) parts.push(new Uint8Array(c.off + len - file.size)); // pad truncated odd chunk
  }
  const extra = [];
  if (isWav && writeInfo) {
    const sub = [asciiBytes('INFO')];
    for (const [field, id] of Object.entries(INFO_W)) {
      const v = model.fields[field]; if (!v) continue;
      const bytes = concat([latin1Bytes([...v].map((ch) => (ch.charCodeAt(0) < 256 ? ch : '?')).join('')), new Uint8Array([0])]);
      sub.push(chunk(id, bytes, true));
    }
    if (sub.length > 1) extra.push(chunk('LIST', concat(sub), true));
  }
  const { bytes } = buildID3v2(model, { version: id3Version, original: origTag, padding: 0 });
  extra.push(chunk(isWav ? 'id3 ' : 'ID3 ', bytes, le));
  let bodySize = 4; for (const p of parts) bodySize += p.size ?? p.length; for (const e of extra) bodySize += e.length;
  const header = concat([asciiBytes(isWav ? 'RIFF' : 'FORM'), le ? w32le(bodySize) : w32be(bodySize), head.subarray(8, 12)]);
  return new Blob([header, ...parts, ...extra], { type: isWav ? 'audio/wav' : 'audio/aiff' });
}
