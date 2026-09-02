import * as Cesium from 'cesium';

/**
 * God's Eye View — Astro Weather layer for Vestfold.
 *
 * - Ringshaug is the default focus (public locality centre, not a private address).
 * - Association observatory is pinned at the exact coordinates supplied by the user.
 * - 48-hour hourly forecast, loaded once and scrubbed locally.
 * - Dense Vestfold grid + ultra-dense micro grids around the two focus sites.
 * - Smoothed raster overlay instead of visible square forecast cells.
 *
 * Weather source: Open-Meteo (CC BY 4.0). The host project already uses and
 * attributes Open-Meteo. This module also includes a visible attribution link.
 */

const RINGSHAUG = Object.freeze({
  id: 'ringshaug',
  name: 'RING SHAUG',
  displayName: 'Ringshaug',
  latitude: 59.28064,
  longitude: 10.49167,
});

const OBSERVATORY = Object.freeze({
  id: 'observatory',
  name: 'OBSERVATORIET',
  displayName: 'Observatoriet',
  latitude: 59.29139502027921,
  longitude: 9.995156084450006,
});

// A planning envelope that covers Vestfold and a small margin around it.
// This is intentionally not presented as the administrative county boundary.
const NORWAY = Object.freeze({
  west: 4.0,
  south: 57.8,
  east: 31.5,
  north: 71.4,
});

const SOUTH_NORWAY = Object.freeze({
  west: 4.5,
  south: 57.8,
  east: 13.5,
  north: 63.0,
});

const VESTFOLD = Object.freeze({
  west: 9.45,
  south: 58.78,
  east: 10.68,
  north: 59.82,
});

// Base grid: ~4–6 km spacing in Vestfold.
// Local micro-grids: ~1–1.5 km spacing around Ringshaug and the observatory.
const NORWAY_LAT_STEP = 1.10;
const NORWAY_LON_STEP = 2.00;

const SOUTH_LAT_STEP = 0.50;
const SOUTH_LON_STEP = 0.80;

const BASE_LAT_STEP = 0.075;
const BASE_LON_STEP = 0.125;

const MICRO_LAT_STEP = 0.015;
const MICRO_LON_STEP = 0.026;
const MICRO_LAT_RADIUS = 0.055;
const MICRO_LON_RADIUS = 0.105;

const FORECAST_HOURS = 48;
const BATCH_SIZE = 400;
const REFRESH_MS = 20 * 60 * 1000;
const RASTER_W = 480;
const RASTER_H = 720;
const DISPLAY_W = 480;
const DISPLAY_H = 720;
const OVERLAY_HEIGHT_METERS = 5500;

