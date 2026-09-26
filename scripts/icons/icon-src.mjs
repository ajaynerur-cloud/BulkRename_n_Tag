// NameTag icon artwork, written as SVG so every size is rendered from one source.
// Concept: a name tag (the product name) carrying a line of text, a highlighter-yellow edit and a text cursor:
// "your names, edited". Colours come from the app palette (tape cobalt, highlighter yellow, ink).
export const C = { cobaltTop: '#3563F0', cobaltBottom: '#1B3BB0', ink: '#1B2230', mark: '#FFD84D', paper: '#FFFFFF', paperEdge: '#DDE3F4' };

// Tag geometry in its own 320x190 box (tip on the left), centred at (160,95).
const TAG = 'M 78 8 L 300 8 Q 312 8 312 20 L 312 170 Q 312 182 300 182 L 78 182 Q 70 182 64 176 L 12 104 Q 6 95 12 86 L 64 14 Q 70 8 78 8 Z';
const HOLE = { cx: 66, cy: 95, r: 17 };

/** Tag contents: ink line (a name), highlighter band with a shorter ink line (the edit), I-beam cursor. */
function contents(ink, mark, cursor) {
  return `
    <rect x="112" y="46" width="150" height="22" rx="11" fill="${ink}"/>
    <rect x="104" y="100" width="176" height="46" rx="10" fill="${mark}"/>
    <rect x="118" y="112" width="96" height="22" rx="11" fill="${ink}"/>
    <g fill="${cursor}">
      <rect x="233" y="84" width="12" height="78" rx="4"/>
      <rect x="219" y="80" width="40" height="11" rx="5.5"/>
      <rect x="219" y="155" width="40" height="11" rx="5.5"/>
    </g>`;
}

/** The tag group, scaled and rotated into place. scale=1 fills ~62% of a 512 canvas. */
function tag({ scale = 1, mono = false, id = 't' } = {}) {
  const tf = `translate(256 262) rotate(-24) scale(${scale * 1.02}) translate(-160 -95)`;
  if (mono) {
    // Single-colour silhouette with the details knocked out (Android themed icons use alpha only).
    return `
  <defs><mask id="${id}m" maskUnits="userSpaceOnUse" x="-200" y="-200" width="720" height="600">
    <path d="${TAG}" fill="#fff"/>
    <circle cx="${HOLE.cx}" cy="${HOLE.cy}" r="${HOLE.r}" fill="#000"/>
    <rect x="112" y="46" width="150" height="22" rx="11" fill="#000"/>
    <rect x="104" y="100" width="176" height="46" rx="10" fill="#000"/>
    <rect x="118" y="112" width="96" height="22" rx="11" fill="#fff"/>
    <rect x="233" y="108" width="12" height="30" rx="4" fill="#fff"/>
  </mask></defs>
  <g transform="${tf}"><rect x="-10" y="-10" width="340" height="210" fill="#fff" mask="url(#${id}m)"/></g>`;
  }
  return `
  <defs>
    <mask id="${id}h" maskUnits="userSpaceOnUse" x="-200" y="-200" width="720" height="600">
      <path d="${TAG}" fill="#fff"/><circle cx="${HOLE.cx}" cy="${HOLE.cy}" r="${HOLE.r}" fill="#000"/>
    </mask>
    <linearGradient id="${id}p" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.paper}"/><stop offset="1" stop-color="#EEF2FB"/></linearGradient>
  </defs>
  <g transform="${tf}">
    <g transform="translate(6 14)" opacity="0.28"><rect x="-10" y="-10" width="340" height="210" fill="#0A1A5C" mask="url(#${id}h)"/></g>
    <rect x="-10" y="-10" width="340" height="210" fill="url(#${id}p)" mask="url(#${id}h)"/>
    <circle cx="${HOLE.cx}" cy="${HOLE.cy}" r="${HOLE.r + 7}" fill="none" stroke="${C.paperEdge}" stroke-width="5"/>
    ${contents(C.ink, C.mark, '#2248C8')}
  </g>`;
}

const bg = (id) => `<linearGradient id="${id}" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${C.cobaltTop}"/><stop offset="1" stop-color="${C.cobaltBottom}"/></linearGradient>`;
// A faint embossed "tape" sheen across the tile, echoing the label-maker tape used in the app.
const sheen = `<path d="M0 0 H512 V190 Q256 250 0 190 Z" fill="#fff" opacity="0.07"/>`;

/** Standard icon: rounded tile with transparent corners. */
export const iconAny = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>${bg('g')}<clipPath id="c"><rect x="24" y="24" width="464" height="464" rx="104"/></clipPath></defs>
  <g clip-path="url(#c)"><rect width="512" height="512" fill="url(#g)"/>${sheen}</g>
  ${tag({ scale: 1.1 })}
</svg>`;

/** Maskable: full-bleed background, artwork inside the 80% safe circle. */
export const iconMaskable = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>${bg('g')}</defs>
  <rect width="512" height="512" fill="url(#g)"/>${sheen}
  ${tag({ scale: 0.9 })}
</svg>`;

/** Monochrome (Android 13+ themed icons): white silhouette on transparent, inside the safe zone. */
export const iconMono = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${tag({ scale: 0.9, mono: true })}
</svg>`;

/** Small favicon: simplified, no shadow or hole ring, so it stays crisp at 16-32 px. */
export const iconFavicon = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>${bg('g')}</defs>
  <rect x="0" y="0" width="512" height="512" rx="120" fill="url(#g)"/>
  <g transform="translate(256 262) rotate(-24) scale(1.2) translate(-160 -95)">
    <defs><mask id="fm" maskUnits="userSpaceOnUse" x="-200" y="-200" width="720" height="600"><path d="${TAG}" fill="#fff"/><circle cx="${HOLE.cx}" cy="${HOLE.cy}" r="${HOLE.r + 3}" fill="#000"/></mask></defs>
    <rect x="-10" y="-10" width="340" height="210" fill="#fff" mask="url(#fm)"/>
    <rect x="104" y="96" width="176" height="54" rx="12" fill="${C.mark}"/>
    <rect x="112" y="40" width="150" height="30" rx="15" fill="${C.ink}"/>
  </g>
</svg>`;

/* Android adaptive icon layers (108dp canvas; launchers show the middle 72dp, masks keep a 66dp circle). */
export const adaptiveBackground = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>${bg('g')}</defs><rect width="512" height="512" fill="url(#g)"/>${sheen}
</svg>`;
export const adaptiveForeground = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${tag({ scale: 0.66, id: 'af' })}
</svg>`;
export const adaptiveMonochrome = () => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  ${tag({ scale: 0.66, mono: true, id: 'am' })}
</svg>`;

/** Splash screen: the icon tile centred on the app background, for any width x height. */
export const splash = (w, h) => {
  const s = Math.round(Math.min(w, h) * 0.34);
  const inner = iconAny().replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">', '').replace(/<\/svg>\s*$/, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
  <rect width="${w}" height="${h}" fill="#EEF0F2"/>
  <svg x="${(w - s) / 2}" y="${(h - s) / 2}" width="${s}" height="${s}" viewBox="0 0 512 512">${inner}</svg>
</svg>`;
};
