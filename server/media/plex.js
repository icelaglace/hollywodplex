/*
 * plex.js — plex backend adapter.
 * owns the authenticated axios client and translates raw plex api
 * responses into the normalized item shape the routes serve. artwork
 * urls are rewritten to go through our image proxy so the token never
 * reaches the browser.
 */

import axios from 'axios';
import config from '../config.js';

const plexClient = axios.create({
  baseURL: config.plexServerUrl,
  timeout: 15000,
  headers: {
    'X-Plex-Token': config.plexToken,
    'Accept': 'application/json',
    // identify as a client so plex tracks watch sessions from the store
    'X-Plex-Client-Identifier': 'hollywodplex',
    'X-Plex-Product': 'hollywodplex',
    'X-Plex-Device-Name': 'hollywodplex store',
  },
});

// response interceptor: check for plex-level errors encoded in the json body
plexClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;

      // plex sometimes returns xml errors even when we asked for json
      const message =
        typeof data === 'string'
          ? data.slice(0, 300)
          : data?.errors?.[0]?.message || `plex returned status ${status}`;

      const err = new Error(message);
      err.status = status;
      return Promise.reject(err);
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      const err = new Error('plex server is unreachable');
      err.status = 502;
      return Promise.reject(err);
    }
    return Promise.reject(error);
  },
);

/*
 * rewrite a plex artwork path to go through our image proxy.
 * plex-relative paths like /library/metadata/123/thumb are converted.
 * fully-qualified https urls (e.g. actor photos from metadata-static.plex.tv)
 * are left as-is since they are publicly accessible.
 */
function rewriteArtworkUrl(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  return `/image?url=${encodeURIComponent(path)}`;
}

/*
 * transform a single plex metadata object into the normalized item shape.
 */
function transformItem(meta) {
  if (!meta) return null;

  const item = {
    ratingKey: meta.ratingKey,
    key: meta.key,
    guid: meta.guid,
    title: meta.title,
    titleSort: meta.titleSort,
    year: meta.year ? parseInt(meta.year, 10) : null,
    index: meta.index != null ? parseInt(meta.index, 10) : null,
    parentTitle: meta.parentTitle || null,
    grandparentTitle: meta.grandparentTitle || null,
    leafCount: meta.leafCount != null ? parseInt(meta.leafCount, 10) : null,
    slug: meta.slug,
    studio: meta.studio || null,
    type: meta.type,
    contentRating: meta.contentRating || null,
    summary: meta.summary || '',
    tagline: meta.tagline || '',
    rating: meta.rating ? parseFloat(meta.rating) : null,
    audienceRating: meta.audienceRating ? parseFloat(meta.audienceRating) : null,
    duration: meta.duration ? parseInt(meta.duration, 10) : null,
    originallyAvailableAt: meta.originallyAvailableAt || null,
    addedAt: meta.addedAt ? parseInt(meta.addedAt, 10) : null,
    updatedAt: meta.updatedAt ? parseInt(meta.updatedAt, 10) : null,
    viewCount: meta.viewCount ? parseInt(meta.viewCount, 10) : 0,
    viewOffset: meta.viewOffset ? parseInt(meta.viewOffset, 10) : null,
    lastViewedAt: meta.lastViewedAt ? parseInt(meta.lastViewedAt, 10) : null,
    thumb: rewriteArtworkUrl(meta.thumb),
    art: rewriteArtworkUrl(meta.art),
  };

  // extract tag arrays for genres, directors, actors, etc.
  const tagFields = ['Genre', 'Director', 'Writer', 'Producer', 'Country', 'Role', 'Collection'];
  for (const field of tagFields) {
    const raw = meta[field];
    if (!raw) continue;
    const list = Array.isArray(raw) ? raw : [raw];
    const key = field === 'Role' ? 'actors' : field.toLowerCase() + 's';
    if (field === 'Role') {
      item[key] = list.map(r => ({
        id: r.id,
        tag: r.tag,
        role: r.role || null,
        thumb: r.thumb ? rewriteArtworkUrl(r.thumb) : null,
      }));
    } else {
      item[key] = list.map(r => ({ id: r.id, tag: r.tag }));
    }
  }

  // media info
  if (meta.Media) {
    const mediaList = Array.isArray(meta.Media) ? meta.Media : [meta.Media];
    item.media = mediaList.map(m => ({
      id: m.id,
      duration: m.duration ? parseInt(m.duration, 10) : null,
      bitrate: m.bitrate ? parseInt(m.bitrate, 10) : null,
      width: m.width ? parseInt(m.width, 10) : null,
      height: m.height ? parseInt(m.height, 10) : null,
      aspectRatio: m.aspectRatio || null,
      audioChannels: m.audioChannels ? parseInt(m.audioChannels, 10) : null,
      audioCodec: m.audioCodec || null,
      videoCodec: m.videoCodec || null,
      videoResolution: m.videoResolution || null,
      container: m.container || null,
      videoFrameRate: m.videoFrameRate || null,
      Part: m.Part ? (Array.isArray(m.Part) ? m.Part : [m.Part]).map(p => ({
        id: p.id,
        key: p.key,
        duration: p.duration ? parseInt(p.duration, 10) : null,
        file: p.file || null,
        size: p.size ? parseInt(p.size, 10) : null,
      })) : [],
    }));
  }

  // extras (trailers, featurettes) — the json api nests them under Metadata
  if (meta.Extras && meta.Extras.Metadata) {
    const extrasList = Array.isArray(meta.Extras.Metadata)
      ? meta.Extras.Metadata
      : [meta.Extras.Metadata];
    item.extras = extrasList.map(transformItem).filter(Boolean);
  }

  return item;
}