const css = `
#gev-astro-weather {
  position: absolute;
  left: 50%;
  bottom: 44px;
  transform: translateX(-50%);
  z-index: 850;
  width: min(760px, calc(100vw - 28px));
  color: #dff8f5;
  font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace;
  pointer-events: auto;
}
#gev-astro-weather .aw-shell {
  border: 1px solid rgba(111, 223, 214, .36);
  background: rgba(5, 13, 17, .88);
  backdrop-filter: blur(12px);
  box-shadow: 0 8px 28px rgba(0,0,0,.28);
}
#gev-astro-weather .aw-head,
#gev-astro-weather .aw-row,
#gev-astro-weather .aw-stats,
#gev-astro-weather .aw-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
#gev-astro-weather .aw-head {
  justify-content: space-between;
  padding: 9px 10px;
  border-bottom: 1px solid rgba(111, 223, 214, .18);
}
#gev-astro-weather .aw-head strong {
  font-size: 12px;
  letter-spacing: .12em;
}
#gev-astro-weather .aw-badge {
  font-size: 10px;
  opacity: .72;
}
#gev-astro-weather button {
  min-height: 34px;
  border: 1px solid rgba(111, 223, 214, .25);
  background: rgba(10, 24, 28, .8);
  color: inherit;
  font: inherit;
  font-size: 10px;
  letter-spacing: .06em;
  padding: 7px 9px;
  cursor: pointer;
}
#gev-astro-weather button[aria-pressed="true"],
#gev-astro-weather button:hover {
  border-color: rgba(111, 223, 214, .75);
  background: rgba(28, 68, 69, .78);
}
#gev-astro-weather .aw-body {
  padding: 9px 10px 10px;
}
#gev-astro-weather .aw-row {
  flex-wrap: wrap;
  margin-bottom: 8px;
}
#gev-astro-weather .aw-timeline {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 4px 10px;
  align-items: center;
}
#gev-astro-weather input[type="range"] {
  width: 100%;
  accent-color: #74d8d1;
}
#gev-astro-weather .aw-time {
  font-size: 11px;
  min-width: 155px;
  text-align: right;
}
#gev-astro-weather .aw-ticks {
  grid-column: 1 / -1;
  display: flex;
  justify-content: space-between;
  font-size: 9px;
  opacity: .52;
}
#gev-astro-weather .aw-stats {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  margin-top: 9px;
}
#gev-astro-weather .aw-stat {
  border-left: 1px solid rgba(111, 223, 214, .16);
  padding: 4px 7px;
  min-width: 0;
}
#gev-astro-weather .aw-stat:first-child { border-left: 0; }
#gev-astro-weather .aw-stat span {
  display: block;
  font-size: 8px;
  opacity: .58;
  letter-spacing: .08em;
}
#gev-astro-weather .aw-stat strong {
  display: block;
  font-size: 14px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#gev-astro-weather .aw-legend {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  font-size: 8px;
  opacity: .75;
  flex-wrap: wrap;
}
#gev-astro-weather .aw-chip {
  width: 18px;
  height: 7px;
  border-radius: 2px;
}
#gev-astro-weather .aw-credit {
  margin-left: auto;
  color: inherit;
  opacity: .62;
  text-decoration: none;
}
#gev-astro-weather .aw-status {
  font-size: 9px;
  opacity: .65;
  min-width: 120px;
}
#gev-astro-weather .aw-collapsed .aw-body { display: none; }
@media (max-width: 620px) {
  #gev-astro-weather { bottom: 20px; }
  #gev-astro-weather .aw-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  #gev-astro-weather .aw-stat { border-left: 0; border-top: 1px solid rgba(111, 223, 214, .13); }
  #gev-astro-weather .aw-time { text-align: left; }
  #gev-astro-weather .aw-timeline { grid-template-columns: 1fr; }
}
`;

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(v) ? v : min));
}

function haversineKm(aLat, aLon, bLat, bLon) {
  const r = 6371;
  const p1 = aLat * Math.PI / 180;
  const p2 = bLat * Math.PI / 180;
  const dp = (bLat - aLat) * Math.PI / 180;
  const dl = (bLon - aLon) * Math.PI / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(h));
}

function keyFor(lat, lon) {
  return `${lat.toFixed(4)},${lon.toFixed(4)}`;
}

