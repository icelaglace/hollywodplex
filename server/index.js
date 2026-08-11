/*
 * index.js — express application entry point.
 * serves the frontend and mounts api proxy routes over the configured
 * media backend (plex or jellyfin).
 */

import express from 'express';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import config from './config.js';
import backend from './media/index.js';
import mediaRoutes from './routes/media.js';
import imageRoutes from './routes/image.js';
import streamRoutes from './routes/stream.js';
import matchRoutes from './routes/match.js';
import recommendationRoutes from './routes/recommendations.js';
import errorHandler from './middleware/error-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = resolve(__dirname, '..', 'public');

const app = express();

// serve static frontend files
app.use(express.static(publicDir));

// api routes
app.get('/api/config', async (_req, res, next) => {
  try {
    const sections = (await backend.getSections()).map(s => ({
      key: s.key,
      title: s.title,
      type: s.type,
    }));

    // server identity for building web-app deep links
    const identity = await backend.getServerIdentity();

    res.json({
      serverType: backend.type,
      sections,
      machineIdentifier: identity.machineIdentifier,
      serverId: identity.serverId,
      serverUrl: backend.serverUrl,
      maxTextureDimension: 512,
      concurrentLoads: 4,
      shelfColumns: 6,
    });
  } catch (err) {
    next(err);
  }
});

// canonical mounts, plus /api/plex/* aliases kept for older scripts
// (the bundled fix-unmatched pipeline calls them)
app.use('/api/media/matches', matchRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/plex/matches', matchRoutes);
app.use('/api/plex', mediaRoutes);
app.use('/image', imageRoutes);
app.use('/stream', streamRoutes);
app.use('/api/recommendations', recommendationRoutes);

// error handling
app.use(errorHandler);

app.listen(config.port, () => {
  console.log(`hollywodplex running at http://localhost:${config.port}`);
  console.log(`media server: ${backend.type} at ${backend.serverUrl}`);
});
