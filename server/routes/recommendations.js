/*
 * recommendations.js — llm-powered recommendation routes.
 * results are cached on disk by the recommender service; the model is
 * only consulted when the cache is older than a few days.
 */

import { Router } from 'express';
import backend from '../media/index.js';
import { getRecommendations } from '../services/recommender.js';
import { llmAvailable } from '../services/llm-client.js';

const router = Router();

async function firstMovieSection() {
  const sections = await backend.getSections();
  const section = sections.find(s => s.type === 'movie');
  return section ? section.key : null;
}

/*
 * GET /api/recommendations
 * returns { generatedAt, items: [{ratingKey, reason}], status }.
 * status: cached | refreshing | generating | disabled
 */
router.get('/', async (_req, res, next) => {
  try {
    if (!llmAvailable()) {
      return res.json({ generatedAt: null, items: [], status: 'disabled' });
    }
    const sectionId = await firstMovieSection();
    if (!sectionId) {
      return res.json({ generatedAt: null, items: [], status: 'disabled' });
    }
    const result = await getRecommendations(sectionId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/*
 * POST /api/recommendations/refresh
 * force a regeneration regardless of cache age.
 */
router.post('/refresh', async (_req, res, next) => {
  try {
    if (!llmAvailable()) {
      return res.json({ status: 'disabled' });
    }
    const sectionId = await firstMovieSection();
    if (!sectionId) {
      return res.json({ status: 'disabled' });
    }
    const result = await getRecommendations(sectionId, { force: true });
    res.json({ status: result.status });
  } catch (err) {
    next(err);
  }
});

export default router;
