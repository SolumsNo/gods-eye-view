/**
 * Solums Zeestar Night Earth SAFE v1.2
 *
 * IMPORTANT:
 * - Uses ongoing NASA Black Marble / VIIRS nighttime-radiance layers.
 * - Does not touch Google 3D, Cesium imagery, Visual Presets or map stack.
 *
 * Primary source is gap-filled BRDF-corrected radiance, which is much more
 * appropriate for light-pollution / dark-area analysis than the discontinued
 * ENCC display layer used in v1/v1.1.
 */

const NASA_WMS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi';
const MAX_BYTES = 6 * 1024 * 1024;
const MAX_DATE_FALLBACK = 21;

// Try the corrected, gap-filled products first. If one sensor has a temporary
// outage, fall back to the other sensor / at-sensor radiance product.
const SOURCES = [
  {
    id: 'VIIRS_NOAA20_GapFilled_BRDF_Corrected_DayNightBand_Radiance',
    label: 'NOAA-20 BLACK MARBLE',
  },
  {
    id: 'VIIRS_SNPP_GapFilled_BRDF_Corrected_DayNightBand_Radiance',
    label: 'SUOMI NPP BLACK MARBLE',
  },
  {
    id: 'VIIRS_NOAA20_DayNightBand_At_Sensor_Radiance',
    label: 'NOAA-20 DNB RADIANCE',
  },
  {
    id: 'VIIRS_SNPP_DayNightBand_At_Sensor_Radiance',
    label: 'SUOMI NPP DNB RADIANCE',
  },
];

function finite(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function addDays(iso, delta) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function makeWmsUrl({ source, west, south, east, north, width, height, date }) {
  const q = new URLSearchParams({
    SERVICE: 'WMS',
    VERSION: '1.1.1',
    REQUEST: 'GetMap',
    LAYERS: source,
    STYLES: '',
    FORMAT: 'image/png',
    TRANSPARENT: 'TRUE',
    SRS: 'EPSG:4326',
    BBOX: `${west},${south},${east},${north}`,
    WIDTH: String(width),
    HEIGHT: String(height),
    TIME: date,
  });
  return `${NASA_WMS}?${q}`;
}

async function getImage(params) {
  const response = await fetch(makeWmsUrl(params), {
    signal: AbortSignal.timeout(15_000),
    headers: { 'User-Agent': 'Solums-Zeestar-Night-Earth-Safe/1.2' },
  });

  if (!response.ok) {
    throw new Error(`NASA GIBS HTTP ${response.status}`);
  }

  const type = response.headers.get('content-type') || '';
  if (!type.startsWith('image/')) {
    throw new Error(`NASA GIBS returned ${type || 'non-image response'}`);
  }

  const ab = await response.arrayBuffer();
  if (ab.byteLength > MAX_BYTES) throw new Error('NASA response too large');

  return { type, body: Buffer.from(ab) };
}

async function probeSourceDate(source, date) {
  // Probe a deliberately bright region (NYC + surrounding metro). A genuine
  // daily nighttime-light product should not be a tiny transparent placeholder.
  try {
    const result = await getImage({
      source,
      west: -74.45,
      south: 40.35,
      east: -73.45,
      north: 41.15,
      width: 220,
      height: 220,
      date,
    });

    // Transparent/missing GIBS placeholders compress extremely small.
    // The threshold is intentionally conservative.
    return result.body.length > 2200;
  } catch {
    return false;
  }
}

export function nightEarthDataProxy() {
  const imageCache = new Map();
  const resolutionCache = new Map();
  const IMAGE_TTL = 10 * 60_000;
  const RESOLUTION_TTL = 60 * 60_000;

  async function resolveSourceAndDate(requestedDate) {
    const cached = resolutionCache.get(requestedDate);
    if (cached && Date.now() - cached.at < RESOLUTION_TTL) {
      return cached.value;
    }

    // Prefer recent dates before moving to alternate sensors. This keeps the
    // result temporally close while still surviving individual source outages.
    for (let back = 0; back <= MAX_DATE_FALLBACK; back++) {
      const date = addDays(requestedDate, -back);

      for (const source of SOURCES) {
        if (await probeSourceDate(source.id, date)) {
          const value = {
            sourceId: source.id,
            sourceLabel: source.label,
            date,
            fallbackDays: back,
          };
          resolutionCache.set(requestedDate, { at: Date.now(), value });
          return value;
        }
      }
    }

    throw new Error(
      `No ongoing VIIRS nighttime-light data found within ${MAX_DATE_FALLBACK} days before ${requestedDate}`
    );
  }

  async function handler(req, res) {
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    const u = new URL(req.url || '/', 'http://localhost');
    const west = finite(u.searchParams.get('west'));
    const south = finite(u.searchParams.get('south'));
    const east = finite(u.searchParams.get('east'));
    const north = finite(u.searchParams.get('north'));
    const width = Math.round(finite(u.searchParams.get('width')) || 700);
    const height = Math.round(finite(u.searchParams.get('height')) || 430);
    const requestedDate = String(u.searchParams.get('date') || '');

    const invalid =
      west == null || south == null || east == null || north == null
      || !(west >= -180 && west < east && east <= 180)
      || !(south >= -85 && south < north && north <= 85)
      || east - west > 170
      || north - south > 120
      || width < 32 || width > 900
      || height < 32 || height > 900
      || !validDate(requestedDate);

    if (invalid) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid Night Earth request' }));
      return;
    }

    try {
      const resolved = await resolveSourceAndDate(requestedDate);

      const cacheKey = [
        resolved.sourceId,
        resolved.date,
        west, south, east, north,
        width, height,
      ].join('|');

      const hit = imageCache.get(cacheKey);
      let payload;

      if (hit && Date.now() - hit.at < IMAGE_TTL) {
        payload = hit.payload;
      } else {
        payload = await getImage({
          source: resolved.sourceId,
          west, south, east, north,
          width, height,
          date: resolved.date,
        });

        imageCache.set(cacheKey, { at: Date.now(), payload });
        while (imageCache.size > 120) {
          imageCache.delete(imageCache.keys().next().value);
        }
      }

      res.writeHead(200, {
        'Content-Type': payload.type,
        'Cache-Control': 'public,max-age=300',
        'X-Night-Earth-Date': resolved.date,
        'X-Night-Earth-Fallback-Days': String(resolved.fallbackDays),
        'X-Night-Earth-Source': resolved.sourceId,
        'X-Night-Earth-Source-Label': resolved.sourceLabel,
        'Access-Control-Expose-Headers':
          'X-Night-Earth-Date,X-Night-Earth-Fallback-Days,X-Night-Earth-Source,X-Night-Earth-Source-Label',
      });

      res.end(payload.body);
    } catch (error) {
      console.warn('[NightEarthSafe v1.2]', error?.message || error);
      res.writeHead(502, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify({
        error: error?.message || 'NASA nighttime-light data unavailable',
      }));
    }
  }

  return {
    name: 'solums-night-earth-data-proxy',
    configureServer(server) {
      server.middlewares.use('/api/night-light-image', handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use('/api/night-light-image', handler);
    },
  };
}

export default nightEarthDataProxy;
