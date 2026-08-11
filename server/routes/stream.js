/*
 * stream.js — media streaming proxy with range request support.
 * streams media files from the configured server so the browser's
 * <video> element can play and seek directly, with the auth token
 * kept server-side.
 */

import { Router } from 'express';
import axios from 'axios';
import backend from '../media/index.js';

const router = Router();

router.get('/', async (req, res, next) => {
  try {
    const { key: rawKey } = req.query;
    if (!rawKey) {
      return res.status(400).json({ error: 'missing_key', message: 'key query parameter is required' });
    }

    // safety: strip any token from the key and require a server-relative path
    const key = backend.sanitizeStreamPath(rawKey);
    if (!key) {
      return res.status(400).json({ error: 'bad_key', message: 'key must be a server-relative path' });
    }

    const { url, headers } = backend.streamRequest(key);
    // forward the range header so seeking works
    if (req.headers.range) {
      headers.Range = req.headers.range;
    }

    const upstream = await axios.get(url, {
      headers,
      responseType: 'stream',
      // media requests can run for the length of the playback session
      timeout: 0,
      validateStatus: (s) => s < 500,
    });

    // pass through status (200 or 206 partial content) and media headers
    res.status(upstream.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (upstream.headers[h]) res.set(h, upstream.headers[h]);
    }
    if (!upstream.headers['accept-ranges']) {
      res.set('Accept-Ranges', 'bytes');
    }

    upstream.data.pipe(res);

    // stop pulling from the server if the client disconnects (e.g. seeking)
    res.on('close', () => {
      upstream.data.destroy();
    });
  } catch (err) {
    next(err);
  }
});

export default router;
