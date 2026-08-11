/*
 * index.js — media backend selection.
 * MEDIA_SERVER in .env decides which adapter the whole server uses.
 * both adapters expose the same interface and produce the same
 * normalized item shape, so everything downstream is backend-agnostic.
 */

import config from '../config.js';
import plexBackend from './plex.js';
import jellyfinBackend from './jellyfin.js';

const backend = config.mediaServer === 'jellyfin' ? jellyfinBackend : plexBackend;

export default backend;