function generateGrid() {
  const map = new Map();

  const inside = (box, lat, lon) =>
    lat >= box.south && lat <= box.north &&
    lon >= box.west && lon <= box.east;

  const add = (lat, lon, tier) => {
    if (!inside(NORWAY, lat, lon)) return;

    const key = keyFor(lat, lon);
    const priority = {
      norway: 1,
      south: 2,
      vestfold: 3,
      micro: 4,
    };

    const old = map.get(key);
    if (!old || priority[tier] > priority[old.tier]) {
      map.set(key, { lat, lon, tier, forecast: null });
    }
  };

  // Whole Norway: planning resolution, roughly 25–40 km.
  for (let lat = NORWAY.south; lat <= NORWAY.north + 1e-9; lat += NORWAY_LAT_STEP) {
    for (let lon = NORWAY.west; lon <= NORWAY.east + 1e-9; lon += NORWAY_LON_STEP) {
      add(Number(lat.toFixed(4)), Number(lon.toFixed(4)), 'norway');
    }
  }

  // South Norway: finer regional planning.
  for (let lat = SOUTH_NORWAY.south; lat <= SOUTH_NORWAY.north + 1e-9; lat += SOUTH_LAT_STEP) {
    for (let lon = SOUTH_NORWAY.west; lon <= SOUTH_NORWAY.east + 1e-9; lon += SOUTH_LON_STEP) {
      add(Number(lat.toFixed(4)), Number(lon.toFixed(4)), 'south');
    }
  }

  // Vestfold: local planning grid.
  for (let lat = VESTFOLD.south; lat <= VESTFOLD.north + 1e-9; lat += BASE_LAT_STEP) {
    for (let lon = VESTFOLD.west; lon <= VESTFOLD.east + 1e-9; lon += BASE_LON_STEP) {
      add(Number(lat.toFixed(5)), Number(lon.toFixed(5)), 'vestfold');
    }
  }

  // Highest detail around Ringshaug and the observatory.
  for (const focus of [RINGSHAUG, OBSERVATORY]) {
    for (
      let lat = focus.latitude - MICRO_LAT_RADIUS;
      lat <= focus.latitude + MICRO_LAT_RADIUS + 1e-9;
      lat += MICRO_LAT_STEP
    ) {
      for (
        let lon = focus.longitude - MICRO_LON_RADIUS;
        lon <= focus.longitude + MICRO_LON_RADIUS + 1e-9;
        lon += MICRO_LON_STEP
      ) {
        add(Number(lat.toFixed(5)), Number(lon.toFixed(5)), 'micro');
      }
    }

    add(focus.latitude, focus.longitude, 'micro');
  }

  return [...map.values()];
}
function apiLocalToEpochMs(isoLocal, utcOffsetSeconds) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(isoLocal || '');
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) - utcOffsetSeconds * 1000;
}

function formatNorwayTime(epochMs) {
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone: 'Europe/Oslo',
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(epochMs));
}

function scoreForecast(v) {
  const cloud = clamp(v.cloud, 0, 100);
  const precip = clamp(v.precipProbability, 0, 100);
  const humidity = clamp(v.humidity, 0, 100);
  const wind = clamp(v.wind, 0, 30);
  const visibility = clamp(v.visibility, 0, 40000);
  const dewSpread = Number.isFinite(v.temperature) && Number.isFinite(v.dewPoint)
    ? Math.max(0, v.temperature - v.dewPoint)
    : 4;

  const humidityPenalty = clamp((humidity - 70) / 30 * 100, 0, 100);
  const windPenalty = clamp((wind - 2) / 8 * 100, 0, 100);
  const visibilityPenalty = clamp((20000 - visibility) / 20000 * 100, 0, 100);
  const dewPenalty = clamp((4 - dewSpread) / 4 * 100, 0, 100);

  const penalty =
    cloud * 0.55 +
    precip * 0.15 +
    humidityPenalty * 0.10 +
    windPenalty * 0.08 +
    visibilityPenalty * 0.07 +
    dewPenalty * 0.05;

  return Math.round(clamp(100 - penalty, 0, 100));
}

function scoreColor(score, opacity = 1) {
  const s = clamp(score, 0, 100);
  let rgb;
  if (s >= 85) rgb = [62, 190, 170];
  else if (s >= 70) rgb = [111, 188, 123];
  else if (s >= 55) rgb = [194, 183, 87];
  else if (s >= 35) rgb = [215, 137, 67];
  else rgb = [203, 76, 76];

  // Good areas stay more transparent; poor areas stand out.
  const badness = 1 - s / 100;
  const alpha = clamp((0.24 + badness * 0.48) * opacity, 0.06, 0.82);
  return [rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)];
}

