/*
 * recommender.js — llm-curated shelves.
 * one claude call reads the watched list and the full catalogue and
 * stocks several themed shelves: personal recommendations, a shelf for
 * the nearest holiday (given the current date), and partner picks.
 * results are cached to disk so the model is only asked every few days.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import backend from '../media/index.js';
import { generateStructured } from './llm-client.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = resolve(__dirname, '..', '..', 'data', 'shelves.json');
const CACHE_TTL = 3 * 24 * 60 * 60 * 1000; // 3 days

let generating = false;

/*
 * fetch every movie in a section as compact records.
 */
async function fetchCatalogue(sectionId) {
  const items = [];
  let start = 0;
  let total = Infinity;

  while (start < total) {
    const page = await backend.getSectionItems(sectionId, { start, size: 1000 });
    total = page.totalSize ?? 0;

    for (const m of page.items || []) {
      items.push({
        ratingKey: m.ratingKey,
        title: m.title,
        year: m.year,
        genres: (m.genres || []).slice(0, 2).map(g => g.tag),
        rating: m.rating ?? m.audienceRating ?? null,
        viewCount: m.viewCount || 0,
        lastViewedAt: m.lastViewedAt,
      });
    }
    if (!page.items || page.items.length === 0) break;
    start += 1000;
  }

  return items;
}

function compactLine(item) {
  const genres = item.genres.join(',');
  return `${item.ratingKey}|${item.title} (${item.year ?? '?'}) [${genres}] ${item.rating ?? ''}`;
}

const pickSchema = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      ratingKey: { type: 'string' },
      reason: { type: 'string' },
    },
    required: ['ratingKey', 'reason'],
    additionalProperties: false,
  },
};

/*
 * one call stocks all three shelves.
 */
async function askClaude(watched, catalogue) {
  const today = new Date().toISOString().slice(0, 10);

  const watchedText = watched
    .sort((a, b) => (b.lastViewedAt || 0) - (a.lastViewedAt || 0))
    .map(i => `${compactLine(i)} watched x${i.viewCount}`)
    .join('\n');

  const unwatched = catalogue.filter(i => i.viewCount === 0);
  const catalogueText = unwatched.map(compactLine).join('\n');

  const schema = {
    type: 'object',
    properties: {
      recommendations: pickSchema,
      holiday: {
        type: 'object',
        properties: {
          holidayName: { type: 'string' },
          shelfTitle: { type: 'string' },
          items: pickSchema,
        },
        required: ['holidayName', 'shelfTitle', 'items'],
        additionalProperties: false,
      },
      partnerPicks: pickSchema,
      cultClassics: pickSchema,
    },
    required: ['recommendations', 'holiday', 'partnerPicks', 'cultClassics'],
    additionalProperties: false,
  };

  return generateStructured({
    maxTokens: 24000,
    schema,
    system: 'you are the resident film buff at a video rental store, stocking '
      + 'themed shelves for one regular customer and their household. you know '
      + 'the whole catalogue. reasons must be short (under 15 words), specific, '
      + 'and written like handwritten shelf notes. only pick from the unwatched '
      + 'catalogue, and return ratingKeys exactly as given.',
    prompt: `today's date: ${today}\n\n`
      + `films this customer has watched (most recent first), format ratingKey|title (year) [genres] rating:\n\n${watchedText}\n\n`
      + `the catalogue of films they have NOT watched:\n\n${catalogueText}\n\n`
      + `stock three shelves:\n`
      + `1. "recommendations" — exactly 56 picks for this customer based on their history. mix safe bets with adventurous picks and hidden gems.\n`
      + `2. "holiday" — work out the nearest upcoming holiday or seasonal occasion from today's date, name it, give the shelf a punchy title (max 20 characters), and stock up to 40 films that fit the occasion.\n`
      + `3. "partnerPicks" — up to 40 films for the customer's wife. her taste is complementary to his: assume she enjoys romance, sharp comedies, feel-good and prestige drama, and great crowd-pleasers, and avoid his heavy action/crime staples unless they are genuine date-night material. quality over cliche.\n`
      + `4. "cultClassics" — up to 56 genuine cult films from the catalogue: midnight movies, so-bad-its-good legends, video store folklore, films with devoted followings. for this shelf only, you may also pick from the watched list — a cult wall is a cult wall.`,
  });
}

/*
 * generate fresh shelves and persist them.
 */
async function generate(sectionId) {
  const catalogue = await fetchCatalogue(sectionId);
  const watched = catalogue.filter(i => i.viewCount > 0);

  if (watched.length === 0) {
    return { generatedAt: Date.now(), shelves: [] };
  }

  const picks = await askClaude(watched, catalogue);

  // resolve picks back to catalogue entries, dropping any invented keys
  const byKey = new Map(catalogue.map(i => [String(i.ratingKey), i]));
  const clean = (list) => (list || [])
    .filter(p => byKey.has(String(p.ratingKey)))
    .map(p => ({ ratingKey: String(p.ratingKey), reason: p.reason }));

  const shelves = [
    {
      id: 'recommended',
      title: 'Recommended For You',
      accent: '#42c9a0',
      items: clean(picks.recommendations),
    },
    {
      id: 'holiday',
      title: picks.holiday?.shelfTitle || 'Seasonal Picks',
      holidayName: picks.holiday?.holidayName || null,
      accent: '#ff8844',
      items: clean(picks.holiday?.items),
    },
    {
      id: 'partner',
      title: 'Date Night Picks',
      accent: '#ff6699',
      items: clean(picks.partnerPicks),
    },
    {
      id: 'cult',
      title: 'Cult Classics',
      accent: '#b44cff',
      placement: 'aisle',
      items: clean(picks.cultClassics),
    },
  ].filter(s => s.items.length > 0);

  const result = { generatedAt: Date.now(), sectionId, shelves };
  mkdirSync(dirname(CACHE_FILE), { recursive: true });
  writeFileSync(CACHE_FILE, JSON.stringify(result, null, 2));
  return result;
}

function readCache() {
  try {
    const cached = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'));
    // reject old cache shapes
    if (!Array.isArray(cached.shelves)) return null;
    return cached;
  } catch {
    return null;
  }
}

/*
 * get the curated shelves, serving from the disk cache when fresh.
 * a stale cache is served immediately while a refresh runs in the
 * background, so page loads never wait on the model.
 */
export async function getRecommendations(sectionId, { force = false } = {}) {
  const cached = readCache();
  const fresh = cached && (Date.now() - cached.generatedAt) < CACHE_TTL;

  if (cached && fresh && !force) {
    return { ...cached, status: 'cached' };
  }

  if (!generating) {
    generating = true;
    generate(sectionId)
      .catch(err => console.error('[recommender] generation failed:', err.message))
      .finally(() => { generating = false; });
  }

  if (cached) {
    return { ...cached, status: 'refreshing' };
  }

  return { generatedAt: null, shelves: [], status: 'generating' };
}
