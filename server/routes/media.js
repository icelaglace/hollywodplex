/*
 * media.js — api routes over the configured media backend.
 * the backend adapter (plex or jellyfin) does all response shaping;
 * these routes add paging parameters, caching and error handling.
 */

import { Router } from 'express';
import backend from '../media/index.js';
import cache from '../services/cache.js';
import { makeSearchIndex } from '../services/search-index.js';

const router = Router();
const searchIndex = makeSearchIndex(backend);

/*
 * cache key for a single item's metadata — shared with the match route,
 * which must drop the entry after a re-match.
 */
export function metadataCacheKey(ratingKey) {
  return cache.constructor.key('GET', `${backend.type}:metadata:${ratingKey}`);
}

/*
 * GET /api/media/sections
 * list all libraries.
 */
router.get('/sections', async (_req, res, next) => {
  try {
    const cacheKey = cache.constructor.key('GET', `${backend.type}:sections`);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const sections = await backend.getSections();
    const result = { sections };
    cache.setWithCategory(cacheKey, result, 'list');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/sections/:id/items
 * get items from a library section, with paging.
 */
router.get('/sections/:id/items', async (req, res, next) => {
  try {
    const { id } = req.params;
    const start = parseInt(req.query.start, 10) || 0;
    const size = parseInt(req.query.size, 10) || 50;
    const sort = req.query.sort || 'titleSort:asc';

    const cacheKey = cache.constructor.key('GET', `${backend.type}:sectionItems:${id}?start=${start}&size=${size}&sort=${sort}`);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await backend.getSectionItems(id, { start, size, sort });
    cache.setWithCategory(cacheKey, result, 'list');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/metadata/:ratingKey
 * get full metadata for a single item.
 */
router.get('/metadata/:ratingKey', async (req, res, next) => {
  try {
    const { ratingKey } = req.params;

    const cacheKey = metadataCacheKey(ratingKey);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const item = await backend.getMetadata(ratingKey);
    if (!item) {
      return res.status(404).json({ error: 'not_found', message: 'item not found' });
    }

    cache.setWithCategory(cacheKey, item, 'metadata');
    res.json(item);
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/timeline
 * report playback progress so watch state and resume points stay in
 * sync with the in-store player.
 * query: ratingKey, state (playing|paused|stopped), time (ms), duration (ms)
 */
router.get('/timeline', async (req, res, next) => {
  try {
    const { ratingKey, state, time, duration } = req.query;

    if (!ratingKey || !['playing', 'paused', 'stopped'].includes(state)) {
      return res.status(400).json({ error: 'bad_request', message: 'ratingKey and a valid state are required' });
    }

    await backend.reportTimeline({
      ratingKey,
      state,
      timeMs: Number(time) || 0,
      durationMs: Number(duration) || 0,
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/posters/:ratingKey
 * list the candidate posters the metadata providers offer for an item.
 */
router.get('/posters/:ratingKey', async (req, res, next) => {
  try {
    const { ratingKey } = req.params;
    const posters = await backend.getPosters(ratingKey);
    res.json({ posters });
  } catch (err) {
    next(err);
  }
});

/*
 * POST /api/media/posters/:ratingKey?url=<provider key>
 * select one of the candidate posters for an item.
 */
router.post('/posters/:ratingKey', async (req, res, next) => {
  try {
    const { ratingKey } = req.params;
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'missing_url', message: 'url query parameter is required' });
    }
    await backend.setPoster(ratingKey, url);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/metadata/:ratingKey/children
 * seasons of a show, or episodes of a season.
 */
router.get('/metadata/:ratingKey/children', async (req, res, next) => {
  try {
    const { ratingKey } = req.params;

    const cacheKey = cache.constructor.key('GET', `${backend.type}:children:${ratingKey}`);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await backend.getChildren(ratingKey);
    cache.setWithCategory(cacheKey, result, 'metadata');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/recentlyAdded
 * get recently added items across all sections.
 */
router.get('/recentlyAdded', async (req, res, next) => {
  try {
    const start = parseInt(req.query.start, 10) || 0;
    const size = parseInt(req.query.size, 10) || 20;
    const sectionId = req.query.sectionId;

    const cacheKey = cache.constructor.key('GET', `${backend.type}:recentlyAdded:${sectionId || 'all'}?start=${start}&size=${size}`);
    const cached = cache.get(cacheKey);
    if (cached) return res.json(cached);

    const result = await backend.getRecentlyAdded({ start, size, sectionId });
    cache.setWithCategory(cacheKey, result, 'list');
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/*
 * GET /api/media/search
 * ranked search over the in-memory library index (title + director).
 * the index holds the complete library, so results are not capped by
 * the media server's paging; size defaults to 100 (max 300).
 */
router.get('/search', async (req, res, next) => {
  try {
    const { query, sectionId, start: startStr, size: sizeStr } = req.query;
    const start = parseInt(startStr, 10) || 0;
    const size = Math.min(parseInt(sizeStr, 10) || 100, 300);

    if (!query || query.trim().length === 0) {
      return res.json({ items: [], totalSize: 0, offset: 0 });
    }

    // resolve which sections to search
    let sectionIds;
    if (sectionId) {
      sectionIds = [sectionId];
    } else {
      const sections = await backend.getSections();
      sectionIds = sections
        .filter(s => s.type === 'movie' || s.type === 'show')
        .map(s => s.key);
    }

    const result = await searchIndex.search(query, sectionIds, start, size);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
