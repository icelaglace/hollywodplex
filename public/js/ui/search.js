/*
 * search.js — retro terminal-style search overlay.
 * searches the library via the api as the user types.
 */

import store from '../store.js';
import { search as searchApi } from '../api/media-api.js';
import { div, span, img } from '../utils/dom.js';

export function createSearch(container) {
  const overlay = document.getElementById('search-overlay');
  const input = document.getElementById('search-input');
  const resultsDiv = document.getElementById('search-results');
  const closeBtn = document.getElementById('search-close');

  if (!overlay || !input) return { show() {}, hide() {}, isVisible() { return false; } };

  let debounceTimer = null;
  let results = [];
  let selectedIdx = -1;

  // client-side query cache — repeated queries (and backspacing) are instant
  const queryCache = new Map();
  const QUERY_CACHE_MAX = 60;

  function hide() {
    // keep the query and results so reopening resumes where you left off
    overlay.style.display = 'none';
    store.searchQuery = '';
    store.emit('overlay-closed');
  }

  function show() {
    overlay.style.display = 'flex';
    store.searchQuery = input.value.trim();
    store.emit('overlay-opened'); // releases the mouse in 3d mode
    renderResults();
    input.focus();
    // select the previous query so typing replaces it, but enter/arrows
    // still work on the previous results immediately
    input.select();
  }

  closeBtn.addEventListener('click', hide);

  // search on input
  input.addEventListener('input', () => {
    clearTimeout(debounceTimer);
    const query = input.value.trim();
    store.searchQuery = query;

    if (!query) {
      results = [];
      selectedIdx = -1;
      renderResults();
      return;
    }

    const cacheKey = `${store.activeSectionId}:${query.toLowerCase()}`;
    if (queryCache.has(cacheKey)) {
      results = queryCache.get(cacheKey);
      selectedIdx = -1;
      renderResults();
      return;
    }

    debounceTimer = setTimeout(async () => {
      try {
        const data = await searchApi(query, {
          sectionId: store.activeSectionId,
          size: 100,
        });
        results = data.items || [];
        selectedIdx = -1;

        // bound the cache — drop the oldest entry once full
        if (queryCache.size >= QUERY_CACHE_MAX) {
          queryCache.delete(queryCache.keys().next().value);
        }
        queryCache.set(cacheKey, results);

        renderResults();
      } catch (err) {
        console.warn('[search] search failed:', err.message);
      }
    }, 250);
  });

  // keyboard navigation
  input.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        selectedIdx = Math.min(selectedIdx + 1, results.length - 1);
        renderResults();
        break;
      case 'ArrowUp':
        e.preventDefault();
        selectedIdx = Math.max(selectedIdx - 1, -1);
        renderResults();
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIdx >= 0 && selectedIdx < results.length) {
          selectItem(results[selectedIdx]);
        }
        break;
      case 'Escape':
        e.preventDefault();
        hide();
        break;
    }
  });

  function selectItem(item) {
    if (!item || !item.ratingKey) return;
    hide();
    // warp the player to the film's spot on the shelf — the case gets a
    // highlight flash there; clicking it opens the detail card
    store.emit('locate-item', item.ratingKey);
  }

  function renderResults() {
    resultsDiv.innerHTML = '';

    if (results.length === 0 && store.searchQuery) {
      resultsDiv.appendChild(
        div({ style: 'padding:20px;color:rgba(0,255,0,0.5);text-align:center;' },
          'no results found',
        ),
      );
      return;
    }

    for (let i = 0; i < results.length; i++) {
      const item = results[i];
      const isSelected = i === selectedIdx;

      const row = div({
        class: `search-result-item${isSelected ? ' selected' : ''}`,
        onclick: () => selectItem(item),
      });

      const thumb = img({
        src: item.thumb || '',
        alt: item.title,
        class: 'search-result-thumb',
      });
      row.appendChild(thumb);

      const text = div({},
        span({ class: 'search-result-title' }, item.title),
        item.year ? span({ class: 'search-result-year' }, String(item.year)) : '',
      );
      row.appendChild(text);

      resultsDiv.appendChild(row);
    }
  }

  // toggle on E key or store event
  store.on('search-toggle', () => {
    if (overlay.style.display === 'none') {
      show();
    } else {
      hide();
    }
  });

  // close search and open modal when an item is selected from search
  store.on('item-selected', () => {
    if (overlay.style.display !== 'none') {
      hide();
    }
  });

  return { show, hide, isVisible: () => overlay.style.display !== 'none' };
}
