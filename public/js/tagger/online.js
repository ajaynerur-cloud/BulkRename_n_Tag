// Optional online lookups (only when the user asks): MusicBrainz releases, Cover Art Archive, LRCLIB lyrics.
// MusicBrainz allows ~1 request/second per client — requests are serialized and spaced.
const MB = 'https://musicbrainz.org/ws/2';
let lastMB = 0;

async function mbFetch(path) {
  const wait = Math.max(0, lastMB + 1100 - Date.now());
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastMB = Date.now();
  const url = `${MB}${path}${path.includes('?') ? '&' : '?'}fmt=json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (res.status === 503) throw new Error('MusicBrainz is rate limiting — try again in a few seconds');
  if (!res.ok) throw new Error(`MusicBrainz error ${res.status}`);
  return res.json();
}
const q = (s) => `"${String(s).replace(/(["\\])/g, '\\$1')}"`;

export async function searchReleases({ artist, album, tracks } = {}) {
  const parts = [];
  if (album) parts.push(`release:${q(album)}`);
  if (artist) parts.push(`artist:${q(artist)}`);
  if (tracks) parts.push(`tracks:${tracks}`);
  if (!parts.length) throw new Error('Enter an artist or album to search');
  const data = await mbFetch(`/release/?query=${encodeURIComponent(parts.join(' AND '))}&limit=15`);
  return (data.releases || []).map((r) => ({
    id: r.id, title: r.title, artist: (r['artist-credit'] || []).map((a) => a.name + (a.joinphrase || '')).join(''),
    date: r.date || '', country: r.country || '', tracks: r['track-count'], score: r.score,
    format: (r.media || []).map((m) => m.format).filter(Boolean).join(' + '), label: r['label-info']?.[0]?.label?.name || '',
    status: r.status || '',
  }));
}

export async function getRelease(id) {
  const r = await mbFetch(`/release/${id}?inc=recordings+artist-credits+labels+release-groups+genres+isrcs`);
  const credit = (ac) => (ac || []).map((a) => a.name + (a.joinphrase || '')).join('');
  const albumartist = credit(r['artist-credit']);
  const genre = (r.genres?.length ? r.genres : r['release-group']?.genres || []).sort((a, b) => b.count - a.count).slice(0, 2).map((g) => cap(g.name)).join('; ');
  const media = r.media || [];
  const tracks = [];
  media.forEach((m, di) => {
    for (const t of m.tracks || []) {
      tracks.push({
        disc: String(m.position || di + 1), disctotal: String(media.length), track: String(t.position), tracktotal: String(m['track-count'] || m.tracks.length),
        title: t.title, artist: credit(t['artist-credit']) || albumartist, length: t.length ? t.length / 1000 : null, isrc: t.recording?.isrcs?.[0] || '',
      });
    }
  });
  return {
    id: r.id, album: r.title, albumartist, year: r.date || '', publisher: r['label-info']?.[0]?.label?.name || '', genre, tracks,
    coverFront: r['cover-art-archive']?.front ? `https://coverartarchive.org/release/${r.id}/front-1200` : null,
  };
}
const cap = (s) => s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());

/** Match release tracks to files: by existing track numbers, else by duration/title similarity, else order */
export function matchTracks(files, tracks) {
  const byNum = new Map(tracks.map((t) => [`${t.disc}:${t.track}`, t]));
  const used = new Set(); const out = new Map();
  for (const f of files) {
    const d = f.fields.disc || '1'; const t = f.fields.track;
    const hit = t && (byNum.get(`${d}:${t}`) || byNum.get(`1:${t}`));
    if (hit && !used.has(hit)) { out.set(f.path, hit); used.add(hit); }
  }
  for (const f of files) {
    if (out.has(f.path)) continue;
    let best = null; let bestScore = -1;
    for (const t of tracks) {
      if (used.has(t)) continue;
      let s = similarity(f.fields.title || f.name, t.title) * 2;
      if (f.duration && t.length) s += Math.max(0, 1 - Math.abs(f.duration - t.length) / 10);
      if (s > bestScore) { bestScore = s; best = t; }
    }
    if (best && bestScore > 0.5) { out.set(f.path, best); used.add(best); }
  }
  // remaining by order
  const rest = tracks.filter((t) => !used.has(t));
  for (const f of files) if (!out.has(f.path) && rest.length) out.set(f.path, rest.shift());
  return out;
}
function norm(s) { return (s || '').toLowerCase().normalize('NFD').replace(/\p{M}/gu, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
export function similarity(a, b) {
  a = norm(a); b = norm(b); if (!a || !b) return 0; if (a === b) return 1;
  if (a.includes(b) || b.includes(a)) return 0.8;
  const A = new Set(a.split(' ')); const B = new Set(b.split(' '));
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / Math.max(A.size, B.size);
}

/** Try to fetch cover bytes (CAA redirects to archive.org, which may block CORS) */
export async function fetchCover(url) {
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`Cover download failed (${res.status})`);
  const b = new Uint8Array(await res.arrayBuffer());
  return { data: b, mime: res.headers.get('content-type') || 'image/jpeg' };
}

export async function fetchLyrics({ artist, title, album, duration }) {
  if (!artist || !title) throw new Error('Artist and title are needed to look up lyrics');
  const p = new URLSearchParams({ artist_name: artist, track_name: title });
  if (album) p.set('album_name', album);
  if (duration) p.set('duration', String(Math.round(duration)));
  let res = await fetch(`https://lrclib.net/api/get?${p}`);
  if (res.status === 404) {
    res = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ track_name: title, artist_name: artist })}`);
    if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
    const list = await res.json();
    const hit = list.find((x) => x.plainLyrics || x.syncedLyrics);
    if (!hit) return null;
    return { plain: hit.plainLyrics || '', synced: hit.syncedLyrics || '', instrumental: !!hit.instrumental };
  }
  if (!res.ok) throw new Error(`LRCLIB error ${res.status}`);
  const d = await res.json();
  return { plain: d.plainLyrics || '', synced: d.syncedLyrics || '', instrumental: !!d.instrumental };
}
