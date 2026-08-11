/*
 * poster-picker.js — choose between the candidate posters the media
 * server's providers offer for a film. selecting one switches it, which
 * bumps the artwork url version so every cache refreshes naturally.
 */

import { fetchPosters, setPoster } from '../api/media-api.js';
import { div, button, img } from '../utils/dom.js';

export function attachPosterPicker(container, item, posterImg) {
  const toggle = button({ class: 'poster-picker-toggle' }, 'change poster');
  const grid = div({ class: 'poster-picker-grid', style: 'display:none' });
  container.appendChild(toggle);
  container.appendChild(grid);

  let loaded = false;

  toggle.addEventListener('click', async () => {
    if (grid.style.display !== 'none') {
      grid.style.display = 'none';
      return;
    }
    grid.style.display = 'grid';
    if (loaded) return;

    grid.textContent = 'loading options...';
    try {
      const { posters } = await fetchPosters(item.ratingKey);
      grid.textContent = '';
      if (!posters.length) {
        grid.textContent = 'no alternative posters available';
        return;
      }
      for (const p of posters) {
        const option = img({
          src: p.thumb,
          class: `poster-picker-option${p.selected ? ' selected' : ''}`,
          title: p.provider || '',
        });
        option.addEventListener('click', async () => {
          try {
            await setPoster(item.ratingKey, p.key);
            for (const el of grid.children) el.classList.remove('selected');
            option.classList.add('selected');
            // instant feedback on the card; the shelf case updates on
            // the next store load once the artwork url re-versions
            if (posterImg) posterImg.src = p.thumb;
          } catch (err) {
            console.warn('[poster-picker] failed to set poster:', err.message);
          }
        });
        grid.appendChild(option);
      }
      loaded = true;
    } catch (err) {
      grid.textContent = `failed to load posters: ${err.message}`;
    }
  });
}
