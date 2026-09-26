// Ogg Vorbis and Ogg Opus: comment header read/write with correct repagination and CRCs.
import { readSlice, ascii, asciiBytes, u32le, u16le, u64le, concat, oggCrc, put32le } from './bytes.js';
import { parseVorbisComment, buildVorbisComment, commentsToModel, modelToComments } from './vorbis.js';
import { emptyModel } from './model.js';

function parsePage(b, o) {
  if (o + 27 > b.length || ascii(b, o, 4) !== 'OggS') return null;
  const nseg = b[o + 26]; if (o + 27 + nseg > b.length) return null;
  const lacing = b.subarray(o + 27, o + 27 + nseg);
  let bodyLen = 0; for (const l of lacing) bodyLen += l;
  const headerLen = 27 + nseg;
  if (o + headerLen + bodyLen > b.length) return null;
  return {
    offset: o, flags: b[o + 5], granuleLo: u32le(b, o + 6), granuleHi: u32le(b, o + 10), granule: u64le(b, o + 6), serial: u32le(b, o + 14), seq: u32le(b, o + 18),
    lacing, headerLen, bodyLen, length: headerLen + bodyLen, body: b.subarray(o + headerLen, o + headerLen + bodyLen),
  };
}

/** Incrementally read pages from a Blob */
async function readHeaderPackets(file, want = 3) {
  let pos = 0; const packets = []; let cur = []; let serial = null; const pages = [];
  let kind = null;
  while (pos < file.size && packets.length < want) {
    const h = await readSlice(file, pos, pos + 27 + 255);
    if (ascii(h, 0, 4) !== 'OggS') throw new Error('Invalid Ogg page');
    const nseg = h[26]; let bodyLen = 0; for (let i = 0; i < nseg; i++) bodyLen += h[27 + i];
    const full = await readSlice(file, pos, pos + 27 + nseg + bodyLen);
    const pg = parsePage(full, 0); if (!pg) throw new Error('Truncated Ogg page');
    if (serial === null) serial = pg.serial;
    if (pg.serial !== serial) { pos += pg.length; continue; }
    pg.offset = pos; pages.push(pg);
    let bo = 0;
    for (const l of pg.lacing) {
      cur.push(pg.body.subarray(bo, bo + l)); bo += l;
      if (l < 255) { packets.push(concat(cur)); cur = []; if (packets.length === 1) { kind = ascii(packets[0], 0, 8) === 'OpusHead' ? 'opus' : ascii(packets[0], 1, 6) === 'vorbis' ? 'vorbis' : ascii(packets[0], 0, 5) === '\x7fFLAC' ? 'flac' : 'unknown'; if (kind === 'opus') want = 2; } }
    }
    pos += pg.length;
  }
  return { packets, pages, serial, kind, headerEnd: pos };
}

async function lastGranule(file, serial) {
  const tail = await readSlice(file, Math.max(0, file.size - 65536 * 2), file.size);
  for (let i = tail.length - 27; i >= 0; i--) {
    if (tail[i] === 0x4f && ascii(tail, i, 4) === 'OggS' && u32le(tail, i + 14) === serial) {
      const g = u64le(tail, i + 6); if (g < 2 ** 53) return g;
    }
  }
  return 0;
}

export async function readOgg(file) {
  const { packets, serial, kind } = await readHeaderPackets(file);
  if (kind !== 'opus' && kind !== 'vorbis') throw new Error(kind === 'flac' ? 'Ogg FLAC is not supported' : 'Unsupported Ogg codec');
  const model = emptyModel(kind === 'opus' ? 'Opus' : 'Ogg Vorbis');
  const id = packets[0]; const com = packets[1];
  if (!com) throw new Error('Missing comment header');
  let vc;
  if (kind === 'opus') {
    const preskip = u16le(id, 10); const rate = u32le(id, 12);
    vc = parseVorbisComment(com, 8);
    const g = await lastGranule(file, serial);
    const duration = g ? Math.max(0, (g - preskip) / 48000) : 0;
    model.props = { codec: 'Opus', channels: id[9], sampleRate: rate || 48000, duration, bitrate: duration ? Math.round((file.size * 8) / duration / 1000) : 0 };
  } else {
    const channels = id[11]; const rate = u32le(id, 12); const nominal = u32le(id, 20);
    vc = parseVorbisComment(com, 7);
    const g = await lastGranule(file, serial);
    const duration = g && rate ? g / rate : 0;
    model.props = { codec: 'Vorbis', channels, sampleRate: rate, duration, bitrate: duration ? Math.round((file.size * 8) / duration / 1000) : Math.round(nominal / 1000) };
  }
  model.props.vendor = vc.vendor;
  commentsToModel(vc.comments, model);
  return model;
}

