/*
 * modal.js — film/show detail overlay.
 * films get a watch button (in-store player when direct-playable),
 * shows get season and episode browsing. trailers play when available.
 */

import store from '../store.js';
import { fetchMetadata, fetchChildren } from '../api/media-api.js';
import { getConfig } from '../config.js';
import { createPlayer, canDirectPlay, streamUrl } from './player.js';
import { attachPosterPicker } from './poster-picker.js';
import { attachFixMatch } from './fix-match.js';
import { div, span, button, img, el } from '../utils/dom.js';

const player = createPlayer();

export function createModal() {
  const overlay = document.getElementById('film-modal');
  const content = document.getElementById('modal-content');
  const closeBtn = document.getElementById('modal-close');
  const backdrop = overlay?.querySelector('.modal-backdrop');

  if (!overlay || !content) return { show() {}, hide() {}, isVisible() { return false; } };

  function hide() {
    // guard against re-entry: closeItem() emits item-closed which calls hide again
    if (overlay.style.display === 'none') return;
    overlay.style.display = 'none';
    content.innerHTML = '';
    if (store.selectedItem) store.closeItem();
    store.emit('overlay-closed');
  }

  closeBtn.addEventListener('click', hide);
  backdrop?.addEventListener('click', hide);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlay.style.display !== 'none' && !player.isOpen()) {
      hide();
    }
  });

  async function show(ratingKey) {
    overlay.style.display = 'flex';
    store.emit('overlay-opened'); // releases the mouse in 3d mode
    content.innerHTML = '<div style="padding:40px;text-align:center;color:#888;">loading...</div>';

    try {
      const item = await fetchMetadata(ratingKey);
      renderItem(item, content);
    } catch (err) {
      content.innerHTML = `<div style="padding:40px;text-align:center;color:#d42027;">
        failed to load details: ${err.message}
      </div>`;
    }
  }

  store.on('item-selected', (ratingKey) => {
    if (ratingKey) show(ratingKey);
  });

  store.on('item-closed', hide);

  return { show, hide, isVisible: () => overlay.style.display !== 'none' };
}

/*
 * name of the configured media server, for button labels.
 */
function serverName() {
  return getConfig().serverType === 'jellyfin' ? 'jellyfin' : 'plex';
}

/*
 * deep link to the item in the media server's own web app, used when
 * the browser cannot direct-play a file.
 */
function serverWebUrl(item) {
  const cfg = getConfig();

  if (cfg.serverType === 'jellyfin') {
    if (cfg.serverUrl) {
      const serverId = cfg.serverId ? `&serverId=${encodeURIComponent(cfg.serverId)}` : '';
      return `${cfg.serverUrl}/web/index.html#!/details?id=${encodeURIComponent(item.ratingKey)}${serverId}`;
    }
    return '#';
  }

  const metadataKey = encodeURIComponent(`/library/metadata/${item.ratingKey}`);
  if (cfg.machineIdentifier && cfg.serverUrl) {
    return `${cfg.serverUrl}/web/index.html#!/server/${cfg.machineIdentifier}/details?key=${metadataKey}`;
  }
  return `https://app.plex.tv/desktop/#!/search?query=${encodeURIComponent(item.title)}`;
}

function findTrailer(item) {
  if (!item.extras) return null;
  return item.extras.find(e => e.media?.[0]?.Part?.[0]?.key) || null;
}

