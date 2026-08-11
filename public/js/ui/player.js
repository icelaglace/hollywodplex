/*
 * player.js — in-store video player overlay.
 * plays browser-compatible media (h264 mp4) streamed through the backend
 * proxy; anything else falls back to the media server's web app.
 */

import { div, button } from '../utils/dom.js';

// containers and codecs the browser can direct-play
const PLAYABLE_CONTAINERS = new Set(['mp4', 'mov', 'm4v']);
const PLAYABLE_VIDEO = new Set(['h264', 'hevc', 'av1', 'vp9']);

/*
 * check whether an item's first media entry can direct-play.
 */
export function canDirectPlay(item) {
  const m = item?.media?.[0];
  if (!m || !m.Part || m.Part.length === 0) return false;
  const container = (m.container || '').toLowerCase();
  const codec = (m.videoCodec || '').toLowerCase();
  return PLAYABLE_CONTAINERS.has(container) && PLAYABLE_VIDEO.has(codec);
}

/*
 * get the stream url for an item, or null when it cannot direct-play.
 */
export function streamUrl(item) {
  const part = item?.media?.[0]?.Part?.[0];
  if (!part || !part.key) return null;
  return `/stream?key=${encodeURIComponent(part.key)}`;
}

/*
 * full-screen player overlay. one instance for the whole app.
 */
const TIMELINE_INTERVAL = 10000; // report progress every 10 seconds

/*
 * fire-and-forget progress report so the media server keeps watch
 * state in sync.
 */
function reportTimeline(ratingKey, state, timeMs, durationMs) {
  if (!ratingKey) return;
  const params = new URLSearchParams({
    ratingKey,
    state,
    time: Math.floor(timeMs),
    duration: Math.floor(durationMs),
  });
  fetch(`/api/media/timeline?${params}`).catch(() => { /* best effort */ });
}

export function createPlayer() {
  let overlay = null;
  let video = null;
  let timelineTimer = null;
  let currentRatingKey = null;

  function stopReporting(finalState) {
    if (timelineTimer) {
      clearInterval(timelineTimer);
      timelineTimer = null;
    }
    if (video && currentRatingKey) {
      reportTimeline(
        currentRatingKey,
        finalState,
        video.currentTime * 1000,
        (video.duration || 0) * 1000,
      );
    }
    currentRatingKey = null;
  }

  function close() {
    stopReporting('stopped');
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    if (overlay && overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    overlay = null;
    video = null;
  }

  /*
   * play a media url. resumeMs seeks to a resume point when set,
   * ratingKey enables progress reporting back to the media server.
   */
  function play(url, { title = '', resumeMs = 0, ratingKey = null } = {}) {
    close();
    currentRatingKey = ratingKey;

    video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.src = url;
    video.className = 'player-video';

    if (resumeMs > 1000) {
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = resumeMs / 1000;
      }, { once: true });
    }

    // keep the server in sync: periodic reports while playing, plus state changes
    if (ratingKey) {
      const report = (state) => reportTimeline(
        ratingKey, state, video.currentTime * 1000, (video.duration || 0) * 1000,
      );
      timelineTimer = setInterval(() => {
        if (video && !video.paused) report('playing');
      }, TIMELINE_INTERVAL);
      video.addEventListener('play', () => report('playing'));
      video.addEventListener('pause', () => report('paused'));
      video.addEventListener('ended', () => stopReporting('stopped'));
    }

    const closeBtn = button({ class: 'player-close', onclick: close }, '×');
    const titleBar = div({ class: 'player-title' }, title);

    overlay = div({ class: 'player-overlay' }, titleBar, closeBtn, video);
    document.body.appendChild(overlay);

    // escape closes the player
    const onKey = (e) => {
      if (e.key === 'Escape') {
        close();
        document.removeEventListener('keydown', onKey);
      }
    };
    document.addEventListener('keydown', onKey);
  }

  return { play, close, isOpen: () => !!overlay };
}
