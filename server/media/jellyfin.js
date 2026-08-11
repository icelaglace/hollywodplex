/*
 * jellyfin.js — jellyfin backend adapter.
 * speaks the jellyfin rest api and translates its DTOs into the same
 * normalized item shape the plex adapter produces, so the routes and
 * frontend never see the difference. artwork and stream urls are
 * rewritten to go through our proxies, keeping the api key server-side.
 *
 * jellyfin scopes library views and watch state to a user, so the
 * adapter acts as one user: JELLYFIN_USER from .env (name or id), or
 * the first administrator when unset.
 */

import axios from 'axios';
import config from '../config.js';

// ticks are 100ns; one millisecond is 10,000 ticks
const TICKS_PER_MS = 10000;

// item detail fields not included in list responses by default
const ITEM_FIELDS = [
  'Genres', 'Overview', 'People', 'Studios', 'DateCreated', 'MediaSources',
  'ProviderIds', 'Taglines', 'SortName', 'RecursiveItemCount', 'ChildCount',
  'ProductionLocations', 'LocalTrailerCount',
].join(',');

const jellyfinClient = axios.create({
  baseURL: config.jellyfinServerUrl,
  timeout: 15000,
  headers: {
    'X-Emby-Token': config.jellyfinApiKey,
    'Accept': 'application/json',
    // identify as a client so jellyfin shows store playback in the dashboard
    'Authorization': 'MediaBrowser Client="hollywodplex", Device="hollywodplex store", '
      + 'DeviceId="hollywodplex", Version="1.0.0", '
      + `Token="${config.jellyfinApiKey}"`,
  },
});

jellyfinClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response) {
      const status = error.response.status;
      const data = error.response.data;
      const message =
        typeof data === 'string' && data.length > 0
          ? data.slice(0, 300)
          : data?.title || data?.message || `jellyfin returned status ${status}`;

      const err = new Error(message);
      err.status = status;
      return Promise.reject(err);
    }
    if (error.code === 'ECONNREFUSED' || error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT') {
      const err = new Error('jellyfin server is unreachable');
      err.status = 502;
      return Promise.reject(err);
    }
    return Promise.reject(error);
  },
);

/*
 * resolve the jellyfin user the store acts as. memoized for the life of
 * the process; JELLYFIN_USER may be a user id or name, otherwise the
 * first administrator (or first user) wins.
 */
let userPromise = null;
function ensureUserId() {
  if (!userPromise) {
    userPromise = (async () => {
      const { data } = await jellyfinClient.get('/Users');
      const users = Array.isArray(data) ? data : [];
      if (users.length === 0) {
        throw new Error('jellyfin reported no users — create one or check the api key');
      }

      let user = null;
      const wanted = config.jellyfinUser.trim().toLowerCase();
      if (wanted) {
        user = users.find(u =>
          (u.Id || '').toLowerCase() === wanted
          || (u.Name || '').toLowerCase() === wanted,
        );
        if (!user) {
          throw new Error(`jellyfin user "${config.jellyfinUser}" not found`);
        }
      } else {
        user = users.find(u => u.Policy?.IsAdministrator) || users[0];
      }

      console.log(`[jellyfin] acting as user "${user.Name}" (${user.Id})`);
      return user.Id;
    })();
    // a failed lookup should not poison every later request
    userPromise.catch(() => { userPromise = null; });
  }
  return userPromise;
}

/*
 * rewrite a jellyfin image path to go through our image proxy.
 */
function imageUrl(itemId, imageType, tag, index = null) {
  if (!itemId || !tag) return null;
  const suffix = index != null ? `/${index}` : '';
  const path = `/Items/${itemId}/Images/${imageType}${suffix}?tag=${encodeURIComponent(tag)}`;
  return `/image?url=${encodeURIComponent(path)}`;
}

/*
 * primary artwork for an item, falling back to the parent series or
 * season artwork the way plex episode thumbs do.
 */
