/*
 * hud.js — heads-up display: crosshair, library info, hints, fps counter.
 */

import store from '../store.js';
import { getConfig } from '../config.js';
import { div, span } from '../utils/dom.js';

export function createHUD() {
  const hudEl = document.getElementById('hud');
  const libraryInfo = document.getElementById('hud-library-info');
  const status = document.getElementById('hud-status');
  const messages = document.getElementById('hud-messages');
  const lockPrompt = document.getElementById('hud-lock-prompt');

  if (!hudEl) return { show() {}, hide() {}, update() {}, showMessage() {} };

  // the video-case badge on the hover card names the configured server
  const hoverBadge = hudEl.querySelector('.hover-card-badge');
  if (hoverBadge && getConfig().serverType === 'jellyfin') {
    hoverBadge.textContent = 'JELLYFIN';
  }

  let fpsCounter = { frames: 0, lastTime: performance.now(), display: 0 };
  let showFps = false;
  let messageTimers = new Map();

  function show() {
    hudEl.style.display = 'block';
  }

  function hide() {
    hudEl.style.display = 'none';
  }

  function update(playerPos, infoText) {
    // fps counter
    fpsCounter.frames++;
    const now = performance.now();
    if (now - fpsCounter.lastTime >= 1000) {
      fpsCounter.display = fpsCounter.frames;
      fpsCounter.frames = 0;
      fpsCounter.lastTime = now;
    }

    // current room and stock line, supplied by the app
    if (libraryInfo && infoText) {
      libraryInfo.textContent = infoText;
    }

    // status
    if (status) {
      const parts = [];
      if (showFps) parts.push(`${fpsCounter.display} fps`);
      if (store.isPointerLocked) parts.push('locked');
      parts.push(store.mode === '3d' ? '3D' : '2D');
      status.textContent = parts.join(' | ');
    }

    // lock prompt
    if (lockPrompt) {
      lockPrompt.style.display = store.isPointerLocked ? 'none' : 'block';
    }
  }

  function showMessage(text, duration = 4000) {
    if (!messages) return;

    const id = Date.now();
    const msgEl = div({ class: 'hud-message' }, text);
    messages.appendChild(msgEl);

    const timer = setTimeout(() => {
      msgEl.style.opacity = '0';
      setTimeout(() => {
        if (msgEl.parentNode) msgEl.parentNode.removeChild(msgEl);
      }, 500);
      messageTimers.delete(id);
    }, duration);

    messageTimers.set(id, timer);
  }

  // toggle fps with backtick
  document.addEventListener('keydown', (e) => {
    if (e.code === 'Backquote') {
      showFps = !showFps;
    }
  });

  // hover info card — shows the aimed-at film's title and details
  const hoverCard = document.getElementById('hud-hover-card');
  const hoverTitle = document.getElementById('hover-card-title');
  const hoverMeta = document.getElementById('hover-card-meta');

  store.on('case-hover', (item) => {
    if (!hoverCard) return;
    if (!item) {
      hoverCard.style.display = 'none';
      return;
    }
    if (item.isKiosk) {
      hoverTitle.textContent = 'search the catalogue';
      hoverMeta.textContent = 'click to open';
      hoverCard.style.display = 'flex';
      return;
    }
    hoverTitle.textContent = item.title;
    if (item.reason) {
      // llm-recommended picks show the shelf note instead of metadata
      hoverMeta.textContent = `"${item.reason}"`;
    } else {
      const bits = [];
      if (item.directors && item.directors.length > 0) bits.push(item.directors[0].tag);
      if (item.year) bits.push(String(item.year));
      if (item.contentRating) bits.push(item.contentRating);
      hoverMeta.textContent = bits.join(' · ');
    }
    hoverCard.style.display = 'flex';
  });

  // listen to store events for automatic messages
  store.on('mode-changed', (mode) => {
    if (mode === '2d') {
      showMessage('switched to 2D browse — press Tab to return to 3D');
    } else {
      showMessage('entered 3D store — press Tab for 2D browse, E to search');
    }
  });

  return { show, hide, update, showMessage };
}