/*
 * transform a plex media container response into a paged items response.
 */
function transformContainer(data) {
  const container = data.MediaContainer;
  if (!container) return { items: [], totalSize: 0, offset: 0 };

  const rawItems = container.Metadata || [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems])
    .map(transformItem)
    .filter(Boolean);

  return {
    items,
    totalSize: container.totalSize || items.length,
    offset: container.offset || 0,
    allowSync: container.allowSync,
    identifier: container.identifier,
    librarySectionID: container.librarySectionID,
    librarySectionTitle: container.librarySectionTitle,
    title1: container.title1,
    title2: container.title2,
    viewGroup: container.viewGroup,
    viewMode: container.viewMode,
  };
}

function transformSection(s) {
  return {
    key: s.key,
    title: s.title,
    type: s.type,
    agent: s.agent || null,
    scanner: s.scanner || null,
    language: s.language || null,
    thumb: rewriteArtworkUrl(s.thumb),
    art: rewriteArtworkUrl(s.art),
    composite: rewriteArtworkUrl(s.composite),
    refreshedAt: s.refreshedAt ? parseInt(s.refreshedAt, 10) : null,
    updatedAt: s.updatedAt ? parseInt(s.updatedAt, 10) : null,
  };
}

/*
 * strip any token that may have leaked into a proxied path and require
 * a server-relative path so the token can never be sent to an
 * arbitrary external host.
 */
function sanitizeRelativePath(raw) {
  if (!raw) return null;
  const path = raw.replace(/[?&]X-Plex-Token=[^&]*/gi, '');
  if (!path.startsWith('/')) return null;
  return path;
}

