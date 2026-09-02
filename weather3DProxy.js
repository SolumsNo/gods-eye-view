/**
 * God's Eye View — Norway 3D Weather Field proxy
 *
 * Fixed, bounded Open-Meteo request:
 * - Norway + nearby seas / Sweden buffer
 * - regular grid
 * - ~5 days from the current hour
 * - total + low/mid/high cloud, precipitation and surface weather
 *
 * The browser cannot choose an arbitrary upstream URL or unbounded coordinate list.
 */

const CACHE_TTL_MS = 60 * 60_000;
const STALE_TTL_MS = 6 * 60 * 60_000;
const REQUEST_TIMEOUT_MS = 28_000;
const MAX_UPSTREAM_BYTES = 14 * 1024 * 1024;

const GRID = Object.freeze({
  south: 57.2,
  north: 71.8,
  west: 3.5,
  east: 31.5,
  rows: 17,
  cols: 16,
});

let cache = null;
let inFlight = null;

function round(value, decimals = 0) {
  if (!Number.isFinite(value)) return null;
  const p = 10 ** decimals;
  return Math.round(value * p) / p;
}

function gridPoints() {
  const points = [];
  for (let row = 0; row < GRID.rows; row += 1) {
    const lat = GRID.south + (GRID.north - GRID.south) * row / (GRID.rows - 1);
    for (let col = 0; col < GRID.cols; col += 1) {
      const lon = GRID.west + (GRID.east - GRID.west) * col / (GRID.cols - 1);
      points.push({ lat, lon });
    }
  }
  return points;
}

async function fetchTextCapped(url) {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      'User-Agent': 'gods-eye-view-weather-3d/1.0',
    },
  });

  const text = await response.text();
  if (Buffer.byteLength(text, 'utf8') > MAX_UPSTREAM_BYTES) {
    throw new Error('Open-Meteo weather field response exceeded size cap');
  }
  if (!response.ok) {
    const error = new Error(`Open-Meteo HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return text;
}

function normalizeSeries(hourly = {}) {
  const cloud = Array.isArray(hourly.cloud_cover) ? hourly.cloud_cover : [];
  const length = cloud.length;
  const take = (key, decimals = 0) => {
    const values = Array.isArray(hourly[key]) ? hourly[key] : [];
    return Array.from({ length }, (_, i) => round(Number(values[i]), decimals));
  };

  return {
    total: take('cloud_cover'),
    low: take('cloud_cover_low'),
    mid: take('cloud_cover_mid'),
    high: take('cloud_cover_high'),
    precip: take('precipitation', 2),
    temp: take('temperature_2m', 1),
    humidity: take('relative_humidity_2m'),
    wind: take('wind_speed_10m', 1),
    windDir: take('wind_direction_10m'),
    visibility: take('visibility'),
  };
}

async function refresh() {
  const points = gridPoints();

  // Open-Meteo explicitly supports comma-separated multiple coordinates.
  // Keep timezone UTC so every point shares one timeline.
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat.toFixed(4)).join(','),
    longitude: points.map((p) => p.lon.toFixed(4)).join(','),
    hourly: [
      'cloud_cover',
      'cloud_cover_low',
      'cloud_cover_mid',
      'cloud_cover_high',
      'precipitation',
      'temperature_2m',
      'relative_humidity_2m',
      'wind_speed_10m',
      'wind_direction_10m',
      'visibility',
    ].join(','),
    timezone: 'UTC',
    wind_speed_unit: 'ms',
    cell_selection: 'nearest',
    past_hours: '1',
    forecast_hours: '121',
  });

  const text = await fetchTextCapped(`https://api.open-meteo.com/v1/forecast?${params}`);
  const parsed = JSON.parse(text);
  const rows = Array.isArray(parsed) ? parsed : [parsed];

  if (rows.length !== points.length) {
    throw new Error(`Open-Meteo returned ${rows.length} points; expected ${points.length}`);
  }

  const times = rows[0]?.hourly?.time;
  if (!Array.isArray(times) || times.length < 24) {
    throw new Error('Open-Meteo returned no usable hourly timeline');
  }

  const payload = {
    status: 'ready',
    source: 'Open-Meteo Best Match',
    retrievedAt: new Date().toISOString(),
    grid: GRID,
    times,
    points: rows.map((row, index) => ({
      lat: points[index].lat,
      lon: points[index].lon,
      series: normalizeSeries(row.hourly),
    })),
  };

  cache = { at: Date.now(), payload };
  return payload;
}

function sendJson(res, status, body, cacheState) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': status === 200 ? 'public, max-age=300' : 'no-store',
    'X-GEV-Weather3D-Cache': cacheState,
  });
  res.end(JSON.stringify(body));
}

export function weather3DProxy() {
  async function handler(req, res) {
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'Method Not Allowed' }, 'NONE');
      return;
    }

    const now = Date.now();
    if (cache && now - cache.at <= CACHE_TTL_MS) {
      sendJson(res, 200, { ...cache.payload, status: 'cached' }, 'HIT');
      return;
    }

    const stale = cache;
    try {
      if (!inFlight) {
        inFlight = refresh().finally(() => { inFlight = null; });
      }
      const payload = await inFlight;
      sendJson(res, 200, payload, 'MISS');
    } catch (error) {
      console.warn('[Weather3D] weather field refresh failed:', error?.message || error);
      if (stale && now - stale.at <= STALE_TTL_MS) {
        sendJson(res, 200, { ...stale.payload, status: 'stale' }, 'STALE');
        return;
      }
      sendJson(res, 503, {
        error: '3D weather field is temporarily unavailable',
      }, 'NONE');
    }
  }

  return {
    name: 'weather-3d-proxy',
    configureServer(server) {
      server.middlewares.use('/api/weather-3d/norway', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/weather-3d/norway', handler);
    },
  };
}

export default weather3DProxy;