function pointValue(point, hourIndex) {
  const f = point.forecast;
  if (!f || hourIndex < 0 || hourIndex >= f.cloud.length) return null;
  const v = {
    cloud: f.cloud[hourIndex],
    humidity: f.humidity[hourIndex],
    precipProbability: f.precipProbability[hourIndex],
    wind: f.wind[hourIndex],
    visibility: f.visibility[hourIndex],
    temperature: f.temperature[hourIndex],
    dewPoint: f.dewPoint[hourIndex],
  };
  v.score = scoreForecast(v);
  return v;
}

async function fetchBatch(points) {
  const params = new URLSearchParams();

  params.set('latitude', points.map(p => p.lat.toFixed(5)).join(','));
  params.set('longitude', points.map(p => p.lon.toFixed(5)).join(','));

  params.set('hourly', [
    'cloud_cover',
    'relative_humidity_2m',
    'precipitation_probability',
    'wind_speed_10m',
    'visibility',
    'temperature_2m',
    'dew_point_2m',
  ].join(','));

  params.set('timezone', 'Europe/Oslo');
  params.set('forecast_hours', '48');
  params.set('wind_speed_unit', 'ms');
  params.set('cell_selection', 'nearest');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(
      'https://api.open-meteo.com/v1/forecast',
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      }
    );

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(
        `Open-Meteo HTTP ${response.status}: ${text.slice(0, 180)}`
      );
    }

    const json = await response.json();
    return Array.isArray(json) ? json : [json];

  } finally {
    clearTimeout(timer);
  }
}
async function loadForecast(points) {
  let forecastEpochs = null;

  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    const rows = await fetchBatch(batch);

    if (rows.length !== batch.length) {
      throw new Error(`Weather batch mismatch: requested ${batch.length}, received ${rows.length}`);
    }

    rows.forEach((row, j) => {
      const h = row.hourly || {};
      const times = Array.isArray(h.time) ? h.time : [];
      const offset = Number(row.utc_offset_seconds || 0);
      const epochs = times.map((t) => apiLocalToEpochMs(t, offset));

      if (!forecastEpochs) {
        const now = Date.now();
        let start = epochs.findIndex((t) => Number.isFinite(t) && t >= now - 30 * 60 * 1000);
        if (start < 0) start = 0;
        forecastEpochs = epochs.slice(start, start + FORECAST_HOURS);
      }

      const firstEpoch = forecastEpochs[0];
      const start = Math.max(0, epochs.findIndex((t) => t === firstEpoch));
      const take = (arr) => (Array.isArray(arr) ? arr.slice(start, start + FORECAST_HOURS) : Array(FORECAST_HOURS).fill(null));

      batch[j].forecast = {
        cloud: take(h.cloud_cover),
        humidity: take(h.relative_humidity_2m),
        precipProbability: take(h.precipitation_probability),
        wind: take(h.wind_speed_10m),
        visibility: take(h.visibility),
        temperature: take(h.temperature_2m),
        dewPoint: take(h.dew_point_2m),
      };
    });
  }

  if (!forecastEpochs || forecastEpochs.length < 24) {
    throw new Error('Weather source did not return a usable forecast window.');
  }

  return forecastEpochs.slice(0, FORECAST_HOURS);
}

function nearestPoint(points, focus) {
  let best = null;
  let bestD = Infinity;
  for (const p of points) {
    const d = haversineKm(p.lat, p.lon, focus.latitude, focus.longitude);
    if (d < bestD) {
      best = p;
      bestD = d;
    }
  }
  return best;
}

function bestPoint(points, hourIndex) {
  let best = null;
  let bestScore = -1;
  for (const p of points) {
    const v = pointValue(p, hourIndex);
    if (v && v.score > bestScore) {
      best = p;
      bestScore = v.score;
    }
  }
  return best ? { point: best, value: pointValue(best, hourIndex) } : null;
}

