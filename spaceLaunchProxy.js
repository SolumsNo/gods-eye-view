/**
 * Upcoming Launch Library 2 proxy for God's Eye View Space Launch Mode.
 * Keeps LL2_API_TOKEN server-side and caches successful responses.
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';

const CACHE_TTL_MS = 15 * 60_000;
const STALE_MAX_MS = 24 * 60 * 60_000;
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const CACHE_PATH = path.join(process.cwd(), '.gev-cache', 'space-launch-upcoming-v2.3.json');

function headers() {
  const token = String(process.env.LL2_API_TOKEN || '').trim();
  return {
    Accept: 'application/json',
    'User-Agent': 'gods-eye-view-space-launch-mode/1.0',
    ...(token ? { Authorization: `Token ${token}` } : {}),
  };
}

async function readCapped(response) {
  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_RESPONSE_BYTES) {
    throw new Error('Launch Library response too large');
  }
  return text;
}

export function spaceLaunchUpcomingProxy() {
  let cache = null;
  let loaded = false;
  let inFlight = null;

  async function loadDisk() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_PATH, 'utf8'));
      if (Number.isFinite(parsed?.at) && typeof parsed?.body === 'string') {
        const body = JSON.parse(parsed.body);
        if (Array.isArray(body?.results)) cache = parsed;
      }
    } catch {
      // First run / no cache.
    }
  }

  async function saveDisk(entry) {
    try {
      await fsp.mkdir(path.dirname(CACHE_PATH), { recursive: true });
      await fsp.writeFile(CACHE_PATH, JSON.stringify(entry), 'utf8');
    } catch (error) {
      console.warn('[SpaceLaunch] cache write failed:', error?.message || error);
    }
  }

  async function refresh() {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86400000);
    const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
    url.searchParams.set('net__gte', now.toISOString());
    url.searchParams.set('net__lte', end.toISOString());
    url.searchParams.set('ordering', 'net');
    url.searchParams.set('limit', '100');
    url.searchParams.set('mode', 'detailed');

    const response = await fetch(url, {
      signal: AbortSignal.timeout(20000),
      headers: headers(),
    });
    const body = await readCapped(response);
    if (!response.ok) {
      const error = new Error(`Launch Library HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const parsed = JSON.parse(body);
    if (!Array.isArray(parsed?.results)) throw new Error('Malformed Launch Library response');
    const entry = { at: Date.now(), body };
    cache = entry;
    void saveDisk(entry);
    return entry;
  }

  function send(res, status, body, state) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': status == 200 ? 'public, max-age=300' : 'no-store',
      'X-GEV-Space-Launch-Cache': state,
    });
    res.end(body);
  }

  async function handler(req, res) {
    if (req.method !== 'GET') {
      send(res, 405, JSON.stringify({ error: 'Method Not Allowed' }), 'NONE');
      return;
    }
    await loadDisk();
    const now = Date.now();

    if (cache && now - cache.at < CACHE_TTL_MS) {
      send(res, 200, cache.body, 'HIT');
      return;
    }

    const stale = cache;
    try {
      if (!inFlight) {
        inFlight = refresh().finally(() => { inFlight = null; });
      }
      const fresh = await inFlight;
      send(res, 200, fresh.body, 'MISS');
    } catch (error) {
      if (stale && now - stale.at < STALE_MAX_MS) {
        send(res, 200, stale.body, 'STALE');
        return;
      }
      send(res, error?.status || 502, JSON.stringify({
        error: 'Upcoming launches are temporarily unavailable',
      }), 'NONE');
    }
  }

  return {
    name: 'space-launch-upcoming-proxy',
    configureServer(server) {
      server.middlewares.use('/api/upcoming-launches', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/upcoming-launches', handler);
    },
  };
}

export default spaceLaunchUpcomingProxy;