function primaryImage(dto) {
  if (dto.ImageTags?.Primary) return imageUrl(dto.Id, 'Primary', dto.ImageTags.Primary);
  if (dto.SeriesPrimaryImageTag && dto.SeriesId) {
    return imageUrl(dto.SeriesId, 'Primary', dto.SeriesPrimaryImageTag);
  }
  if (dto.ParentPrimaryImageTag && dto.ParentPrimaryImageItemId) {
    return imageUrl(dto.ParentPrimaryImageItemId, 'Primary', dto.ParentPrimaryImageTag);
  }
  return null;
}

function backdropImage(dto) {
  if (dto.BackdropImageTags?.length > 0) {
    return imageUrl(dto.Id, 'Backdrop', dto.BackdropImageTags[0], 0);
  }
  if (dto.ParentBackdropImageTags?.length > 0 && dto.ParentBackdropItemId) {
    return imageUrl(dto.ParentBackdropItemId, 'Backdrop', dto.ParentBackdropImageTags[0], 0);
  }
  return null;
}

const TYPE_MAP = {
  Movie: 'movie',
  Series: 'show',
  Season: 'season',
  Episode: 'episode',
  Trailer: 'clip',
  Video: 'clip',
  BoxSet: 'collection',
};

function mapType(dtoType) {
  return TYPE_MAP[dtoType] || (dtoType || '').toLowerCase() || null;
}

const COLLECTION_TYPE_MAP = {
  movies: 'movie',
  tvshows: 'show',
  music: 'artist',
  homevideos: 'video',
};

function ticksToMs(ticks) {
  return ticks != null ? Math.round(ticks / TICKS_PER_MS) : null;
}

