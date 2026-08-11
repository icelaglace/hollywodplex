/*
 * config.js — read and validate environment configuration.
 * MEDIA_SERVER picks the backend: 'plex' or 'jellyfin'. when unset it is
 * inferred from which server url is configured, so existing plex-only
 * .env files keep working unchanged.
 */

import 'dotenv/config';

const plexServerUrl = (process.env.PLEX_SERVER_URL || '').replace(/\/+$/, '');
const jellyfinServerUrl = (process.env.JELLYFIN_SERVER_URL || '').replace(/\/+$/, '');

function inferMediaServer() {
  const explicit = (process.env.MEDIA_SERVER || '').trim().toLowerCase();
  if (explicit) return explicit;
  if (plexServerUrl) return 'plex';
  if (jellyfinServerUrl) return 'jellyfin';
  return '';
}

const mediaServer = inferMediaServer();

const config = {
  port: parseInt(process.env.PORT, 10) || 3478,
  mediaServer,
  plexServerUrl,
  plexToken: process.env.PLEX_TOKEN || '',
  jellyfinServerUrl,
  jellyfinApiKey: process.env.JELLYFIN_API_KEY || '',
  // optional: jellyfin user (name or id) whose library and watch state
  // the store uses. defaults to the first administrator.
  jellyfinUser: process.env.JELLYFIN_USER || '',
};

if (!['plex', 'jellyfin'].includes(mediaServer)) {
  console.error(
    mediaServer
      ? `unknown MEDIA_SERVER "${mediaServer}" — supported values are plex and jellyfin.`
      : 'no media server configured. set MEDIA_SERVER=plex or MEDIA_SERVER=jellyfin '
        + 'in .env (plus the matching *_SERVER_URL and token/api key).',
  );
  process.exit(1);
}

if (mediaServer === 'plex') {
  if (!config.plexServerUrl) {
    console.error('PLEX_SERVER_URL is required when MEDIA_SERVER=plex. set it in .env');
    process.exit(1);
  }
  if (!config.plexToken || config.plexToken === 'your-plex-token-here') {
    console.error('PLEX_TOKEN is required when MEDIA_SERVER=plex. set it in .env');
    process.exit(1);
  }
}

if (mediaServer === 'jellyfin') {
  if (!config.jellyfinServerUrl) {
    console.error('JELLYFIN_SERVER_URL is required when MEDIA_SERVER=jellyfin. set it in .env');
    process.exit(1);
  }
  if (!config.jellyfinApiKey || config.jellyfinApiKey === 'your-jellyfin-api-key') {
    console.error('JELLYFIN_API_KEY is required when MEDIA_SERVER=jellyfin. set it in .env');
    process.exit(1);
  }
}

export default config;
