import { promises as fsp } from 'node:fs';
import path from 'node:path';

const CACHE_FILE = path.join(process.cwd(), '.gev-cache', 'solums-world-geocode-v3.json');
const POSITIVE_TTL_MS = 30 * 24 * 60 * 60_000;
const NEGATIVE_TTL_MS = 60 * 60_000;
const MIN_UPSTREAM_INTERVAL_MS = 1150;
const MAX_CACHE_ITEMS = 1200;

export function solumsGeocodeProxy() {
  const cache = new Map();
  let loaded = false;
  let lastUpstreamAt = 0;
  let queue = Promise.resolve();

  async function loadDisk() {
    if (loaded) return;
    loaded = true;
    try {
      const parsed = JSON.parse(await fsp.readFile(CACHE_FILE, 'utf8'));
      for (const [key, entry] of Object.entries(parsed || {})) {
        if (entry && Number.isFinite(entry.at) && Array.isArray(entry.results)) cache.set(key, entry);
      }
    } catch {}
  }

  async function saveDisk() {
    try {
      await fsp.mkdir(path.dirname(CACHE_FILE), { recursive: true });
      const rows = [...cache.entries()].sort((a,b) => b[1].at - a[1].at).slice(0, MAX_CACHE_ITEMS);
      await fsp.writeFile(CACHE_FILE, JSON.stringify(Object.fromEntries(rows)), 'utf8');
    } catch (error) {
      console.warn('[SolumsAI] Geocode cache write failed:', error?.message || error);
    }
  }

  function sanitize(row) {
    return {
      lat: Number(row?.lat),
      lon: Number(row?.lon),
      name: String(row?.name || '').slice(0,200),
      displayName: String(row?.display_name || '').slice(0,600),
      category: String(row?.category || row?.class || '').slice(0,80),
      type: String(row?.type || '').slice(0,80),
      addresstype: String(row?.addresstype || '').slice(0,80),
      importance: Number.isFinite(Number(row?.importance)) ? Number(row.importance) : null,
      boundingbox: Array.isArray(row?.boundingbox) ? row.boundingbox.slice(0,4).map((v) => String(v).slice(0,40)) : null,
    };
  }

  async function upstream(query) {
    const wait = Math.max(0, MIN_UPSTREAM_INTERVAL_MS - (Date.now() - lastUpstreamAt));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    lastUpstreamAt = Date.now();

    const url = new URL('https://nominatim.openstreetmap.org/search');
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('limit', '6');
    url.searchParams.set('addressdetails', '1');
    url.searchParams.set('dedupe', '1');
    url.searchParams.set('accept-language', 'nb,en');

    const response = await fetch(url, {
      signal: AbortSignal.timeout(12000),
      redirect: 'error',
      headers: {
        Accept: 'application/json',
        'Accept-Language': 'nb,en;q=0.9',
        'User-Agent': 'Solums-Zeestar-Gods-Eye-local-geocoder/3.0',
      },
    });
    if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);

    const text = await response.text();
    if (Buffer.byteLength(text,'utf8') > 768000) throw new Error('Nominatim response too large');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed)
      ? parsed.map(sanitize).filter((row) => Number.isFinite(row.lat) && Number.isFinite(row.lon))
      : [];
  }

  async function lookup(query) {
    await loadDisk();
    const key = query.trim().toLowerCase();
    const cached = cache.get(key);
    if (cached) {
      const ttl = cached.results.length ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS;
      if (Date.now() - cached.at < ttl) return { results: cached.results, state: 'HIT' };
      cache.delete(key);
    }

    const work = queue.then(async () => {
      const results = await upstream(query);
      cache.set(key, { at: Date.now(), results });
      void saveDisk();
      return { results, state: 'MISS' };
    });
    queue = work.catch(() => {});
    return work;
  }

  async function handler(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'Method Not Allowed'}));
      return;
    }
    const url = new URL(req.url || '/', 'http://localhost');
    const query = String(url.searchParams.get('q') || '').trim().slice(0,240);
    if (query.length < 2) {
      res.writeHead(400, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'Missing location query'}));
      return;
    }
    try {
      const result = await lookup(query);
      res.writeHead(200, {
        'Content-Type':'application/json',
        'Cache-Control':'public, max-age=86400',
        'X-Solums-Geocode-Cache': result.state,
      });
      res.end(JSON.stringify({results: result.results}));
    } catch (error) {
      console.warn('[SolumsAI] World geocode failed:', error?.message || error);
      res.writeHead(502, {'Content-Type':'application/json','Cache-Control':'no-store'});
      res.end(JSON.stringify({error:'World geocoder temporarily unavailable'}));
    }
  }

  return {
    name: 'solums-world-geocoder',
    configureServer(server) { server.middlewares.use('/api/solums-geocode', handler); },
    configurePreviewServer(server) { server.middlewares.use('/api/solums-geocode', handler); },
  };
}

export default solumsGeocodeProxy;