function isoToEpochSeconds(iso) {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

/*
 * container strings can arrive as ffmpeg format lists like
 * "mov,mp4,m4a,3gp,3g2,mj2" — reduce to the single name the player's
 * direct-play check understands.
 */
function normalizeContainerName(container) {
  if (!container) return null;
  const s = String(container).toLowerCase();
  if (!s.includes(',')) return s;
  const tokens = s.split(',').map(t => t.trim());
  for (const preferred of ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi']) {
    if (tokens.includes(preferred)) return preferred;
  }
  return tokens[0] || null;
}

function transformMediaSources(dto) {
  const sources = dto.MediaSources;
  if (!sources || sources.length === 0) return undefined;

  return sources.map(ms => {
    const streams = ms.MediaStreams || [];
    const video = streams.find(s => s.Type === 'Video') || {};
    const audio = streams.find(s => s.Type === 'Audio') || {};
    const height = video.Height || null;

    return {
      id: ms.Id,
      duration: ticksToMs(ms.RunTimeTicks),
      bitrate: ms.Bitrate ? Math.round(ms.Bitrate / 1000) : null, // kbps like plex
      width: video.Width || null,
      height,
      aspectRatio: video.AspectRatio || null,
      audioChannels: audio.Channels || null,
      audioCodec: audio.Codec || null,
      videoCodec: video.Codec || null,
      // plex-style resolution string: '1080', '720', '4k'
      videoResolution: height ? (height >= 2000 ? '4k' : String(height)) : null,
      container: normalizeContainerName(ms.Container),
      videoFrameRate: video.AverageFrameRate ? String(video.AverageFrameRate) : null,
      Part: [{
        id: ms.Id,
        // native stream path, served through our /stream proxy
        key: `/Videos/${dto.Id}/stream?static=true&mediaSourceId=${encodeURIComponent(ms.Id)}`,
        duration: ticksToMs(ms.RunTimeTicks),
        file: ms.Path || null,
        size: ms.Size || null,
      }],
    };
  });
}

function transformPeople(item, dto) {
  const people = dto.People;
  if (!people || people.length === 0) return;

  const byType = { Director: 'directors', Writer: 'writers', Producer: 'producers' };
  for (const p of people) {
    if (p.Type === 'Actor') {
      item.actors = item.actors || [];
      item.actors.push({
        id: p.Id,
        tag: p.Name,
        role: p.Role || null,
        thumb: p.PrimaryImageTag ? imageUrl(p.Id, 'Primary', p.PrimaryImageTag) : null,
      });
    } else if (byType[p.Type]) {
      const key = byType[p.Type];
      item[key] = item[key] || [];
      item[key].push({ id: p.Id, tag: p.Name });
    }
  }
}

/*
 * transform a jellyfin BaseItemDto into the normalized item shape.
 */
function transformItem(dto) {
  if (!dto || !dto.Id) return null;

  const userData = dto.UserData || {};
  const type = mapType(dto.Type);
  const providerIds = dto.ProviderIds || {};
  const matched = Object.keys(providerIds).length > 0;
  const positionMs = ticksToMs(userData.PlaybackPositionTicks);

  const item = {
    ratingKey: dto.Id,
    key: `/Items/${dto.Id}`,
    // synthesized guid: local:// marks unmatched items, mirroring plex,
    // which drives the fix-match ui and the fix-unmatched pipeline
    guid: matched ? `jellyfin://${dto.Id}` : `local://${dto.Id}`,
    title: dto.Name,
    titleSort: dto.SortName || dto.Name,
    year: dto.ProductionYear || null,
    index: dto.IndexNumber != null ? dto.IndexNumber : null,
    parentTitle: type === 'episode' ? (dto.SeasonName || null) : (type === 'season' ? (dto.SeriesName || null) : null),
    grandparentTitle: type === 'episode' ? (dto.SeriesName || null) : null,
    leafCount: type === 'show'
      ? (dto.RecursiveItemCount ?? dto.ChildCount ?? null)
      : (dto.ChildCount ?? null),
    slug: null,
    studio: dto.Studios?.[0]?.Name || null,
    type,
    contentRating: dto.OfficialRating || null,
    summary: dto.Overview || '',
    tagline: dto.Taglines?.[0] || '',
    // plex 'rating' is a 0-10 critic score; community rating is the
    // closest widely-populated jellyfin equivalent
    rating: dto.CommunityRating != null
      ? Math.round(dto.CommunityRating * 10) / 10
      : (dto.CriticRating != null ? Math.round(dto.CriticRating) / 10 : null),
    audienceRating: dto.CommunityRating != null ? Math.round(dto.CommunityRating * 10) / 10 : null,
    duration: ticksToMs(dto.RunTimeTicks),
    originallyAvailableAt: dto.PremiereDate ? dto.PremiereDate.slice(0, 10) : null,
    addedAt: isoToEpochSeconds(dto.DateCreated),
    updatedAt: null,
    viewCount: userData.PlayCount || 0,
    viewOffset: positionMs && positionMs > 0 ? positionMs : null,
    lastViewedAt: isoToEpochSeconds(userData.LastPlayedDate),
    thumb: primaryImage(dto),
    art: backdropImage(dto),
  };

  const genreItems = dto.GenreItems?.length > 0
    ? dto.GenreItems.map(g => ({ id: g.Id, tag: g.Name }))
    : (dto.Genres || []).map(g => ({ id: null, tag: g }));
  if (genreItems.length > 0) item.genres = genreItems;

  if (dto.ProductionLocations?.length > 0) {
    // key name matches the plex adapter's field.toLowerCase() + 's' quirk
    item.countrys = dto.ProductionLocations.map(c => ({ id: null, tag: c }));
  }

  transformPeople(item, dto);

  const media = transformMediaSources(dto);
  if (media) item.media = media;

  return item;
}

/*
 * transform a paged jellyfin result into the normalized container shape.
 */
function transformContainer(data, offset = 0) {
  const rawItems = data?.Items || [];
  const items = rawItems.map(transformItem).filter(Boolean);
  return {
    items,
    totalSize: data?.TotalRecordCount ?? items.length,
    offset: data?.StartIndex ?? offset,
  };
}

/*
 * map the app's plex-style sort parameter ('titleSort:asc') onto
 * jellyfin's sortBy/sortOrder pair.
 */
const SORT_FIELD_MAP = {
  titleSort: 'SortName',
  title: 'SortName',
  addedAt: 'DateCreated',
  originallyAvailableAt: 'PremiereDate',
  year: 'ProductionYear',
  rating: 'CommunityRating',
  audienceRating: 'CommunityRating',
  lastViewedAt: 'DatePlayed',
  random: 'Random',
};

function mapSort(sort) {
  const [field, dir] = String(sort || 'titleSort:asc').split(':');
  const sortBy = SORT_FIELD_MAP[field] || 'SortName';
  return {
    sortBy: sortBy === 'SortName' ? 'SortName' : `${sortBy},SortName`,
    sortOrder: dir === 'desc' ? 'Descending' : 'Ascending',
  };
}

/*
 * library views, cached briefly since section lookups accompany most
 * item queries.
 */
let viewsCache = { at: 0, views: [] };
async function getViews() {
  if (Date.now() - viewsCache.at < 60_000 && viewsCache.views.length > 0) {
    return viewsCache.views;
  }
  const userId = await ensureUserId();
  const { data } = await jellyfinClient.get(`/Users/${userId}/Views`);
  const views = data?.Items || [];
  viewsCache = { at: Date.now(), views };
  return views;
}

/*
 * which item types a view's listing should recurse into.
 */
function includeTypesForView(view) {
  switch (view?.CollectionType) {
    case 'movies': return 'Movie';
    case 'tvshows': return 'Series';
    default: return 'Movie,Series';
  }
}

/*
 * pack a remote search result into an opaque guid the frontend can hand
 * back on apply, and unpack it again. overview is dropped to keep the
 * guid url-sized.
 */
function encodeMatchGuid(result) {
  const payload = {
    Name: result.Name,
    ProviderIds: result.ProviderIds || {},
    ProductionYear: result.ProductionYear ?? null,
    ImageUrl: result.ImageUrl || null,
    SearchProviderName: result.SearchProviderName || null,
    PremiereDate: result.PremiereDate || null,
  };
  return `jf-match://${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
}

function decodeMatchGuid(guid) {
  if (!guid || !guid.startsWith('jf-match://')) return null;
  try {
    return JSON.parse(Buffer.from(guid.slice('jf-match://'.length), 'base64url').toString('utf-8'));
  } catch {
    return null;
  }
}

/*
 * playback state reporting. the /Users/{id}/PlayingItems routes are the
 * most broadly compatible (jellyfin 10.8 through current, where they
 * remain as legacy aliases); on 404/405 the modern /PlayingItems routes
 * are tried once and remembered.
 */
let playstateModern = false;
const startedItems = new Set();

async function playstateRequest(kind, userId, itemId, params) {
  const legacyBase = `/Users/${userId}/PlayingItems/${itemId}`;
  const modernBase = `/PlayingItems/${itemId}`;
  const modernParams = { ...params, userId };

  const call = (modern) => {
    const base = modern ? modernBase : legacyBase;
    const p = modern ? modernParams : params;
    if (kind === 'start') return jellyfinClient.post(base, null, { params: p });
    if (kind === 'progress') return jellyfinClient.post(`${base}/Progress`, null, { params: p });
    return jellyfinClient.delete(base, { params: p });
  };

  try {
    await call(playstateModern);
  } catch (err) {
    if ((err.status === 404 || err.status === 405)) {
      playstateModern = !playstateModern;
      await call(playstateModern);
      return;
    }
    throw err;
  }
}

const backend = {
  type: 'jellyfin',
  serverUrl: config.jellyfinServerUrl,

  /*
   * identity used by the frontend to build "open in jellyfin" links.
   */
  async getServerIdentity() {
    try {
      const { data } = await jellyfinClient.get('/System/Info');
      return { machineIdentifier: null, serverId: data?.Id || null };
    } catch {
      return { machineIdentifier: null, serverId: null };
    }
  },

  async getSections() {
    const views = await getViews();
    return views.map(v => ({
      key: v.Id,
      title: v.Name,
      type: COLLECTION_TYPE_MAP[v.CollectionType] || v.CollectionType || 'other',
      agent: null,
      scanner: null,
      language: null,
      thumb: v.ImageTags?.Primary ? imageUrl(v.Id, 'Primary', v.ImageTags.Primary) : null,
      art: null,
      composite: null,
      refreshedAt: null,
      updatedAt: null,
    }));
  },

  async getSectionItems(sectionId, { start = 0, size = 50, sort = 'titleSort:asc' } = {}) {
    const userId = await ensureUserId();
    const views = await getViews();
    const view = views.find(v => v.Id === sectionId);
    const { sortBy, sortOrder } = mapSort(sort);

    const { data } = await jellyfinClient.get('/Items', {
      params: {
        userId,
        parentId: sectionId,
        recursive: true,
        includeItemTypes: includeTypesForView(view),
        sortBy,
        sortOrder,
        startIndex: start,
        limit: size,
        fields: ITEM_FIELDS,
      },
    });
    return transformContainer(data, start);
  },

  async getMetadata(itemId) {
    const userId = await ensureUserId();
    let dto;
    try {
      ({ data: dto } = await jellyfinClient.get(`/Users/${userId}/Items/${itemId}`));
    } catch (err) {
      if (err.status === 404) return null;
      throw err;
    }

    const item = transformItem(dto);
    if (!item) return null;

    // local trailers become plex-style extras so the trailer button works
    if (dto.LocalTrailerCount > 0) {
      try {
        const { data: trailers } = await jellyfinClient.get(
          `/Users/${userId}/Items/${itemId}/LocalTrailers`,
        );
        const extras = (trailers || []).map(transformItem).filter(Boolean);
        if (extras.length > 0) item.extras = extras;
      } catch {
        // trailers are a nicety; ignore failures
      }
    }

    return item;
  },

  /*
   * seasons of a show, or episodes of a season. the /Shows endpoints
   * handle virtual seasons and specials properly, so the item is
   * fetched first to learn what kind of children to ask for.
   */
  async getChildren(itemId) {
    const userId = await ensureUserId();
    const { data: dto } = await jellyfinClient.get(`/Users/${userId}/Items/${itemId}`);

    let data;
    if (dto.Type === 'Series') {
      ({ data } = await jellyfinClient.get(`/Shows/${itemId}/Seasons`, {
        params: { userId, fields: ITEM_FIELDS },
      }));
    } else if (dto.Type === 'Season') {
      ({ data } = await jellyfinClient.get(`/Shows/${dto.SeriesId}/Episodes`, {
        params: { userId, seasonId: itemId, fields: ITEM_FIELDS },
      }));
    } else {
      ({ data } = await jellyfinClient.get('/Items', {
        params: { userId, parentId: itemId, fields: ITEM_FIELDS },
      }));
    }
    return transformContainer(data);
  },

  async getRecentlyAdded({ start = 0, size = 20, sectionId } = {}) {
    const userId = await ensureUserId();
    const { data } = await jellyfinClient.get('/Items', {
      params: {
        userId,
        ...(sectionId ? { parentId: sectionId } : {}),
        recursive: true,
        includeItemTypes: 'Movie,Series',
        sortBy: 'DateCreated,SortName',
        sortOrder: 'Descending',
        startIndex: start,
        limit: size,
        fields: ITEM_FIELDS,
      },
    });
    return transformContainer(data, start);
  },

  /*
   * report playback progress so resume points and watch state stay in
   * sync. state: playing | paused | stopped. jellyfin marks an item
   * played itself when a stop lands near the end.
   */
  async reportTimeline({ ratingKey, state, timeMs }) {
    const userId = await ensureUserId();
    const positionTicks = Math.max(0, Math.floor(timeMs || 0)) * TICKS_PER_MS;

    if (state === 'stopped') {
      startedItems.delete(ratingKey);
      await playstateRequest('stopped', userId, ratingKey, { positionTicks });
      return;
    }

    if (!startedItems.has(ratingKey)) {
      startedItems.add(ratingKey);
      await playstateRequest('start', userId, ratingKey, { canSeek: true });
    }
    await playstateRequest('progress', userId, ratingKey, {
      positionTicks,
      isPaused: state === 'paused',
    });
  },

  /*
   * candidate posters from jellyfin's remote image providers.
   */
  async getPosters(itemId) {
    const { data } = await jellyfinClient.get(`/Items/${itemId}/RemoteImages`, {
      params: { type: 'Primary' },
      timeout: 30000,
    });
    return (data?.Images || []).map(img => ({
      // the provider image url doubles as the selection key
      key: img.Url,
      thumb: img.ThumbnailUrl || img.Url,
      provider: img.ProviderName || null,
      selected: false,
    })).filter(p => p.key && p.thumb);
  },

  async setPoster(itemId, url) {
    await jellyfinClient.post(`/Items/${itemId}/RemoteImages/Download`, null, {
      params: { type: 'Primary', imageUrl: url },
      timeout: 30000,
    });
  },

  /*
   * search jellyfin's metadata providers for match candidates. the
   * chosen result is packed whole into the guid so apply can post it
   * back to /Items/RemoteSearch/Apply.
   */
  async getMatches(itemId, { title, year } = {}) {
    const userId = await ensureUserId();
    const { data: dto } = await jellyfinClient.get(`/Users/${userId}/Items/${itemId}`);

    const endpointByType = { Movie: '/Items/RemoteSearch/Movie', Series: '/Items/RemoteSearch/Series' };
    const endpoint = endpointByType[dto.Type];
    if (!endpoint) return [];

    const searchInfo = { Name: title || dto.Name };
    if (year) searchInfo.Year = parseInt(year, 10) || undefined;

    const { data } = await jellyfinClient.post(endpoint, {
      ItemId: itemId,
      SearchInfo: searchInfo,
    }, { timeout: 30000 });

    return (Array.isArray(data) ? data : []).map(r => ({
      guid: encodeMatchGuid(r),
      name: r.Name,
      year: r.ProductionYear || null,
      score: null,
      summary: r.Overview || null,
    })).filter(m => m.name);
  },

  async applyMatch(itemId, { guid }) {
    const result = decodeMatchGuid(guid);
    if (!result) {
      const err = new Error('invalid match guid');
      err.status = 400;
      throw err;
    }
    await jellyfinClient.post(`/Items/RemoteSearch/Apply/${itemId}`, result, {
      params: { replaceAllImages: true },
      timeout: 60000,
    });
  },

  /*
   * strip any api key that may have leaked into a proxied path and
   * require a server-relative path so the key can never be sent to an
   * arbitrary external host.
   */
  sanitizeImagePath(raw) {
    if (!raw) return null;
    const path = raw.replace(/[?&](api_key|apikey|X-Emby-Token)=[^&]*/gi, '');
    if (!path.startsWith('/')) return null;
    return path;
  },

  async fetchImage(path) {
    const response = await jellyfinClient.get(path, {
      responseType: 'arraybuffer',
      timeout: 20000,
    });
    return {
      buffer: Buffer.from(response.data),
      contentType: response.headers['content-type'] || null,
    };
  },

  sanitizeStreamPath(raw) {
    return this.sanitizeImagePath(raw);
  },

  streamRequest(path) {
    return {
      url: `${config.jellyfinServerUrl}${path}`,
      headers: { 'X-Emby-Token': config.jellyfinApiKey },
    };
  },
};

export default backend;
