/*
 * search-index.js — in-memory search index over the full library.
 * fetches complete section listings in pages from the media backend,
 * keeps a minimal record per item, and serves ranked substring searches
 * instantly. entries refresh lazily (stale-while-revalidate) so the
 * media server is queried at most once per ttl.
 */

const INDEX_TTL = 10 * 60 * 1000; // 10 minutes
const PAGE_SIZE = 1000;

/*
 * score a match: lower is better, -1 means no match.
 */
function scoreMatch(haystack, query) {
  const t = haystack.toLowerCase();
  if (t === query) return 0;
  if (t.startsWith(query)) return 1;
  if (t.split(/\s+/).some(w => w.startsWith(query))) return 2;
  if (t.includes(query)) return 3;
  return -1;
}

export function makeSearchIndex(backend) {
  // sectionId -> { items, fetchedAt, fetching }
  const index = new Map();

  async function fetchSectionItems(sectionId) {
    const items = [];
    let start = 0;
    let total = Infinity;

    while (start < total) {
      const page = await backend.getSectionItems(sectionId, { start, size: PAGE_SIZE });
      total = page.totalSize ?? 0;

      for (const m of page.items || []) {
        const directors = (m.directors || []).map(d => d.tag);
        items.push({
          ratingKey: m.ratingKey,
          title: m.title,
          year: m.year,
          type: m.type,
          rating: m.rating,
          thumb: m.thumb,
          directors: directors.map(tag => ({ tag })),
          searchText: [m.title, ...directors].join(' '),
        });
      }
      if (!page.items || page.items.length === 0) break;
      start += PAGE_SIZE;
    }

    return items;
  }

  /*
   * get the index for a section. serves stale data immediately while a
   * background refresh runs; only blocks when there is nothing cached.
   */
  async function getSection(sectionId) {
    const entry = index.get(sectionId);
    const now = Date.now();

    if (entry && now - entry.fetchedAt < INDEX_TTL) {
      return entry.items;
    }

    if (entry && !entry.fetching) {
      // stale: refresh in the background, serve stale now
      entry.fetching = true;
      fetchSectionItems(sectionId)
        .then(items => index.set(sectionId, { items, fetchedAt: Date.now(), fetching: false }))
        .catch(() => { entry.fetching = false; });
      return entry.items;
    }

    if (entry) return entry.items; // refresh already in flight

    // nothing cached — fetch now
    const items = await fetchSectionItems(sectionId);
    index.set(sectionId, { items, fetchedAt: Date.now(), fetching: false });
    return items;
  }

  /*
   * ranked search. searches title and director names.
   * returns { items, totalSize, offset }.
   */
  async function search(query, sectionIds, start = 0, size = 100) {
    const q = query.trim().toLowerCase();
    if (!q) return { items: [], totalSize: 0, offset: 0 };

    const scored = [];
    for (const sectionId of sectionIds) {
      const items = await getSection(sectionId);
      for (const item of items) {
        const score = scoreMatch(item.searchText, q);
        if (score >= 0) scored.push({ score, item });
      }
    }

    scored.sort((a, b) => a.score - b.score || a.item.title.localeCompare(b.item.title));

    const page = scored.slice(start, start + size).map(s => {
      // don't leak the internal searchText field
      const { searchText, ...rest } = s.item;
      return rest;
    });

    return { items: page, totalSize: scored.length, offset: start };
  }

  return { search, getSection };
}
