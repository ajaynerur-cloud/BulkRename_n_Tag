// MPEG audio (MP3/MP2) frame header parsing for duration/bitrate (Xing/Info/VBRI aware).
import { readSlice, u32be, u16be, ascii } from './bytes.js';

const BITRATES = {
  // [version][layer] kbps tables; version: 1 = MPEG1, 2 = MPEG2/2.5
  1: { 1: [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448], 2: [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384], 3: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] },
  2: { 1: [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], 3: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] },
};
const RATES = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function parseFrameHeader(b, o) {
  if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (b[o + 1] >> 3) & 3; const layerBits = (b[o + 1] >> 1) & 3;
  if (verBits === 1 || layerBits === 0) return null;
  const brIdx = b[o + 2] >> 4; const srIdx = (b[o + 2] >> 2) & 3; const padding = (b[o + 2] >> 1) & 1;
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const version = verBits === 3 ? 1 : 2; const layer = 4 - layerBits;
  const bitrate = BITRATES[version][layer][brIdx]; const sampleRate = RATES[verBits][srIdx];
  const channelMode = b[o + 3] >> 6;
  const samples = layer === 1 ? 384 : layer === 3 && version === 2 ? 576 : 1152;
  const frameLen = layer === 1 ? Math.floor((12 * bitrate * 1000) / sampleRate + padding) * 4 : Math.floor((samples / 8) * bitrate * 1000 / sampleRate) + padding;
  return { version, verBits, layer, bitrate, sampleRate, channels: channelMode === 3 ? 1 : 2, channelMode, samples, frameLen };
}

export async function mpegProps(file, start, end) {
  const buf = await readSlice(file, start, Math.min(end, start + 256 * 1024));
  for (let i = 0; i + 4 < buf.length; i++) {
    const h = parseFrameHeader(buf, i);
    if (!h) continue;
    // confirm with next frame
    const n = i + h.frameLen;
    if (n + 4 <= buf.length && !parseFrameHeader(buf, n)) continue;
    const props = { codec: `MPEG-${h.version === 1 ? '1' : h.verBits === 0 ? '2.5' : '2'} Layer ${['', 'I', 'II', 'III'][h.layer]}`, sampleRate: h.sampleRate, channels: h.channels, bitrate: h.bitrate, vbr: false };
    // Xing / Info
    const sideInfo = h.version === 1 ? (h.channels === 1 ? 17 : 32) : (h.channels === 1 ? 9 : 17);
    const x = i + 4 + sideInfo;
    const tagId = ascii(buf, x, 4);
    const audioBytes = end - (start + i);
    if (tagId === 'Xing' || tagId === 'Info') {
      const flags = u32be(buf, x + 4); let p = x + 8;
      let frames = 0; let bytes = 0;
      if (flags & 1) { frames = u32be(buf, p); p += 4; }
      if (flags & 2) { bytes = u32be(buf, p); p += 4; }
      if (frames) {
        props.duration = (frames * h.samples) / h.sampleRate;
        props.bitrate = Math.round(((bytes || audioBytes) * 8) / props.duration / 1000);
        props.vbr = tagId === 'Xing';
      }
      const enc = ascii(buf, x + 120, 9).replace(/[^\x20-\x7e]/g, '').trim();
      if (enc && /^LAME|^Lavf|^Lavc/.test(enc)) props.encoder = enc;
    } else if (ascii(buf, i + 36, 4) === 'VBRI') {
      const v = i + 36; const bytes = u32be(buf, v + 10); const frames = u32be(buf, v + 14);
      if (frames) { props.duration = (frames * h.samples) / h.sampleRate; props.bitrate = Math.round((bytes * 8) / props.duration / 1000); props.vbr = true; }
      void u16be;
    }
    if (!props.duration && h.bitrate) props.duration = (audioBytes * 8) / (h.bitrate * 1000);
    return props;
  }
  return { codec: 'MPEG audio' };
}
