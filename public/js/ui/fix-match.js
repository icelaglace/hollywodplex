/*
 * fix-match.js — search the media server's metadata providers for the
 * right match and apply it from inside the film modal. films that were
 * never matched (guid local://) show their filename as the title and
 * have no provider artwork; fixing the match pulls proper metadata.
 */

import { fetchMatches, applyMatch } from '../api/media-api.js';
import store from '../store.js';
import { div, span, button, el } from '../utils/dom.js';

export function isUnmatched(item) {
  return typeof item.guid === 'string' && item.guid.startsWith('local://');
}

/*
 * best-effort search query from a filename-style title: prefer the part
 * after "aka" when present, and drop a trailing year plus anything after it.
 */
function guessTitle(title) {
  let t = title || '';
  const aka = / aka /i.exec(t);
  if (aka) t = t.slice(aka.index + aka[0].length);
  t = t.replace(/\b(19|20)\d{2}\b.*$/, '').trim();
  return t || title;
}

export function attachFixMatch(container, item) {
  const unmatched = isUnmatched(item);
  const toggle = button(
    { class: `fix-match-toggle${unmatched ? ' unmatched' : ''}` },
    unmatched ? 'fix match (unmatched)' : 'fix match',
  );
  const panel = div({ class: 'fix-match-panel', style: 'display:none' });
  container.appendChild(toggle);
  container.appendChild(panel);

  const input = el('input', {
    class: 'fix-match-input',
    type: 'text',
    value: guessTitle(item.title),
    placeholder: 'search title...',
  });
  const searchBtn = button({ class: 'fix-match-search' }, 'search');
  const results = div({ class: 'fix-match-results' });
  const status = div({ class: 'fix-match-status' });
  panel.appendChild(div({ class: 'fix-match-row' }, input, searchBtn));
  panel.appendChild(status);
  panel.appendChild(results);

  async function runSearch() {
    const title = input.value.trim();
    if (!title) return;
    status.textContent = 'searching...';
    results.textContent = '';
    try {
      const { matches } = await fetchMatches(item.ratingKey, { title, year: item.year });
      status.textContent = matches.length ? '' : 'no matches found — try a shorter title';
      for (const m of matches) {
        results.appendChild(button(
          { class: 'fix-match-result', onclick: () => apply(m) },
          span({ class: 'fix-match-name' }, m.name),
          m.year ? span({ class: 'fix-match-year' }, ` (${m.year})`) : '',
        ));
      }
    } catch (err) {
      status.textContent = `search failed: ${err.message}`;
    }
  }

  async function apply(m) {
    status.textContent = `matching to ${m.name}...`;
    results.textContent = '';
    try {
      await applyMatch(item.ratingKey, m.guid, m.name);
      status.textContent = 'matched — reloading details...';
      // reopen the modal so it refetches the now-corrected metadata.
      // the shelf case picks up the new artwork on the next store load.
      store.emit('item-selected', item.ratingKey);
    } catch (err) {
      status.textContent = `match failed: ${err.message}`;
    }
  }

  toggle.addEventListener('click', () => {
    const open = panel.style.display !== 'none';
    panel.style.display = open ? 'none' : 'block';
    if (!open) input.focus();
  });
  searchBtn.addEventListener('click', runSearch);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') runSearch();
    e.stopPropagation();
  });
}
