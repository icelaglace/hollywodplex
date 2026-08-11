/*
 * match.js — fix-match routes.
 * lets the client search the media server's metadata providers for
 * candidate matches for a film (useful when a file was never matched
 * and shows its filename as the title) and apply the chosen one.
 */

import { Router } from 'express';
import backend from '../media/index.js';
import cache from '../services/cache.js';
import { metadataCacheKey } from './media.js';

const router = Router();

/*
 * GET /api/media/matches/:ratingKey?title=&year=
 * search the providers for match candidates. with a title this is a
 * manual search; without one the server guesses from the item itself.
 */
router.get('/:ratingKey', async (req, res, next) => {
  try {
    const { ratingKey } = req.params;
    const { title, year } = req.query;

    const matches = await backend.getMatches(ratingKey, { title, year });
    res.json({ matches });
  } catch (err) {
    next(err);
  }
});

/*
 * POST /api/media/matches/:ratingKey?guid=&name=
 * apply a match. the server re-pulls metadata and provider artwork, so
 * the cached metadata entry for this item is dropped to serve fresh data.
 */
router.post('/:ratingKey', async (req, res, next) => {
  try {
    const { ratingKey } = req.params;
    const { guid, name } = req.query;
    if (!guid || !name) {
      return res.status(400).json({ error: 'bad_request', message: 'guid and name query parameters are required' });
    }

    await backend.applyMatch(ratingKey, { guid, name });

    cache.delete(metadataCacheKey(ratingKey));
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
