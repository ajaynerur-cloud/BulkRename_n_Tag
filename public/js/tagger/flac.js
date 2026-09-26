// FLAC metadata: read STREAMINFO/VORBIS_COMMENT/PICTURE, rebuild metadata blocks on write.
import { readSlice, ascii, u24be, u32be, concat, asciiBytes } from './bytes.js';
import { id3v2Size } from './id3.js';
import { parseVorbisComment, buildVorbisComment, commentsToModel, modelToComments, parsePictureBlock, buildPictureBlock } from './vorbis.js';
import { emptyModel } from './model.js';

async function scan(file) {
  const head = await readSlice(file, 0, 10);
  const skip = id3v2Size(head);
  let o = skip;
  if (ascii(await readSlice(file, o, o + 4)) !== 'fLaC') throw new Error('Not a FLAC stream');
  o += 4; const blocks = [];
  for (;;) {
    const h = await readSlice(file, o, o + 4);
    if (h.length < 4) throw new Error('Truncated FLAC metadata');
    const last = !!(h[0] & 0x80); const type = h[0] & 0x7f; const len = u24be(h, 1);
    blocks.push({ type, len, offset: o, last });
    o += 4 + len;
    if (last) break;
    if (blocks.length > 1000) throw new Error('Corrupt FLAC metadata');
  }
  return { skip, blocks, audioStart: o };
}

export async function readFlac(file) {
  const s = await scan(file);
  const model = emptyModel('FLAC');
  let vendor = '';
  for (const b of s.blocks) {
    if (b.type === 0) {
      const d = await readSlice(file, b.offset + 4, b.offset + 4 + b.len);
      const sampleRate = (d[10] << 12) | (d[11] << 4) | (d[12] >> 4);
      const channels = ((d[12] >> 1) & 7) + 1; const bits = (((d[12] & 1) << 4) | (d[13] >> 4)) + 1;
      const total = (d[13] & 0x0f) * 4294967296 + u32be(d, 14);
      const duration = sampleRate ? total / sampleRate : 0;
      model.props = { codec: 'FLAC', sampleRate, channels, bitsPerSample: bits, duration, bitrate: duration ? Math.round(((file.size - s.audioStart) * 8) / duration / 1000) : 0 };
    } else if (b.type === 4) {
      const d = await readSlice(file, b.offset + 4, b.offset + 4 + b.len);
      const vc = parseVorbisComment(d); vendor = vc.vendor; commentsToModel(vc.comments, model);
    } else if (b.type === 6) {
      try { model.pictures.push(parsePictureBlock(await readSlice(file, b.offset + 4, b.offset + 4 + b.len))); } catch { model.notes.push('Unreadable picture block'); }
    }
  }
  if (s.skip) model.notes.push('File has an ID3 tag before the FLAC stream (kept unchanged).');
  model.props.vendor = vendor;
  return model;
}

function blockHeader(type, len, last) { return new Uint8Array([(last ? 0x80 : 0) | type, (len >> 16) & 255, (len >> 8) & 255, len & 255]); }

export async function writeFlac(file, model, { padding = 4096 } = {}) {
  const s = await scan(file);
  const keep = [];
  let vendor = 'NameTag';
  for (const b of s.blocks) {
    if (b.type === 4) { try { vendor = parseVorbisComment(await readSlice(file, b.offset + 4, b.offset + 4 + b.len)).vendor || vendor; } catch { /* ignore */ } continue; }
    if (b.type === 1 || b.type === 6) continue;
    keep.push({ type: b.type, data: await readSlice(file, b.offset + 4, b.offset + 4 + b.len) });
  }
  keep.sort((a, b) => (a.type === 0 ? -1 : b.type === 0 ? 1 : 0));
  keep.push({ type: 4, data: buildVorbisComment(vendor, modelToComments(model)) });
  for (const p of model.pictures || []) {
    const d = buildPictureBlock(p);
    if (d.length >= 1 << 24) throw new Error('Picture too large for FLAC (max 16 MB)');
    keep.push({ type: 6, data: d });
  }
  if (padding > 0) keep.push({ type: 1, data: new Uint8Array(padding) });
  const parts = [s.skip ? await readSlice(file, 0, s.skip) : new Uint8Array(0), asciiBytes('fLaC')];
  keep.forEach((b, i) => parts.push(blockHeader(b.type, b.data.length, i === keep.length - 1), b.data));
  return new Blob([concat(parts), file.slice(s.audioStart)], { type: 'audio/flac' });
}
