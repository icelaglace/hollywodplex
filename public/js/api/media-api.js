/*
 * media-api.js — fetch wrappers for the backend /api/media/* endpoints.
 * each function returns parsed json or throws on failure.
 */

const DEFAULT_TIMEOUT = 10000;

async function apiFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeout || DEFAULT_TIMEOUT);

  try {
    const res = await fetch(path, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
      ...options,
    });

    if (!res.ok) {
      let message = `api returned ${res.status}`;
      try {
        const body = await res.json();
        message = body.message || message;
      } catch { /* use default message */ }
      throw new Error(message);
    }

    return await res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('request timed out');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchConfig() {
  return apiFetch('/api/config');
}

export async function fetchSections() {
  const data = await apiFetch('/api/media/sections');
  return data.sections;
}

export async function fetchItems(sectionId, { start = 0, size = 50, sort = 'titleSort:asc' } = {}) {
  const params = new URLSearchParams({ start, size, sort });
  return apiFetch(`/api/media/sections/${sectionId}/items?${params}`);
}

export async function fetchMetadata(ratingKey) {
  return apiFetch(`/api/media/metadata/${ratingKey}`);
}

export async function fetchChildren(ratingKey) {
  return apiFetch(`/api/media/metadata/${ratingKey}/children`);
}

export async function fetchPosters(ratingKey) {
  return apiFetch(`/api/media/posters/${ratingKey}`);
}

export async function setPoster(ratingKey, url) {
  return apiFetch(`/api/media/posters/${ratingKey}?url=${encodeURIComponent(url)}`, {
    method: 'POST',
  });
}

export async function fetchMatches(ratingKey, { title, year } = {}) {
  const params = new URLSearchParams();
  if (title) params.set('title', title);
  if (year) params.set('year', year);
  return apiFetch(`/api/media/matches/${ratingKey}?${params}`, { timeout: 20000 });
}

export async function applyMatch(ratingKey, guid, name) {
  const params = new URLSearchParams({ guid, name });
  return apiFetch(`/api/media/matches/${ratingKey}?${params}`, {
    method: 'POST',
    timeout: 30000,
  });
}

export async function fetchRecentlyAdded({ start = 0, size = 20, sectionId } = {}) {
  const params = new URLSearchParams({ start, size });
  if (sectionId) params.set('sectionId', sectionId);
  return apiFetch(`/api/media/recentlyAdded?${params}`);
}

export async function search(query, { sectionId, start = 0, size = 20 } = {}) {
  const params = new URLSearchParams({ query, start, size });
  if (sectionId) params.set('sectionId', sectionId);
  return apiFetch(`/api/media/search?${params}`);
}

export async function fetchRecommendations() {
  // recommendation generation can be slow server-side, but the route
  // itself always answers quickly from cache or with a pending status
  return apiFetch('/api/recommendations');
}