function precomputeRasterWeights(points) {
  const pixels = new Array(RASTER_W * RASTER_H);

  const xScale = 1 / (NORWAY.east - NORWAY.west);
  const yScale = 1 / (NORWAY.north - NORWAY.south);
  const lonFactor = Math.cos(64.0 * Math.PI / 180);

  for (let y = 0; y < RASTER_H; y++) {
    const lat =
      NORWAY.north -
      (y / (RASTER_H - 1)) * (NORWAY.north - NORWAY.south);

    for (let x = 0; x < RASTER_W; x++) {
      const lon =
        NORWAY.west +
        (x / (RASTER_W - 1)) * (NORWAY.east - NORWAY.west);

      const nearest = [];

      for (let i = 0; i < points.length; i++) {
        const p = points[i];

        const dy = (p.lat - lat) * yScale;
        const dx = (p.lon - lon) * xScale * lonFactor;
        const d2 = dx * dx + dy * dy + 1e-8;

        if (nearest.length < 4) {
          nearest.push([d2, i]);
          nearest.sort((a, b) => a[0] - b[0]);
        } else if (d2 < nearest[3][0]) {
          nearest[3] = [d2, i];
          nearest.sort((a, b) => a[0] - b[0]);
        }
      }

      let weightSum = 0;
      const packed = nearest.map(([d2, index]) => {
        const w = 1 / d2;
        weightSum += w;
        return [index, w];
      });

      for (const item of packed) {
        item[1] /= weightSum || 1;
      }

      pixels[y * RASTER_W + x] = packed;
    }
  }

  return pixels;
}
function makeOverlayCanvas(points, weights, hourIndex, opacity) {
  const low = document.createElement('canvas');
  low.width = RASTER_W;
  low.height = RASTER_H;
  const lowCtx = low.getContext('2d', { willReadFrequently: false });
  const img = lowCtx.createImageData(RASTER_W, RASTER_H);
  const data = img.data;

  for (let pIndex = 0; pIndex < weights.length; pIndex++) {
    const mix = weights[pIndex];
    let score = 0;
    let used = 0;
    for (const [pointIdx, w] of mix) {
      const v = pointValue(points[pointIdx], hourIndex);
      if (!v) continue;
      score += v.score * w;
      used += w;
    }
    score = used > 0 ? score / used : 50;
    const [r, g, b, a] = scoreColor(score, opacity);
    const o = pIndex * 4;
    data[o] = r;
    data[o + 1] = g;
    data[o + 2] = b;
    data[o + 3] = a;
  }
  lowCtx.putImageData(img, 0, 0);

  const canvas = document.createElement('canvas');
  canvas.width = DISPLAY_W;
  canvas.height = DISPLAY_H;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.filter = 'blur(7px)';
  // Expand slightly so blur does not create a transparent border.
  ctx.imageSmoothingEnabled = true;
    if ("imageSmoothingQuality" in ctx) ctx.imageSmoothingQuality = "high";
    ctx.filter = "blur(2px)";
    ctx.drawImage(low, -10, -10, DISPLAY_W + 20, DISPLAY_H + 20);
    ctx.filter = "none";
  ctx.filter = 'none';
  return canvas;
}

