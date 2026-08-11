/*
 * test-jellyfin.js — verify connectivity to the jellyfin server and list libraries.
 * run with: node tools/test-jellyfin.js
 * relies on .env for JELLYFIN_SERVER_URL, JELLYFIN_API_KEY and
 * optionally JELLYFIN_USER.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// crude .env parser — avoids adding a dependency for a test script
function loadEnv() {
  const path = resolve(root, '.env');
  let content;
  try {
    content = readFileSync(path, 'utf-8');
  } catch {
    console.error('missing .env file. copy .env.example to .env and fill in your values.');
    process.exit(1);
  }
  const vars = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    vars[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return vars;
}

const env = loadEnv();
const { JELLYFIN_SERVER_URL, JELLYFIN_API_KEY, JELLYFIN_USER } = env;

if (!JELLYFIN_SERVER_URL || !JELLYFIN_API_KEY || JELLYFIN_API_KEY === 'your-jellyfin-api-key') {
  console.error('set JELLYFIN_SERVER_URL and JELLYFIN_API_KEY in .env');
  process.exit(1);
}

const base = JELLYFIN_SERVER_URL.replace(/\/+$/, '');
const headers = {
  'X-Emby-Token': JELLYFIN_API_KEY,
  'Accept': 'application/json',
};

async function get(path) {
  const res = await fetch(`${base}${path}`, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`jellyfin returned status ${res.status} for ${path}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

async function main() {
  console.log(`testing connection to ${base}...\n`);

  try {
    const info = await get('/System/Info');
    console.log(`connected to "${info.ServerName}" (jellyfin ${info.Version})\n`);

    // resolve the user the store would act as
    const users = await get('/Users');
    if (!users || users.length === 0) {
      console.log('connected, but no users found.');
      return;
    }
    const wanted = (JELLYFIN_USER || '').trim().toLowerCase();
    const user = wanted
      ? users.find(u =>
          (u.Id || '').toLowerCase() === wanted
          || (u.Name || '').toLowerCase() === wanted)
      : users.find(u => u.Policy?.IsAdministrator) || users[0];

    if (!user) {
      console.error(`jellyfin user "${JELLYFIN_USER}" not found. users: ${users.map(u => u.Name).join(', ')}`);
      process.exit(1);
    }
    console.log(`acting as user "${user.Name}" (${user.Id})\n`);

    const views = await get(`/Users/${user.Id}/Views`);
    const sections = views?.Items || [];

    if (sections.length === 0) {
      console.log('connected, but no libraries found.');
      return;
    }

    console.log(`found ${sections.length} librar${sections.length === 1 ? 'y' : 'ies'}:\n`);

    for (const s of sections) {
      console.log(`  [${s.Id}] ${s.Name} (${s.CollectionType || 'mixed'})`);

      // fetch item count
      try {
        const types = s.CollectionType === 'tvshows' ? 'Series' : 'Movie,Series';
        const params = new URLSearchParams({
          userId: user.Id,
          parentId: s.Id,
          recursive: 'true',
          includeItemTypes: types,
          limit: '0',
        });
        const count = await get(`/Items?${params}`);
        console.log(`      ${count.TotalRecordCount ?? '?'} items`);
      } catch {
        // skip count on failure
      }
    }

    console.log('\njellyfin connection verified successfully.');
  } catch (err) {
    console.error(`connection failed: ${err.message}`);
    process.exit(1);
  }
}

main();
