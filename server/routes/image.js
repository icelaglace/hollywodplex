/*
 * image.js — artwork proxy route.
 * fetches images from the media server with authentication,
 * caches them aggressively, and streams the result to the browser.
 * this keeps the server token off the client while allowing artwork display.
 */

import { Router } from 'express';
import sharp from 'sharp';
import backend from '../media/index.js';
import cache from '../services/cache.js';
import { getCachedImage, putCachedImage } from '../services/image-disk-cache.js';

// allowed resize widths — a fixed set so the disk cache stays bounded
// to a handful of variants per artwork
const ALLOWED_WIDTHS = new Set([64, 160, 256, 512]);

const router = Router();

// image content types by file extension
const MIME_TYPES = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

function guessMimeType(url) {
  const lower = url.toLowerCase().split('?')[0];
  for (const [ext, mime] of Object.entries(MIME_TYPES)) {
    if (lower.endsWith(ext)) return mime;
  }
  return 'image/jpeg'; // default for library artwork
}

router.get('/', async (req, res, next) => {
  try {
    const { url: rawUrl, width } = req.query;

    if (!rawUrl) {
      return res.status(400).json({ error: 'missing_url', message: 'url query parameter is required' });
    }

    // safety: strip any auth token that may have leaked into the url,
    // and require a server-relative path so the token can never be sent
    // to an arbitrary external host
    const url = backend.sanitizeImagePath(rawUrl);
    if (!url) {
      return res.status(400).json({ error: 'bad_url', message: 'url must be a server-relative path' });
    }

    const serve = (buffer, contentType) => {
      res.set('Content-Type', contentType);
      // one hour, not a day: the server occasionally replaces artwork
      // without changing the url (e.g. agent match landing after first
      // browse), so bounded browser staleness beats a stuck wrong poster
      res.set('Cache-Control', 'public, max-age=3600');
      res.send(buffer);
    };

    // snap the requested width to the allowed variant set; no width
    // (or an unknown one) serves the full-size master. keys stay
    // backend-neutral: plex and jellyfin paths cannot collide, and
    // existing disk caches survive an upgrade.
    const w = ALLOWED_WIDTHS.has(parseInt(width, 10)) ? parseInt(width, 10) : null;
    const sizedKey = cache.constructor.key('GET', `image:${url}?width=${w || ''}`);
    const masterKey = cache.constructor.key('GET', `image:${url}?width=`);

    // images are served from disk only — the os page cache keeps hot
    // files at ram speed, and artwork urls are versioned so entries
    // never go stale.
    const disk = await getCachedImage(sizedKey);
    if (disk) return serve(disk.buffer, disk.contentType);

    // get the full-size master: disk first, then the media server (once ever)
    let master = w ? await getCachedImage(masterKey) : null;
    if (!master) {
      const fetched = await backend.fetchImage(url);
      master = {
        buffer: fetched.buffer,
        contentType: fetched.contentType || guessMimeType(url),
      };
      putCachedImage(masterKey, master.buffer, master.contentType); // fire and forget
    }

    if (!w) return serve(master.buffer, master.contentType);

    // derive the sized variant with sharp and cache it — resized once,
    // served from disk forever after
    const resized = await sharp(master.buffer)
      .resize({ width: w, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    putCachedImage(sizedKey, resized, 'image/jpeg'); // fire and forget

    serve(resized, 'image/jpeg');
  } catch (err) {
    next(err);
  }
});

export default router;