function buildPanel() {
  const root = document.createElement('aside');
  root.id = 'gev-astro-weather';
  root.innerHTML = `
    <div class="aw-shell aw-collapsed">
      <div class="aw-head">
        <div>
          <strong>ASTRO WEATHER · NORGE</strong>
          <span class="aw-badge" data-aw-status>OFF</span>
        </div>
        <div class="aw-actions">
          <button type="button" data-aw-toggle aria-pressed="false">WX OFF</button>
          <button type="button" data-aw-collapse aria-label="Expand Astro Weather">▲</button>
        </div>
      </div>
      <div class="aw-body">
        <div class="aw-row" role="group" aria-label="Astro weather focus">
          <button type="button" data-aw-focus="ringshaug" aria-pressed="true">RINGSHAUG</button>
          <button type="button" data-aw-focus="observatory" aria-pressed="false">OBSERVATORIET</button>
          <button type="button" data-aw-best>BEST I NORGE</button>
          <span class="aw-status" data-aw-detail>Slå på laget for 48 t prognose</span>
        </div>
        <div class="aw-timeline">
          <input type="range" min="0" max="47" step="1" value="0" data-aw-time disabled aria-label="Astro weather time, next 48 hours">
          <output class="aw-time" data-aw-time-label>—</output>
          <div class="aw-ticks"><span>NÅ</span><span>+12 T</span><span>+24 T</span><span>+36 T</span><span>+48 T</span></div>
        </div>
        <div class="aw-stats">
          <div class="aw-stat"><span>ASTRO SCORE</span><strong data-aw-score>—</strong></div>
          <div class="aw-stat"><span>SKYDEKKE</span><strong data-aw-cloud>—</strong></div>
          <div class="aw-stat"><span>LUFTFUKT</span><strong data-aw-humidity>—</strong></div>
          <div class="aw-stat"><span>VIND</span><strong data-aw-wind>—</strong></div>
          <div class="aw-stat"><span>NEDBØR RISIKO</span><strong data-aw-precip>—</strong></div>
        </div>
        <div class="aw-row" style="margin-top:8px;margin-bottom:0">
          <label style="font-size:9px;opacity:.7">TRANSPARENS
            <input type="range" min="20" max="100" value="78" step="1" data-aw-opacity aria-label="Weather overlay opacity">
          </label>
        </div>
        <div class="aw-legend" aria-label="Astro score legend">
          <span>SVAKT</span>
          <i class="aw-chip" style="background:rgba(203,76,76,.75)"></i>
          <i class="aw-chip" style="background:rgba(215,137,67,.68)"></i>
          <i class="aw-chip" style="background:rgba(194,183,87,.58)"></i>
          <i class="aw-chip" style="background:rgba(111,188,123,.48)"></i>
          <i class="aw-chip" style="background:rgba(62,190,170,.38)"></i>
          <span>MEGET BRA</span>
          <a class="aw-credit" href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a>
        </div>
      </div>
    </div>
  `;
  return root;
}

