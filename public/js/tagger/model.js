// Format-independent tag model.
// model = { fields: {key: string}, custom: [{key, value}], pictures: [{type, mime, desc, data: Uint8Array}], props: {...}, format, notes: [] }

export const FIELDS = [
  { key: 'title', label: 'Title', main: true },
  { key: 'artist', label: 'Artist', main: true },
  { key: 'album', label: 'Album', main: true },
  { key: 'albumartist', label: 'Album artist', main: true },
  { key: 'track', label: 'Track', main: true, short: true, numeric: true },
  { key: 'tracktotal', label: 'of', main: true, short: true, numeric: true },
  { key: 'disc', label: 'Disc', main: true, short: true, numeric: true },
  { key: 'disctotal', label: 'of', main: true, short: true, numeric: true },
  { key: 'year', label: 'Year / date', main: true, short: true },
  { key: 'genre', label: 'Genre', main: true },
  { key: 'composer', label: 'Composer', main: true },
  { key: 'comment', label: 'Comment', main: true, multiline: true },
  { key: 'lyrics', label: 'Lyrics', multiline: true },
  { key: 'publisher', label: 'Label / publisher' },
  { key: 'copyright', label: 'Copyright' },
  { key: 'encodedby', label: 'Encoded by' },
  { key: 'bpm', label: 'BPM', numeric: true, short: true },
  { key: 'key', label: 'Initial key', short: true },
  { key: 'isrc', label: 'ISRC' },
  { key: 'grouping', label: 'Grouping' },
  { key: 'compilation', label: 'Compilation (1 = yes)', short: true },
  { key: 'conductor', label: 'Conductor' },
  { key: 'lyricist', label: 'Lyricist' },
  { key: 'remixer', label: 'Remixer' },
  { key: 'subtitle', label: 'Subtitle' },
  { key: 'mood', label: 'Mood' },
  { key: 'language', label: 'Language' },
  { key: 'sorttitle', label: 'Sort title' },
  { key: 'sortartist', label: 'Sort artist' },
  { key: 'sortalbum', label: 'Sort album' },
  { key: 'sortalbumartist', label: 'Sort album artist' },
];
export const FIELD_KEYS = FIELDS.map((f) => f.key);
export const FIELD_LABEL = Object.fromEntries(FIELDS.map((f) => [f.key, f.label]));

export const PICTURE_TYPES = ['Other', 'File icon', 'Other file icon', 'Front cover', 'Back cover', 'Leaflet page', 'Media', 'Lead artist', 'Artist', 'Conductor', 'Band', 'Composer', 'Lyricist', 'Recording location', 'During recording', 'During performance', 'Screen capture', 'Bright fish', 'Illustration', 'Band logo', 'Publisher logo'];

export const GENRES = ['Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native US', 'Cabaret', 'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus', 'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore Techno', 'Terror', 'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'Jpop', 'Synthpop', 'Abstract', 'Art Rock', 'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo', 'Dub', 'EBM', 'Eclectic', 'Electro', 'Electroclash', 'Emo', 'Experimental', 'Garage', 'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band', 'Krautrock', 'Leftfield', 'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk', 'Post-Rock', 'Psytrance', 'Shoegaze', 'Space Rock', 'Trop Rock', 'World Music', 'Neoclassical', 'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock', 'G-Funk', 'Dubstep', 'Garage Rock', 'Psybient'];

export function emptyModel(format = '') {
  return { fields: {}, custom: [], pictures: [], props: {}, format, notes: [] };
}

/** Split "3/12" into [track,total] */
export function splitNumTotal(v) {
  if (v == null) return ['', ''];
  const m = String(v).trim().match(/^(\d*)\s*(?:\/\s*(\d*))?/);
  if (!m) return [String(v), ''];
  return [m[1] ? String(parseInt(m[1], 10)) : '', m[2] ? String(parseInt(m[2], 10)) : ''];
}
export const numOrEmpty = (v) => { const n = parseInt(v, 10); return isNaN(n) ? '' : String(n); };

/** Resolve "(17)Rock" / "17" / "(RX)" into genre text */
export function resolveGenre(s) {
  if (!s) return '';
  const parts = [];
  let rest = s.replace(/\0+$/, '');
  const re = /^\((\d+|RX|CR)\)/;
  let m;
  while ((m = rest.match(re))) {
    const g = m[1] === 'RX' ? 'Remix' : m[1] === 'CR' ? 'Cover' : GENRES[+m[1]] ?? m[1];
    rest = rest.slice(m[0].length);
    if (rest.startsWith('(')) rest = rest.replace(/^\(\(/, '(');
    parts.push(g);
  }
  if (rest) { if (/^\d+$/.test(rest) && GENRES[+rest]) parts.push(GENRES[+rest]); else parts.push(rest); }
  return [...new Set(parts)].join('; ');
}

export function cleanModel(m) {
  // Trim values, drop empties
  for (const k of Object.keys(m.fields)) { const v = m.fields[k]; if (v == null || String(v).trim() === '') delete m.fields[k]; else m.fields[k] = String(v); }
  m.custom = (m.custom || []).filter((c) => c.key && c.value !== '');
  return m;
}

export function cloneModel(m) {
  return {
    fields: { ...m.fields }, custom: (m.custom || []).map((c) => ({ ...c })),
    pictures: (m.pictures || []).map((p) => ({ ...p })), props: { ...(m.props || {}) }, format: m.format, notes: [...(m.notes || [])],
  };
}

export function picturesEqual(a = [], b = []) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]; const y = b[i];
    if (x.type !== y.type || x.mime !== y.mime || (x.desc || '') !== (y.desc || '') || x.data.length !== y.data.length) return false;
    if (x.data !== y.data) { for (let j = 0; j < x.data.length; j += 97) if (x.data[j] !== y.data[j]) return false; }
  }
  return true;
}
export function customEqual(a = [], b = []) { return JSON.stringify(a.map((c) => [c.key, c.value])) === JSON.stringify(b.map((c) => [c.key, c.value])); }
export function fieldsEqual(a = {}, b = {}) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false;
  return true;
}