function paginate(packets, serial, startSeq) {
  // Build lacing for all packets, then split into pages of <=255 segments (and ~<=64KB bodies)
  const pages = []; let seq = startSeq;
  let segs = []; let bodyParts = []; let continued = false; let packetEnded = false;
  const flush = (nextContinued) => {
    const lac = new Uint8Array(segs.map((s) => s.len));
    const body = concat(bodyParts);
    const h = new Uint8Array(27 + lac.length);
    h.set(asciiBytes('OggS')); h[4] = 0; h[5] = continued ? 1 : 0;
    // granule: 0 when a packet ends on this page (header packets), else -1
    if (packetEnded) { put32le(h, 6, 0); put32le(h, 10, 0); } else { put32le(h, 6, 0xffffffff); put32le(h, 10, 0xffffffff); }
    put32le(h, 14, serial); put32le(h, 18, seq++); h[26] = lac.length; h.set(lac, 27);
    const page = concat([h, body]);
    put32le(page, 22, oggCrc(page));
    pages.push(page);
    segs = []; bodyParts = []; continued = nextContinued; packetEnded = false;
  };
  for (const p of packets) {
    let o = 0; const n = p.length;
    for (;;) {
      const len = Math.min(255, n - o);
      segs.push({ len }); bodyParts.push(p.subarray(o, o + len)); o += len;
      const end = len < 255;
      if (end) packetEnded = true;
      if (segs.length === 255) flush(!end);
      if (end) break;
    }
  }
  if (segs.length) flush(false);
  return pages;
}

export async function writeOgg(file, model) {
  const buf = new Uint8Array(await file.arrayBuffer());
  // parse all pages
  const pages = []; let o = 0; let serial = null;
  while (o < buf.length) {
    const pg = parsePage(buf, o);
    if (!pg) { if (o < buf.length) throw new Error('Corrupt Ogg data at byte ' + o); break; }
    if (serial === null) serial = pg.serial;
    if (pg.serial !== serial) throw new Error('Multiplexed or chained Ogg streams are not supported for writing');
    pages.push(pg); o += pg.length;
  }
  // collect header packets
  const kind = ascii(pages[0].body, 0, 8) === 'OpusHead' ? 'opus' : 'vorbis';
  const want = kind === 'opus' ? 2 : 3;
  const packets = []; let cur = []; let lastHeaderPage = -1;
  for (let i = 0; i < pages.length && packets.length < want; i++) {
    const pg = pages[i]; let bo = 0;
    for (let j = 0; j < pg.lacing.length; j++) {
      const l = pg.lacing[j]; cur.push(pg.body.subarray(bo, bo + l)); bo += l;
      if (l < 255) {
        packets.push(concat(cur)); cur = [];
        if (packets.length === want && (j !== pg.lacing.length - 1)) throw new Error('Non-conforming Ogg: audio data shares a page with headers');
      }
    }
    lastHeaderPage = i;
  }
  if (packets.length < want) throw new Error('Incomplete Ogg headers');
  if (pages[0].lacing.length !== 1) throw new Error('Non-conforming Ogg: first page must contain only the identification header');
  // new comment packet
  const oldCom = packets[1];
  const comments = modelToComments(model, { embedPictures: true });
  let newCom;
  if (kind === 'opus') {
    const vc = parseVorbisComment(oldCom, 8);
    const trailing = oldCom.subarray(vc.end);
    const keepTrailing = trailing.length && (trailing[0] & 1) ? trailing : new Uint8Array(0);
    newCom = concat([asciiBytes('OpusTags'), buildVorbisComment(vc.vendor, comments), keepTrailing]);
  } else {
    const vc = parseVorbisComment(oldCom, 7);
    newCom = concat([new Uint8Array([3]), asciiBytes('vorbis'), buildVorbisComment(vc.vendor, comments), new Uint8Array([1])]);
  }
  const newPackets = kind === 'opus' ? [newCom] : [newCom, packets[2]];
  const newHeaderPages = paginate(newPackets, serial, 1);
  const oldCount = lastHeaderPage; // pages 1..lastHeaderPage
  const delta = newHeaderPages.length - oldCount;
  const restStart = pages[lastHeaderPage].offset + pages[lastHeaderPage].length;
  const parts = [buf.subarray(0, pages[0].length), ...newHeaderPages];
  if (delta === 0) parts.push(buf.subarray(restStart));
  else {
    for (let i = lastHeaderPage + 1; i < pages.length; i++) {
      const pg = pages[i];
      const copy = buf.slice(pg.offset, pg.offset + pg.length);
      put32le(copy, 18, (pg.seq + delta) >>> 0);
      put32le(copy, 22, 0); put32le(copy, 22, oggCrc(copy));
      parts.push(copy);
    }
  }
  return new Blob(parts, { type: kind === 'opus' ? 'audio/ogg; codecs=opus' : 'audio/ogg' });
}