function addFocusEntity(viewer, focus, text) {
  return viewer.entities.add({
    id: `astro-weather-${focus.id}`,
    position: Cesium.Cartesian3.fromDegrees(focus.longitude, focus.latitude, 120),
    point: {
      pixelSize: 10,
      color: Cesium.Color.fromCssColorString('#d7fff8'),
      outlineColor: Cesium.Color.fromCssColorString('#173f3d'),
      outlineWidth: 2,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
    label: {
      text,
      font: '600 12px JetBrains Mono',
      fillColor: Cesium.Color.fromCssColorString('#e8fffb'),
      outlineColor: Cesium.Color.BLACK,
      outlineWidth: 3,
      style: Cesium.LabelStyle.FILL_AND_OUTLINE,
      pixelOffset: new Cesium.Cartesian2(0, -22),
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
      showBackground: true,
      backgroundColor: Cesium.Color.fromCssColorString('#071116').withAlpha(0.72),
      backgroundPadding: new Cesium.Cartesian2(7, 4),
    },
  });
}

export function installAstroWeatherLayer(viewer, options = {}) {
  if (!viewer || viewer.isDestroyed?.()) {
    console.warn('[Astro Weather] Cesium viewer not available.');
    return null;
  }
  if (document.getElementById('gev-astro-weather')) return null;

  const style = document.createElement('style');
  style.id = 'gev-astro-weather-style';
  style.textContent = css;
  document.head.appendChild(style);

  const panel = buildPanel();
  document.body.appendChild(panel);

  const shell = panel.querySelector('.aw-shell');
  const statusEl = panel.querySelector('[data-aw-status]');
  const detailEl = panel.querySelector('[data-aw-detail]');
  const toggleBtn = panel.querySelector('[data-aw-toggle]');
  const collapseBtn = panel.querySelector('[data-aw-collapse]');
  const timeInput = panel.querySelector('[data-aw-time]');
  const timeLabel = panel.querySelector('[data-aw-time-label]');
  const opacityInput = panel.querySelector('[data-aw-opacity]');
  const bestBtn = panel.querySelector('[data-aw-best]');
  const focusButtons = [...panel.querySelectorAll('[data-aw-focus]')];

  const scoreEl = panel.querySelector('[data-aw-score]');
  const cloudEl = panel.querySelector('[data-aw-cloud]');
  const humidityEl = panel.querySelector('[data-aw-humidity]');
  const windEl = panel.querySelector('[data-aw-wind]');
  const precipEl = panel.querySelector('[data-aw-precip]');

  const points = generateGrid();
  const weights = precomputeRasterWeights(points);
  const ringshaugPoint = nearestPoint(points, RINGSHAUG);
  const observatoryPoint = nearestPoint(points, OBSERVATORY);

  let focus = RINGSHAUG;
  let forecastTimes = [];
  let enabled = false;
  let loading = false;
  let lastLoaded = 0;
  let hourIndex = 0;
  let overlayEntity = null;
  let renderTicket = 0;

  const markers = [
    addFocusEntity(viewer, RINGSHAUG, 'RINGSHAUG · ASTRO WX'),
    addFocusEntity(viewer, OBSERVATORY, 'OBSERVATORIET · ASTRO WX'),
  ];
  markers.forEach((m) => { m.show = false; });

  function currentFocusPoint() {
    return focus.id === 'observatory' ? observatoryPoint : ringshaugPoint;
  }

  function setStatus(text, detail = '') {
    statusEl.textContent = text;
    if (detail) detailEl.textContent = detail;
  }

  function updateStats() {
    const p = currentFocusPoint();
    const v = p ? pointValue(p, hourIndex) : null;
    if (!v) {
      scoreEl.textContent = '—';
      cloudEl.textContent = '—';
      humidityEl.textContent = '—';
      windEl.textContent = '—';
      precipEl.textContent = '—';
      return;
    }
    scoreEl.textContent = `${v.score}/100`;
    cloudEl.textContent = `${Math.round(v.cloud)}%`;
    humidityEl.textContent = `${Math.round(v.humidity)}%`;
    windEl.textContent = `${Number(v.wind).toFixed(1)} m/s`;
    precipEl.textContent = `${Math.round(v.precipProbability)}%`;
    timeLabel.textContent = forecastTimes[hourIndex] ? formatNorwayTime(forecastTimes[hourIndex]) : '—';
  }

  function updateOverlay() {
    if (!enabled || !forecastTimes.length) return;
    const myTicket = ++renderTicket;
    requestAnimationFrame(() => {
      if (myTicket !== renderTicket || !enabled) return;
      const opacity = clamp(Number(opacityInput.value) / 100, 0.2, 1);
      const canvas = makeOverlayCanvas(points, weights, hourIndex, opacity);
      if (!overlayEntity) {
        overlayEntity = viewer.entities.add({
          id: 'astro-weather-vestfold-overlay',
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(NORWAY.west, NORWAY.south, NORWAY.east, NORWAY.north),
            height: OVERLAY_HEIGHT_METERS,
            material: new Cesium.ImageMaterialProperty({
              image: canvas,
              transparent: true,
            }),
          },
        });
      } else {
        overlayEntity.rectangle.material.image = canvas;
        overlayEntity.show = true;
      }
      viewer.scene.requestRender?.();
    });
  }

  async function ensureForecast(force = false) {
    if (loading) return;
    if (!force && forecastTimes.length && Date.now() - lastLoaded < REFRESH_MS) return;

    loading = true;
    setStatus('LOADING', `Henter ${points.length} værpunkter…`);
    toggleBtn.disabled = true;
    try {
      forecastTimes = await loadForecast(points);
      lastLoaded = Date.now();
      const max = Math.min(FORECAST_HOURS, forecastTimes.length) - 1;
      timeInput.max = String(Math.max(0, max));
      timeInput.disabled = false;
      hourIndex = Math.min(hourIndex, max);
      timeInput.value = String(hourIndex);
      setStatus('LIVE · 48 T', `${points.length} punkter · Norge + Sør-Norge + Vestfold fin-grid`);
    } catch (error) {
      console.error('[Astro Weather] Forecast load failed:', error);
      enabled = false;
      setStatus(
        'ERROR',
        `Værfeil: ${error?.message || 'ukjent feil'}`
      );
      toggleBtn.setAttribute('aria-pressed', 'false');
      toggleBtn.textContent = 'WX OFF';
      markers.forEach((m) => { m.show = false; });
      if (overlayEntity) overlayEntity.show = false;
      throw error;
    } finally {
      loading = false;
      toggleBtn.disabled = false;
    }
  }

  async function setEnabled(next) {
    enabled = Boolean(next);
    toggleBtn.setAttribute('aria-pressed', String(enabled));
    toggleBtn.textContent = enabled ? 'WX ON' : 'WX OFF';
    markers.forEach((m) => { m.show = enabled; });

    if (!enabled) {
      setStatus('OFF', 'Astro Weather er slått av');
      if (overlayEntity) overlayEntity.show = false;
      viewer.scene.requestRender?.();
      return;
    }

    shell.classList.remove('aw-collapsed');
    collapseBtn.textContent = '▼';
    collapseBtn.setAttribute('aria-label', 'Collapse Astro Weather');

    try {
      await ensureForecast(false);
      updateStats();
      updateOverlay();
    } catch {
      // ensureForecast already rendered an error state.
    }
  }

  toggleBtn.addEventListener('click', () => setEnabled(!enabled));

  collapseBtn.addEventListener('click', () => {
    shell.classList.toggle('aw-collapsed');
    const collapsed = shell.classList.contains('aw-collapsed');
    collapseBtn.textContent = collapsed ? '▲' : '▼';
    collapseBtn.setAttribute('aria-label', collapsed ? 'Expand Astro Weather' : 'Collapse Astro Weather');
  });

  focusButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      focus = btn.dataset.awFocus === 'observatory' ? OBSERVATORY : RINGSHAUG;
      focusButtons.forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      updateStats();
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(focus.longitude, focus.latitude, 62000),
        duration: 1.25,
      });
    });
  });

  bestBtn.addEventListener('click', () => {
    if (!forecastTimes.length) return;
    const best = bestPoint(points, hourIndex);
    if (!best) return;
    detailEl.textContent = `Best: ${best.value.score}/100 · ${best.point.lat.toFixed(3)}, ${best.point.lon.toFixed(3)}`;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(best.point.lon, best.point.lat, 50000),
      duration: 1.25,
    });
  });

  let timeDebounce = 0;
  timeInput.addEventListener('input', () => {
    hourIndex = clamp(Number(timeInput.value), 0, forecastTimes.length - 1);
    updateStats();
    clearTimeout(timeDebounce);
    timeDebounce = setTimeout(updateOverlay, 70);
  });

  opacityInput.addEventListener('input', () => {
    clearTimeout(timeDebounce);
    timeDebounce = setTimeout(updateOverlay, 70);
  });

  // Public API for debugging / future voice-tool integration.
  const api = {
    enable: () => setEnabled(true),
    disable: () => setEnabled(false),
    refresh: async () => {
      await ensureForecast(true);
      updateStats();
      updateOverlay();
    },
    flyToRingshaug: () => {
      focus = RINGSHAUG;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(RINGSHAUG.longitude, RINGSHAUG.latitude, 62000),
        duration: 1.25,
      });
      updateStats();
    },
    flyToObservatory: () => {
      focus = OBSERVATORY;
      viewer.camera.flyTo({
        destination: Cesium.Cartesian3.fromDegrees(OBSERVATORY.longitude, OBSERVATORY.latitude, 62000),
        duration: 1.25,
      });
      updateStats();
    },
    getState: () => ({
      enabled,
      focus: focus.displayName,
      hourIndex,
      time: forecastTimes[hourIndex] || null,
      samples: points.length,
    }),
  };

  window.gevAstroWeather = api;
  return api;
}