const backend = {
  type: 'plex',
  serverUrl: config.plexServerUrl,

  /*
   * identity used by the frontend to build "open in plex" deep links.
   */
  async getServerIdentity() {
    try {
      const identity = await plexClient.get('/identity');
      return {
        machineIdentifier: identity.data.MediaContainer?.machineIdentifier || null,
        serverId: null,
      };
    } catch {
      // deep links will fall back to the app.plex.tv search page
      return { machineIdentifier: null, serverId: null };
    }
  },

  async getSections() {
    const { data } = await plexClient.get('/library/sections');
    return (data.MediaContainer?.Directory || []).map(transformSection);
  },

  async getSectionItems(sectionId, { start = 0, size = 50, sort = 'titleSort:asc' } = {}) {
    const { data } = await plexClient.get(`/library/sections/${sectionId}/all`, {
      headers: {
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(size),
      },
      params: { sort },
    });
    return transformContainer(data);
  },

  async getMetadata(ratingKey) {
    const { data } = await plexClient.get(`/library/metadata/${ratingKey}`, {
      params: { includeExtras: 1 },
    });
    const container = data.MediaContainer;
    if (!container || !container.Metadata) return null;

    const items = Array.isArray(container.Metadata) ? container.Metadata : [container.Metadata];
    const item = transformItem(items[0]);
    if (!item) return null;

    // include related hubs if present
    if (container.Related) {
      item.related = (container.Related.Hub || []).map(hub => ({
        hubKey: hub.hubKey,
        key: hub.key,
        title: hub.title,
        type: hub.type,
        hubIdentifier: hub.hubIdentifier,
        context: hub.context,
        size: hub.size,
        items: hub.Video ? (Array.isArray(hub.Video) ? hub.Video : [hub.Video]).map(transformItem).filter(Boolean) : [],
      }));
    }

    return item;
  },

  async getChildren(ratingKey) {
    const { data } = await plexClient.get(`/library/metadata/${ratingKey}/children`);
    return transformContainer(data);
  },

  async getRecentlyAdded({ start = 0, size = 20, sectionId } = {}) {
    const url = sectionId
      ? `/library/sections/${sectionId}/recentlyAdded`
      : '/library/recentlyAdded';
    const { data } = await plexClient.get(url, {
      headers: {
        'X-Plex-Container-Start': String(start),
        'X-Plex-Container-Size': String(size),
      },
    });
    return transformContainer(data);
  },

  /*
   * report playback progress so watch state and resume points stay in
   * sync with the in-store player. state: playing | paused | stopped.
   */
  async reportTimeline({ ratingKey, state, timeMs, durationMs }) {
    await plexClient.get('/:/timeline', {
      params: {
        ratingKey,
        key: `/library/metadata/${ratingKey}`,
        state,
        time: Math.max(0, Math.floor(timeMs || 0)),
        duration: Math.max(0, Math.floor(durationMs || 0)),
        identifier: 'com.plexapp.plugins.library',
        hasMDE: 0,
      },
    });
  },

  async getPosters(ratingKey) {
    const { data } = await plexClient.get(`/library/metadata/${ratingKey}/posters`);
    const raw = data.MediaContainer?.Metadata || [];
    return (Array.isArray(raw) ? raw : [raw]).map(p => ({
      // the ratingKey here is the provider url used to select this poster
      key: p.ratingKey,
      // provider previews are public https urls; local ones go via our proxy
      thumb: p.thumb && p.thumb.startsWith('http')
        ? p.thumb
        : rewriteArtworkUrl(p.thumb),
      provider: p.provider || null,
      selected: !!p.selected,
    })).filter(p => p.thumb);
  },

  async setPoster(ratingKey, url) {
    await plexClient.post(`/library/metadata/${ratingKey}/posters`, null, {
      params: { url },
    });
  },

  /*
   * search the metadata agent for match candidates. with a title this is
   * a manual search; without one plex guesses from the filename.
   */
  async getMatches(ratingKey, { title, year } = {}) {
    const params = {};
    if (title) {
      params.manual = 1;
      params.title = title;
      if (year) params.year = year;
    }

    const { data } = await plexClient.get(`/library/metadata/${ratingKey}/matches`, { params });
    const raw = data.MediaContainer?.SearchResult || [];
    return (Array.isArray(raw) ? raw : [raw]).map(m => ({
      guid: m.guid,
      name: m.name,
      year: m.year ? parseInt(m.year, 10) : null,
      score: m.score != null ? Number(m.score) : null,
      summary: m.summary || null,
    })).filter(m => m.guid && m.name);
  },

  async applyMatch(ratingKey, { guid, name }) {
    await plexClient.put(`/library/metadata/${ratingKey}/match`, null, {
      params: { guid, name },
    });
  },

  sanitizeImagePath: sanitizeRelativePath,

  async fetchImage(path) {
    const response = await plexClient.get(path, {
      responseType: 'arraybuffer',
      // image requests can take longer
      timeout: 20000,
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers['content-type'] || null,
    };
  },

  sanitizeStreamPath: sanitizeRelativePath,

  /*
   * request details for the media stream proxy: full url plus the
   * auth headers to send upstream.
   */
  streamRequest(path) {
    return {
      url: `${config.plexServerUrl}${path}`,
      headers: { 'X-Plex-Token': config.plexToken },
    };
  },
};

export default backend;
