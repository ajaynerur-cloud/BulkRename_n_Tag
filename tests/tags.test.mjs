// Round-trip tests for the tag engine on real fixture files (generated with ffmpeg + mutagen, see tests/fixtures).
// Writes each format twice (ID3v2.3 then v2.4), checks values survive, pictures survive, and passthrough fields stay.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { readTags, writeTags } from '../public/js/tagger/index.js';

const dir = new URL('./fixtures/', import.meta.url);
const cover = new Uint8Array(readFileSync(new URL('cover.jpg', dir)));
const files = readdirSync(dir).filter((n) => /\.(mp3|flac|m4a|ogg|opus|wav|aiff)$/.test(n));
let pass = 0;
for (const n of files) {
  for (const id3Version of [3, 4]) {
    try {
      const file = new File([readFileSync(new URL(n, dir))], n);
      const m = await readTags(file);
      Object.assign(m.fields, { title: 'Nüw Tïtle ✓ 日本', artist: 'A / B', album: 'Album X', track: '7', tracktotal: '9', year: '2020', genre: 'Rock', comment: 'hello', lyrics: 'la '.repeat(n.includes('og') || n.includes('opus') ? 30000 : 50) });
      m.custom = [...(m.custom || []).filter((c) => c.key !== 'MYKEY'), { key: 'MYKEY', value: 'myval' }];
      m.pictures = [{ type: 3, mime: 'image/jpeg', desc: '', data: cover }];
      const { blob } = await writeTags(file, m, { id3Version });
      const out = new File([await blob.arrayBuffer()], n);
      const m2 = await readTags(out);
      for (const k of ['title', 'artist', 'album', 'track', 'tracktotal', 'genre']) assert.equal(m2.fields[k], m.fields[k], `${k}`);
      assert.ok(String(m2.fields.year).startsWith('2020'), 'year');
      assert.equal(m2.fields.lyrics, m.fields.lyrics, 'lyrics');
      assert.equal(m2.pictures.length, 1, 'picture count');
      assert.deepEqual([...m2.pictures[0].data.slice(0, 16)], [...cover.slice(0, 16)], 'picture bytes');
      assert.ok(m2.custom.some((c) => c.key.toUpperCase() === 'MYKEY' && c.value === 'myval'), 'custom field');
      // write again on top of the edited file (tags grow/shrink)
      m2.fields.lyrics = ''; m2.pictures = [];
      const { blob: b3 } = await writeTags(out, m2, { id3Version });
      const m3 = await readTags(new File([await b3.arrayBuffer()], n));
      assert.equal(m3.fields.title, m.fields.title);
      assert.equal(m3.pictures.length, 0);
      assert.ok(!m3.fields.lyrics);
      pass++;
      if (n.match(/\.(m4a|mp3|flac|wav|aiff)$/) && id3Version === 4) continue;
    } catch (e) { console.error('FAIL', n, `v2.${id3Version}`, e.message); process.exitCode = 1; }
  }
}
console.log(`tags: ${pass} round-trips passed (${files.length} formats x 2)`);
