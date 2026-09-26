// Format detection and unified read/write entry points.
import { readSlice, ascii, concat } from './bytes.js';
import { id3v2Size, parseID3v2, id3ToModel, buildID3v2, parseID3v1, buildID3v1 } from './id3.js';
import { mpegProps } from './mpeg.js';
import { readFlac, writeFlac } from './flac.js';
import { readOgg, writeOgg } from './ogg.js';
import { readMp4, writeMp4 } from './mp4.js';
import { readRiff, writeRiff } from './riff.js';
import { emptyModel, cleanModel } from './model.js';

export const AUDIO_EXT = /\.(mp3|mp2|flac|m4a|m4b|m4p|mp4|aac|alac|ogg|oga|opus|wav|wave|aif|aiff|aifc)$/i;

export async function detectFormat(file) {
  const h = await readSlice(file, 0, 64);
  let o = 0;
  const tagLen = id3v2Size(h);
  if (tagLen) {
    const after = await readSlice(file, tagLen, tagLen + 12);
    if (ascii(after, 0, 4) === 'fLaC') return 'flac';
    return 'mp3';
  }
  if (ascii(h, 0, 4) === 'fLaC') return 'flac';
  if (ascii(h, 0, 4) === 'OggS') return 'ogg';
  if (ascii(h, 4, 4) === 'ftyp') return 'mp4';
  if (ascii(h, 0, 4) === 'RIFF' && ascii(h, 8, 4) === 'WAVE') return 'wav';
  if (ascii(h, 0, 4) === 'FORM' && /^AIF[FC]$/.test(ascii(h, 8, 4))) return 'aiff';
  if (h[o] === 0xff && (h[o + 1] & 0xe0) === 0xe0 && (h[o + 1] & 0x06) !== 0) return 'mp3';
  const ext = (file.name || '').toLowerCase().split('.').pop();
  if (['mp3', 'mp2'].includes(ext)) return 'mp3';
  if (['m4a', 'm4b', 'mp4', 'aac'].includes(ext) && ascii(h, 4, 4) === 'ftyp') return 'mp4';
  return null;
}

async function mp3Layout(file) {
  const head = await readSlice(file, 0, 10);
  const tagLen = id3v2Size(head);
  let tag = null;
  if (tagLen) { try { tag = parseID3v2(await readSlice(file, 0, tagLen)); } catch (e) { tag = null; } }
  const tail = await readSlice(file, Math.max(0, file.size - 128), file.size);
  const v1 = parseID3v1(tail);
  let audioEnd = file.size - (v1 ? 128 : 0);
  // APEv2 footer before ID3v1 — kept (lives inside audio range)
  const apeFoot = await readSlice(file, audioEnd - 32, audioEnd);
  const ape = ascii(apeFoot, 0, 8) === 'APETAGEX';
  return { tagLen, tag, v1, audioStart: tagLen, audioEnd, ape };
}

export async function readTags(file) {
  const fmt = await detectFormat(file);
  if (!fmt) throw new Error('Unsupported or unrecognised audio format');
  let model;
  switch (fmt) {
    case 'mp3': {
      const L = await mp3Layout(file);
      model = emptyModel('MP3');
      if (L.tag) { id3ToModel(L.tag, model); model.props.id3 = `2.${L.tag.major}`; }
      if (L.v1) { for (const [k, v] of Object.entries(L.v1)) if (!model.fields[k]) model.fields[k] = v; model.props.id3v1 = true; }
      if (L.ape) model.notes.push('APEv2 tag present (kept unchanged).');
      Object.assign(model.props, await mpegProps(file, L.audioStart, L.audioEnd));
      break;
    }
    case 'flac': model = await readFlac(file); break;
    case 'ogg': model = await readOgg(file); break;
    case 'mp4': model = await readMp4(file); break;
    case 'wav': case 'aiff': model = await readRiff(file); break;
    default: throw new Error('Unsupported format');
  }
  model.kind = fmt;
  return cleanModel(model);
}

/**
 * Write tags. opts: {id3Version: 3|4, id3v1: 'keep'|'update'|'remove'|'always', flacPadding}
 * Returns {blob, notes}
 */
export async function writeTags(file, model, opts = {}) {
  const fmt = await detectFormat(file);
  const m = cleanModel({ ...model, fields: { ...model.fields }, custom: [...(model.custom || [])], pictures: [...(model.pictures || [])], notes: [] });
  const notes = [];
  let blob;
  switch (fmt) {
    case 'mp3': {
      const L = await mp3Layout(file);
      const version = opts.id3Version === 4 ? 4 : 3;
      const empty = !Object.keys(m.fields).length && !m.custom.length && !m.pictures.length;
      let tagBytes = new Uint8Array(0);
      if (!empty || (!opts.strip && L.tag && L.tag.frames.some((f) => !f.mapped))) {
        const r = buildID3v2(m, { version, original: opts.strip ? null : L.tag, padding: opts.padding ?? 1024 });
        tagBytes = r.bytes; notes.push(...r.notes);
      }
      const mode = opts.id3v1 || 'update';
      let v1 = new Uint8Array(0);
      if (mode === 'always' || (mode === 'update' && L.v1)) v1 = buildID3v1(m.fields);
      else if (mode === 'keep' && L.v1) v1 = await readSlice(file, file.size - 128, file.size);
      blob = new Blob([tagBytes, file.slice(L.audioStart, L.audioEnd), v1], { type: 'audio/mpeg' });
      break;
    }
    case 'flac': blob = await writeFlac(file, m, { padding: opts.flacPadding ?? 4096 }); break;
    case 'ogg': blob = await writeOgg(file, m); break;
    case 'mp4': blob = await writeMp4(file, m, { strip: !!opts.strip }); break;
    case 'wav': case 'aiff': blob = await writeRiff(file, m, { id3Version: opts.id3Version === 4 ? 4 : 3 }); break;
    default: throw new Error('Unsupported format for writing');
  }
  return { blob, notes };
}

export { concat };
