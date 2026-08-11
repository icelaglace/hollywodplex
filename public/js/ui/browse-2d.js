/*
 * browse-2d.js — fallback 2d grid browsing mode.
 * triggered when the user presses tab or pointer lock is unavailable.
 * shares the same store and api layer as the 3d mode.
 */

import store from '../store.js';
import { fetchItems, search as searchApi } from '../api/media-api.js';
import { div, img, el, span } from '../utils/dom.js';

export function createBrowse2D() {
  const container = document.getElementById('browse-2d');
  const grid = document.getElementById('browse-grid');
  const sentinel = document.getElementById('browse-sentinel');
  const sectionSelect = document.getElementById('browse-section-select');
  const sortSelect = document.getElementById('browse-sort-select');
  const searchInput = document.getElementById('browse-search');
  const to3dBtn = document.getElementById('browse-to-3d');

  if (!container || !grid) return { show() {}, hide() {} };

  let items = [];
  let offset = 0;
  let totalSize = 0;
  let isLoading = false;
  let searchDebounce = null;

  // populate section dropdown
  for (const lib of store.libraries) {
    sectionSelect.appendChild(el('option', { value: lib.key }, lib.title));
  }
  if (store.activeSectionId) {
    sectionSelect.value = store.activeSectionId;
  }

  async function loadPage(reset = false) {
    if (isLoading) return;
    isLoading = true;

    if (reset) {
      offset = 0;
      items = [];
      grid.innerHTML = '';
    }

    const sectionId = sectionSelect.value || store.activeSectionId;
    const sort = sortSelect.value;
    const query = searchInput.value.trim();

    try {
      let data;
      if (query) {
        data = await searchApi(query, { sectionId, start: offset, size: 50 });
      } else {
        data = await fetchItems(sectionId, { start: offset, size: 50, sort });
      }

      if (reset) {
        items = data.items || [];
      } else {
        items = items.concat(data.items || []);
      }
      totalSize = data.totalSize || 0;

      renderCards(reset ? data.items : data.items);
      offset += data.items ? data.items.length : 0;
    } catch (err) {
      console.warn('[browse-2d] failed to load:', err.message);
    } finally {
      isLoading = false;
    }
  }

  function renderCards(newItems) {
    if (!newItems) return;

    for (const item of newItems) {
      const card = div({ class: 'browse-card', onclick: () => store.selectItem(item.ratingKey) },
        img({ src: item.thumb || '', alt: item.title, class: 'browse-card-poster' }),
        div({ class: 'browse-card-title' }, item.title),
        item.year ? div({ class: 'browse-card-year' }, String(item.year)) : '',
      );
      grid.appendChild(card);
    }
  }

  // infinite scroll observer
  const observer = new IntersectionObserver((entries) => {
    if (entries[0].isIntersecting && !isLoading && items.length < totalSize) {
      loadPage();
    }
  }, { rootMargin: '200px' });

  if (sentinel) observer.observe(sentinel);

  // filter/sort change handlers
  sectionSelect.addEventListener('change', () => {
    store.activeSectionId = sectionSelect.value;
    loadPage(true);
  });

  sortSelect.addEventListener('change', () => loadPage(true));
  searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadPage(true), 300);
  });

  to3dBtn.addEventListener('click', () => {
    store.setMode('3d');
  });

  function show() {
    container.style.display = 'block';
    loadPage(true);
  }

  function hide() {
    container.style.display = 'none';
  }

  // react to mode changes
  store.on('mode-changed', (mode) => {
    if (mode === '2d') {
      show();
    } else {
      hide();
    }
  });

  return { show, hide };
}
