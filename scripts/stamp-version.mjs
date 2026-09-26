// Render build step: stamps the service-worker cache version with the commit, so every deploy refreshes clients.
import { readFileSync, writeFileSync } from 'node:fs';

const version = (process.env.RENDER_GIT_COMMIT || '').slice(0, 12) || new Date().toISOString().replace(/\D/g, '').slice(0, 14);
const file = new URL('../public/sw.js', import.meta.url);
const src = readFileSync(file, 'utf8');
const out = src.replace(/const VERSION = '[^']*';/, `const VERSION = '${version}';`);
if (out === src && !src.includes(`'${version}'`)) throw new Error('VERSION marker not found in sw.js');
writeFileSync(file, out);
console.log(`sw.js cache version: ${version}`);