function renderItem(item, container) {
  container.innerHTML = '';

  const layout = div({ class: 'modal-layout' });

  const posterImg = img({ src: item.thumb || '', alt: item.title, class: 'modal-poster' });
  const posterCol = div({ class: 'modal-poster' }, posterImg);
  // wrong poster? pick from the agent's alternatives
  attachPosterPicker(posterCol, item, posterImg);
  // never matched or matched wrongly? search the agent and re-match
  attachFixMatch(posterCol, item);
  layout.appendChild(posterCol);

  const info = div({ class: 'modal-info' });
  info.appendChild(el('h2', { class: 'modal-title' }, item.title));

  const metaBits = [];
  if (item.year) metaBits.push(String(item.year));
  if (item.contentRating) metaBits.push(item.contentRating);
  if (item.duration && item.type !== 'show') {
    metaBits.push(`${Math.floor(item.duration / 60000)}m`);
  }
  if (item.type === 'show' && item.leafCount) {
    metaBits.push(`${item.leafCount} episodes`);
  }
  if (metaBits.length > 0) {
    info.appendChild(div({ class: 'modal-meta' }, metaBits.join(' / ')));
  }

  if (item.genres?.length > 0) {
    info.appendChild(div({ class: 'modal-genres' },
      ...item.genres.map(g => span({ class: 'modal-genre-pill' }, g.tag)),
    ));
  }

  // ---- action buttons ----
  const actions = div({ style: 'margin: 12px 0 4px 0;' });

  if (item.type === 'movie') {
    if (canDirectPlay(item)) {
      actions.appendChild(button({
        class: 'modal-watch-btn',
        onclick: () => player.play(streamUrl(item), {
          title: item.title,
          resumeMs: item.viewOffset || 0,
          ratingKey: item.ratingKey,
        }),
      }, item.viewOffset > 0 ? 'resume' : 'watch now'));
    } else {
      // container the browser can't play — hand off to the media server
      actions.appendChild(el('a', {
        class: 'modal-watch-btn', href: serverWebUrl(item), target: '_blank', rel: 'noopener',
      }, `watch on ${serverName()}`));
    }
  }

  const trailer = findTrailer(item);
  if (trailer) {
    actions.appendChild(button({
      class: 'modal-trailer-btn',
      onclick: () => player.play(streamUrl(trailer), { title: `${item.title} — trailer` }),
    }, 'trailer'));
  }

  info.appendChild(actions);

  if (item.rating) {
    info.appendChild(div({ class: 'modal-section-label' }, 'rating'));
    info.appendChild(div({ style: 'color:#d42027;font-size:1.4rem;margin-bottom:8px;' },
      `${item.rating.toFixed(1)} / 10`,
    ));
  }

  if (item.directors?.length > 0) {
    info.appendChild(div({ class: 'modal-section-label' }, 'director'));
    info.appendChild(div({ class: 'modal-directors' }, item.directors.map(d => d.tag).join(', ')));
  }

  if (item.summary) {
    info.appendChild(div({ class: 'modal-section-label' }, 'synopsis'));
    info.appendChild(div({ class: 'modal-synopsis' }, item.summary));
  }

  // ---- seasons and episodes for shows ----
  if (item.type === 'show') {
    const seasonsLabel = div({ class: 'modal-section-label' }, 'seasons');
    const seasonList = div({ class: 'modal-season-list' });
    const episodeList = div({ class: 'modal-episode-list' });
    info.appendChild(seasonsLabel);
    info.appendChild(seasonList);
    info.appendChild(episodeList);
    loadSeasons(item, seasonList, episodeList);
  }

  if (item.actors?.length > 0) {
    info.appendChild(div({ class: 'modal-section-label' }, 'cast'));
    const castGrid = div({ class: 'modal-cast-grid' });
    for (const actor of item.actors.slice(0, 20)) {
      castGrid.appendChild(div({},
        span({ class: 'modal-cast-actor' }, actor.tag),
        actor.role ? span({ class: 'modal-cast-role' }, ` — ${actor.role}`) : '',
      ));
    }
    info.appendChild(castGrid);
  }

  if (item.media?.length > 0) {
    const m = item.media[0];
    const bits = [];
    if (m.videoResolution) bits.push(m.videoResolution + 'p');
    if (m.videoCodec) bits.push(m.videoCodec.toUpperCase());
    if (m.audioCodec) bits.push(m.audioCodec.toUpperCase());
    info.appendChild(div({ class: 'modal-section-label' }, 'media'));
    info.appendChild(div({ class: 'modal-media-info' }, bits.join(' / ')));
  }

  // media server link always available as a fallback
  info.appendChild(el('a', {
    class: 'modal-play-link', href: serverWebUrl(item), target: '_blank', rel: 'noopener',
    style: 'margin-top:12px;',
  }, `open in ${serverName()}`));

  layout.appendChild(info);
  container.appendChild(layout);
}

async function loadSeasons(show, seasonList, episodeList) {
  try {
    const data = await fetchChildren(show.ratingKey);
    const seasons = (data.items || []).filter(s => s.type === 'season');

    seasons.forEach((season, i) => {
      const btn = button({
        class: 'modal-season-btn',
        onclick: () => {
          for (const b of seasonList.children) b.classList.remove('active');
          btn.classList.add('active');
          loadEpisodes(show, season, episodeList);
        },
      }, season.title || `season ${season.index}`);
      seasonList.appendChild(btn);
      if (i === 0) btn.click();
    });

    if (seasons.length === 0) {
      seasonList.appendChild(span({ style: 'color:#777;' }, 'no seasons found'));
    }
  } catch (err) {
    seasonList.appendChild(span({ style: 'color:#d42027;' }, `failed to load seasons: ${err.message}`));
  }
}

async function loadEpisodes(show, season, episodeList) {
  episodeList.innerHTML = '<span style="color:#777;">loading episodes...</span>';
  try {
    const data = await fetchChildren(season.ratingKey);
    episodeList.innerHTML = '';

    for (const ep of data.items || []) {
      const mins = ep.duration ? `${Math.floor(ep.duration / 60000)}m` : '';
      const row = button({
        class: 'modal-episode-row',
        onclick: () => {
          if (canDirectPlay(ep)) {
            player.play(streamUrl(ep), {
              title: `${show.title} — s${season.index}e${ep.index} ${ep.title}`,
              resumeMs: ep.viewOffset || 0,
              ratingKey: ep.ratingKey,
            });
          } else {
            window.open(serverWebUrl(ep), '_blank', 'noopener');
          }
        },
      },
        span({ class: 'modal-episode-num' }, `e${ep.index}`),
        span({ class: 'modal-episode-title' }, ep.title),
        span({ class: 'modal-episode-duration' }, mins),
      );
      episodeList.appendChild(row);
    }
  } catch (err) {
    episodeList.innerHTML = '';
    episodeList.appendChild(span({ style: 'color:#d42027;' }, `failed to load episodes: ${err.message}`));
  }
}
