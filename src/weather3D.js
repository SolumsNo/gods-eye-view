import * as Cesium from 'cesium';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from './renderGovernor.js';

const STYLE_ID = 'gev-weather3d-style';
const PANEL_ID = 'gev-weather3d-panel';
const BUTTON_ID = 'gev-weather3d-button';
const API_URL = '/api/weather-3d/norway';

const DEFAULT_LOCATION = Object.freeze({
  name: 'Tønsberg',
  lat: 59.2675,
  lon: 10.4076,
});

const QUALITY = Object.freeze({
  LOW: Object.freeze({ low: 170, mid: 120, high: 90 }),
  MED: Object.freeze({ low: 310, mid: 220, high: 165 }),
  HIGH: Object.freeze({ low: 520, mid: 390, high: 290 }),
});

const LAYERS = Object.freeze({
  low: Object.freeze({ label: 'LOW', baseHeight: 1500, spread: 1300, alpha: 0.70, size: 0.92 }),
  mid: Object.freeze({ label: 'MID', baseHeight: 5200, spread: 2500, alpha: 0.50, size: 0.82 }),
  high: Object.freeze({ label: 'HIGH', baseHeight: 9800, spread: 2600, alpha: 0.34, size: 0.78 }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  if (!Number.isFinite(a)) return Number.isFinite(b) ? b : null;
  if (!Number.isFinite(b)) return a;
  return a + (b - a) * t;
}

function hash32(value) {
  let x = value | 0;
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  return (x ^ (x >>> 16)) >>> 0;
}

function rng(seed) {
  let state = hash32(seed || 1);
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function utcMs(iso) {
  if (!iso) return NaN;
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : `${iso}Z`);
}

function formatForecastTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('nb-NO', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Europe/Oslo',
  }).format(new Date(ms));
}

function formatDay(ms) {
  if (!Number.isFinite(ms)) return '—';
  return new Intl.DateTimeFormat('nb-NO', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    timeZone: 'Europe/Oslo',
  }).format(new Date(ms));
}

function makeCloudTexture(seed, wispy = false) {
  const width = 256;
  const height = 144;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const random = rng(seed);

  ctx.clearRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'source-over';

  const count = wispy ? 19 : 28;
  for (let i = 0; i < count; i += 1) {
    const x = width * (0.12 + random() * 0.76);
    const y = height * (0.20 + random() * 0.58);
    const rx = (wispy ? 34 : 22) + random() * (wispy ? 54 : 38);
    const ry = (wispy ? 8 : 13) + random() * (wispy ? 18 : 28);
    const alpha = (wispy ? 0.035 : 0.05) + random() * (wispy ? 0.09 : 0.15);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, Math.max(rx, ry));
    gradient.addColorStop(0, `rgba(255,255,255,${alpha})`);
    gradient.addColorStop(0.42, `rgba(245,250,255,${alpha * 0.86})`);
    gradient.addColorStop(1, 'rgba(230,242,255,0)');
    ctx.fillStyle = gradient;
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(rx / Math.max(rx, ry), ry / Math.max(rx, ry));
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(rx, ry), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Soft central body so sparse puff fields remain coherent.
  const core = ctx.createRadialGradient(width * .5, height * .52, 4, width * .5, height * .52, width * .44);
  core.addColorStop(0, wispy ? 'rgba(255,255,255,.12)' : 'rgba(255,255,255,.22)');
  core.addColorStop(.55, wispy ? 'rgba(240,248,255,.07)' : 'rgba(240,248,255,.12)');
  core.addColorStop(1, 'rgba(235,245,255,0)');
  ctx.fillStyle = core;
  ctx.fillRect(0, 0, width, height);

  return canvas;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID} {
      position:fixed; right:18px; bottom:136px; z-index:2040;
      display:flex; align-items:center; gap:7px;
      border:1px solid rgba(117,221,255,.28); border-radius:9px;
      background:rgba(4,13,22,.90); color:#bfefff;
      padding:8px 10px; font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;
      letter-spacing:.09em; cursor:pointer; backdrop-filter:blur(12px);
      box-shadow:0 8px 30px rgba(0,0,0,.34);
    }
    #${BUTTON_ID}:hover, #${BUTTON_ID}.active {
      background:rgba(20,91,118,.35); border-color:rgba(105,229,255,.62); color:#fff;
    }
    #${PANEL_ID} {
      position:fixed; z-index:2035; left:50%; bottom:24px; transform:translateX(-50%);
      width:min(940px,calc(100vw - 30px));
      color:#eafaff;
      background:
        radial-gradient(circle at 65% 0%,rgba(54,141,174,.15),transparent 40%),
        linear-gradient(180deg,rgba(5,15,24,.96),rgba(2,8,13,.96));
      border:1px solid rgba(117,221,255,.26); border-radius:12px;
      box-shadow:0 18px 62px rgba(0,0,0,.48); backdrop-filter:blur(15px);
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
      user-select:none;
    }
    #${PANEL_ID}[hidden]{display:none!important}
    #${PANEL_ID} .w3-head {
      display:grid; grid-template-columns:auto 1fr auto; gap:11px; align-items:center;
      padding:9px 11px 8px; border-bottom:1px solid rgba(117,221,255,.10);
    }
    #${PANEL_ID} .w3-title { color:#77e4ff; font-size:10px; font-weight:900; letter-spacing:.16em; white-space:nowrap; }
    #${PANEL_ID} .w3-status { color:rgba(211,238,248,.50); font-size:8px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${PANEL_ID} .w3-close { border:0; background:transparent; color:#9ebecb; font-size:19px; cursor:pointer; }
    #${PANEL_ID} .w3-body { padding:8px 11px 10px; }
    #${PANEL_ID} .w3-toolbar { display:flex; flex-wrap:wrap; gap:6px; align-items:center; margin-bottom:7px; }
    #${PANEL_ID} .w3-btn {
      border:1px solid rgba(111,215,251,.18); background:rgba(59,158,198,.06);
      color:#bcefff; border-radius:6px; padding:6px 8px; font:inherit; font-size:8px; cursor:pointer;
    }
    #${PANEL_ID} .w3-btn:hover, #${PANEL_ID} .w3-btn.active {
      background:rgba(65,180,220,.18); color:#fff; border-color:rgba(111,215,251,.46);
    }
    #${PANEL_ID} .w3-time { margin-left:auto; color:#fff; font-size:11px; font-weight:800; white-space:nowrap; }
    #${PANEL_ID} .w3-location { color:#74dbff; font-size:8px; white-space:nowrap; }
    #${PANEL_ID} .w3-slider-row { display:grid; grid-template-columns:55px 1fr 55px; align-items:center; gap:8px; }
    #${PANEL_ID} .w3-edge { color:rgba(194,224,235,.44); font-size:8px; }
    #${PANEL_ID} .w3-edge:last-child{text-align:right}
    #${PANEL_ID} input[type="range"] { width:100%; accent-color:#72def9; cursor:pointer; }
    #${PANEL_ID} .w3-days { display:flex; justify-content:space-between; color:rgba(188,221,233,.38); font-size:7px; padding:2px 61px 0; }
    #${PANEL_ID} .w3-metrics {
      display:grid; grid-template-columns:repeat(7,minmax(74px,1fr)); gap:5px; margin-top:7px;
    }
    #${PANEL_ID} .w3-metric {
      border:1px solid rgba(117,213,247,.08); background:rgba(255,255,255,.018);
      border-radius:6px; padding:5px 6px; min-width:0;
    }
    #${PANEL_ID} .w3-label { color:rgba(196,224,235,.40); font-size:7px; letter-spacing:.11em; }
    #${PANEL_ID} .w3-value { color:#edfaff; font-size:9px; font-weight:800; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    #${PANEL_ID} .w3-note { margin-top:5px; color:rgba(189,218,230,.35); font-size:7px; line-height:1.35; }
    #${PANEL_ID}.loading .w3-time::after { content:'  · LOADING'; color:#ffd278; font-size:8px; }
    @media(max-width:900px) {
      #${BUTTON_ID}{right:12px;bottom:126px}
      #${PANEL_ID}{bottom:12px;width:calc(100vw - 20px)}
      #${PANEL_ID} .w3-metrics{grid-template-columns:repeat(4,1fr)}
      #${PANEL_ID} .w3-title{font-size:9px}
    }
  `;
  document.head.appendChild(style);
}

function createUi(onToggle, onAction, onSlider) {
  ensureStyles();

  let button = document.getElementById(BUTTON_ID);
  if (!button) {
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.innerHTML = '☁️ <span>WEATHER 3D</span>';
    button.addEventListener('click', onToggle);
    document.body.appendChild(button);
  }

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.innerHTML = `
      <div class="w3-head">
        <div class="w3-title">☁️ LIVE WEATHER + 3D CLOUDS</div>
        <div class="w3-status" data-w3-status>NORWAY · MODEL ANALYSIS + FORECAST</div>
        <button class="w3-close" type="button" data-w3-action="close">×</button>
      </div>
      <div class="w3-body">
        <div class="w3-toolbar">
          <button class="w3-btn active" data-w3-action="now">NOW</button>
          <button class="w3-btn" data-w3-action="play">▶ PLAY</button>
          <button class="w3-btn active" data-w3-layer="low">LOW</button>
          <button class="w3-btn active" data-w3-layer="mid">MID</button>
          <button class="w3-btn active" data-w3-layer="high">HIGH</button>
          <button class="w3-btn" data-w3-action="location">MAP CENTER</button>
          <button class="w3-btn" data-w3-quality="LOW">LOW Q</button>
          <button class="w3-btn active" data-w3-quality="MED">MED Q</button>
          <button class="w3-btn" data-w3-quality="HIGH">HIGH Q</button>
          <span class="w3-location" data-w3-location>TØNSBERG</span>
          <span class="w3-time" data-w3-time>—</span>
        </div>
        <div class="w3-slider-row">
          <span class="w3-edge">NOW</span>
          <input data-w3-slider type="range" min="0" max="1" value="0" step="0.25" aria-label="Weather forecast timeline">
          <span class="w3-edge">+5D</span>
        </div>
        <div class="w3-days" data-w3-days></div>
        <div class="w3-metrics">
          <div class="w3-metric"><div class="w3-label">TOTAL CLOUD</div><div class="w3-value" data-w3-total>—</div></div>
          <div class="w3-metric"><div class="w3-label">LOW / MID / HIGH</div><div class="w3-value" data-w3-layers>—</div></div>
          <div class="w3-metric"><div class="w3-label">TEMP</div><div class="w3-value" data-w3-temp>—</div></div>
          <div class="w3-metric"><div class="w3-label">HUMIDITY</div><div class="w3-value" data-w3-humidity>—</div></div>
          <div class="w3-metric"><div class="w3-label">PRECIP</div><div class="w3-value" data-w3-precip>—</div></div>
          <div class="w3-metric"><div class="w3-label">WIND</div><div class="w3-value" data-w3-wind>—</div></div>
          <div class="w3-metric"><div class="w3-label">VISIBILITY</div><div class="w3-value" data-w3-visibility>—</div></div>
        </div>
        <div class="w3-note">
          3D clouds are a smooth model rendering, not satellite photography. Open-Meteo Best Match combines the best applicable forecast models;
          short-range Norwegian guidance can use high-resolution Nordic model input, while vertical cloud layers may come from models that expose those fields.
        </div>
      </div>`;
    panel.addEventListener('click', onAction);
    panel.querySelector('[data-w3-slider]')?.addEventListener('input', onSlider);
    document.body.appendChild(panel);
  }

  return { button, panel };
}

function cameraCentre(viewer) {
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const center = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  let cartesian = viewer.camera.pickEllipsoid(center, Cesium.Ellipsoid.WGS84);
  if (!cartesian && scene.pickPositionSupported) {
    try { cartesian = scene.pickPosition(center); } catch {}
  }
  if (!cartesian) return null;
  const c = Cesium.Cartographic.fromCartesian(cartesian);
  if (!c) return null;
  return {
    name: 'Map center',
    lat: Cesium.Math.toDegrees(c.latitude),
    lon: Cesium.Math.toDegrees(c.longitude),
  };
}

function pointIndex(grid, row, col) {
  return clamp(row, 0, grid.rows - 1) * grid.cols + clamp(col, 0, grid.cols - 1);
}

function spatialSample(dataset, lat, lon, key, timePosition) {
  const { grid, points } = dataset;
  if (!grid || !points?.length) return null;

  const rowF = clamp((lat - grid.south) / (grid.north - grid.south) * (grid.rows - 1), 0, grid.rows - 1);
  const colF = clamp((lon - grid.west) / (grid.east - grid.west) * (grid.cols - 1), 0, grid.cols - 1);
  const r0 = Math.floor(rowF);
  const c0 = Math.floor(colF);
  const r1 = Math.min(grid.rows - 1, r0 + 1);
  const c1 = Math.min(grid.cols - 1, c0 + 1);
  const rt = rowF - r0;
  const ct = colF - c0;

  const t0 = clamp(Math.floor(timePosition), 0, dataset.times.length - 1);
  const t1 = Math.min(dataset.times.length - 1, t0 + 1);
  const tt = clamp(timePosition - t0, 0, 1);

  const samplePointTime = (idx) => {
    const series = points[idx]?.series?.[key];
    if (!Array.isArray(series)) return null;
    return lerp(Number(series[t0]), Number(series[t1]), tt);
  };

  const a = samplePointTime(pointIndex(grid, r0, c0));
  const b = samplePointTime(pointIndex(grid, r0, c1));
  const c = samplePointTime(pointIndex(grid, r1, c0));
  const d = samplePointTime(pointIndex(grid, r1, c1));

  const top = lerp(a, b, ct);
  const bottom = lerp(c, d, ct);
  return lerp(top, bottom, rt);
}

function resolvedCloudLayers(dataset, lat, lon, timePosition) {
  const total = spatialSample(dataset, lat, lon, 'total', timePosition);
  let low = spatialSample(dataset, lat, lon, 'low', timePosition);
  let mid = spatialSample(dataset, lat, lon, 'mid', timePosition);
  let high = spatialSample(dataset, lat, lon, 'high', timePosition);

  const missing = [low, mid, high].filter((x) => !Number.isFinite(x)).length;
  if (missing === 3 && Number.isFinite(total)) {
    const humidity = spatialSample(dataset, lat, lon, 'humidity', timePosition) ?? 70;
    low = total * clamp(0.34 + (humidity - 55) / 180, .30, .62);
    mid = total * .46;
    high = total * .32;
  }

  return {
    total: Number.isFinite(total) ? clamp(total, 0, 100) : 0,
    low: Number.isFinite(low) ? clamp(low, 0, 100) : 0,
    mid: Number.isFinite(mid) ? clamp(mid, 0, 100) : 0,
    high: Number.isFinite(high) ? clamp(high, 0, 100) : 0,
  };
}

function selectedTimeMs(dataset, position) {
  if (!dataset?.times?.length) return NaN;
  const i0 = clamp(Math.floor(position), 0, dataset.times.length - 1);
  const i1 = Math.min(dataset.times.length - 1, i0 + 1);
  const t = clamp(position - i0, 0, 1);
  return lerp(utcMs(dataset.times[i0]), utcMs(dataset.times[i1]), t);
}

function nearestNowPosition(dataset) {
  const now = Date.now();
  let best = 0;
  let distance = Infinity;
  dataset.times.forEach((time, index) => {
    const d = Math.abs(utcMs(time) - now);
    if (d < distance) { distance = d; best = index; }
  });
  return best;
}

function createPuffDefinitions(layerName, count, grid) {
  const random = rng(
    layerName === 'low' ? 90210 :
    layerName === 'mid' ? 41177 : 78331
  );
  const defs = [];
  for (let i = 0; i < count; i += 1) {
    // Slightly oversized region so cloud decks visually continue beyond Norway.
    const lat = grid.south + random() * (grid.north - grid.south);
    const lon = grid.west + random() * (grid.east - grid.west);
    defs.push({
      lat,
      lon,
      heightJitter: random(),
      sizeJitter: .65 + random() * .78,
      alphaJitter: .80 + random() * .38,
      rotation: (random() - .5) * .55,
      textureIndex: Math.floor(random() * 6),
    });
  }
  return defs;
}

export function initWeather3D({ viewer } = {}) {
  if (!viewer?.scene) throw new Error('Weather 3D requires a Cesium Viewer');

  let open = false;
  let destroyed = false;
  let dataset = null;
  let loading = null;
  let timePosition = 0;
  let quality = 'MED';
  let playing = false;
  let playTimer = null;
  let autoRefreshTimer = null;
  let location = { ...DEFAULT_LOCATION };
  let lastRender = 0;

  const collections = { low: null, mid: null, high: null };
  const puffDefs = { low: [], mid: [], high: [] };
  const textures = {
    low: Array.from({ length: 6 }, (_, i) => makeCloudTexture(100 + i, false)),
    mid: Array.from({ length: 6 }, (_, i) => makeCloudTexture(200 + i, false)),
    high: Array.from({ length: 6 }, (_, i) => makeCloudTexture(300 + i, true)),
  };

  const enabledLayers = { low: true, mid: true, high: true };

  const ui = createUi(
    () => setOpen(!open),
    (event) => {
      const action = event.target.closest?.('[data-w3-action]')?.dataset.w3Action;
      const layer = event.target.closest?.('[data-w3-layer]')?.dataset.w3Layer;
      const q = event.target.closest?.('[data-w3-quality]')?.dataset.w3Quality;

      if (action === 'close') setOpen(false);
      else if (action === 'now') goNow();
      else if (action === 'play') togglePlay();
      else if (action === 'location') useMapCenter();

      if (layer && layer in enabledLayers) {
        enabledLayers[layer] = !enabledLayers[layer];
        event.target.classList.toggle('active', enabledLayers[layer]);
        renderClouds(true);
      }

      if (q && QUALITY[q]) setQuality(q);
    },
    (event) => {
      timePosition = Number(event.target.value) || 0;
      updateNowButton();
      renderClouds();
    },
  );

  try {
    viewer.creditDisplay?.addStaticCredit?.(
      new Cesium.Credit(
        '<a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data: Open-Meteo.com</a>',
        false,
      ),
    );
  } catch {}

  function setOpen(value) {
    open = Boolean(value);
    ui.panel.hidden = !open;
    ui.button.classList.toggle('active', open);

    Object.values(collections).forEach((collection) => {
      if (collection) collection.show = open;
    });

    if (open) {
      if (!dataset) void refresh();
      else renderClouds(true);
      autoRefreshTimer ||= setInterval(() => {
        if (open) void refresh({ preserveTime: true });
      }, 65 * 60_000);
    } else {
      stopPlay();
    }
    governorRequestRender('weather3d-toggle');
  }

  async function refresh({ preserveTime = false } = {}) {
    if (loading) return loading;
    ui.panel.classList.add('loading');
    const oldTime = dataset ? selectedTimeMs(dataset, timePosition) : Date.now();

    loading = (async () => {
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload?.times) || !Array.isArray(payload?.points)) {
          throw new Error('Malformed 3D weather response');
        }
        dataset = payload;

        const slider = ui.panel.querySelector('[data-w3-slider]');
        slider.max = String(Math.max(0, dataset.times.length - 1));

        if (preserveTime && Number.isFinite(oldTime)) {
          let best = nearestNowPosition(dataset);
          let bestDistance = Infinity;
          dataset.times.forEach((t, index) => {
            const d = Math.abs(utcMs(t) - oldTime);
            if (d < bestDistance) { bestDistance = d; best = index; }
          });
          timePosition = best;
        } else {
          timePosition = nearestNowPosition(dataset);
        }
        slider.value = String(timePosition);

        buildCollections();
        renderDayLabels();
        renderClouds(true);

        const status = ui.panel.querySelector('[data-w3-status]');
        status.textContent = `NORWAY · ${payload.source || 'OPEN-METEO'} · ${String(payload.status || 'READY').toUpperCase()}`;
      } catch (error) {
        console.warn('[Weather3D] load failed:', error);
        ui.panel.querySelector('[data-w3-status]').textContent = `UNAVAILABLE · ${error.message}`;
      } finally {
        loading = null;
        ui.panel.classList.remove('loading');
      }
    })();
    return loading;
  }

  function destroyCollections() {
    for (const key of Object.keys(collections)) {
      const collection = collections[key];
      if (collection) {
        try { viewer.scene.primitives.remove(collection); } catch {}
        collections[key] = null;
      }
    }
  }

  function buildCollections() {
    if (!dataset?.grid) return;
    destroyCollections();

    const counts = QUALITY[quality];
    for (const layerName of Object.keys(LAYERS)) {
      const config = LAYERS[layerName];
      puffDefs[layerName] = createPuffDefinitions(layerName, counts[layerName], dataset.grid);
      const collection = new Cesium.BillboardCollection({ scene: viewer.scene });
      collection.show = open;
      collections[layerName] = viewer.scene.primitives.add(collection);

      for (const def of puffDefs[layerName]) {
        const height = config.baseHeight + (def.heightJitter - .5) * config.spread;
        collection.add({
          position: Cesium.Cartesian3.fromDegrees(def.lon, def.lat, Math.max(250, height)),
          image: textures[layerName][def.textureIndex],
          show: false,
          scale: config.size * def.sizeJitter,
          rotation: def.rotation,
          color: Cesium.Color.WHITE.withAlpha(0),
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          scaleByDistance: new Cesium.NearFarScalar(
            5_000,
            1.8,
            4_500_000,
            0.28,
          ),
          translucencyByDistance: new Cesium.NearFarScalar(
            5_000,
            1.0,
            5_000_000,
            0.55,
          ),
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 5_500_000),
        });
      }
    }
  }

  function setQuality(next) {
    if (!QUALITY[next] || quality === next) return;
    quality = next;
    ui.panel.querySelectorAll('[data-w3-quality]').forEach((button) => {
      button.classList.toggle('active', button.dataset.w3Quality === quality);
    });
    buildCollections();
    renderClouds(true);
  }

  function renderClouds(force = false) {
    if (!dataset || !open) return;
    const now = performance.now();
    if (!force && now - lastRender < 42) return;
    lastRender = now;

    const layerKeys = Object.keys(LAYERS);
    for (const layerName of layerKeys) {
      const collection = collections[layerName];
      const defs = puffDefs[layerName];
      if (!collection) continue;

      const enabled = enabledLayers[layerName];
      collection.show = open && enabled;
      if (!enabled) continue;

      const config = LAYERS[layerName];
      for (let i = 0; i < collection.length; i += 1) {
        const billboard = collection.get(i);
        const def = defs[i];
        const clouds = resolvedCloudLayers(dataset, def.lat, def.lon, timePosition);
        const cover = clouds[layerName];

        const threshold = layerName === 'high' ? 12 : 9;
        if (cover < threshold) {
          billboard.show = false;
          continue;
        }

        const normalized = clamp((cover - threshold) / (100 - threshold), 0, 1);
        const opacity = clamp(
          Math.pow(normalized, 1.15) * config.alpha * def.alphaJitter,
          .025,
          .82,
        );

        // Precipitation subtly cools/darkens low cloud bases.
        const precip = layerName === 'low'
          ? (spatialSample(dataset, def.lat, def.lon, 'precip', timePosition) || 0)
          : 0;
        const rainFactor = clamp(precip / 3, 0, 1);
        const r = 1.0 - rainFactor * .16;
        const g = 1.0 - rainFactor * .10;
        const b = 1.0;

        billboard.show = true;
        billboard.scale = config.size * def.sizeJitter * (.55 + normalized * 1.05);
        billboard.color = new Cesium.Color(r, g, b, opacity);
      }
    }

    updateMetrics();
    governorRequestRender('weather3d-time');
  }

  function renderDayLabels() {
    const node = ui.panel.querySelector('[data-w3-days]');
    if (!dataset?.times?.length) {
      node.innerHTML = '';
      return;
    }
    const first = utcMs(dataset.times[0]);
    const last = utcMs(dataset.times.at(-1));
    const marks = 5;
    node.innerHTML = Array.from({ length: marks }, (_, i) => {
      const ms = lerp(first, last, i / (marks - 1));
      return `<span>${escapeHtml(formatDay(ms))}</span>`;
    }).join('');
  }

  function metric(key) {
    return spatialSample(dataset, location.lat, location.lon, key, timePosition);
  }

  function updateMetrics() {
    const clouds = resolvedCloudLayers(dataset, location.lat, location.lon, timePosition);
    const timeMs = selectedTimeMs(dataset, timePosition);

    ui.panel.querySelector('[data-w3-time]').textContent = formatForecastTime(timeMs);
    ui.panel.querySelector('[data-w3-location]').textContent =
      `${location.name.toUpperCase()} · ${location.lat.toFixed(2)}°, ${location.lon.toFixed(2)}°`;

    ui.panel.querySelector('[data-w3-total]').textContent = `${Math.round(clouds.total)}%`;
    ui.panel.querySelector('[data-w3-layers]').textContent =
      `${Math.round(clouds.low)} / ${Math.round(clouds.mid)} / ${Math.round(clouds.high)}%`;

    const temp = metric('temp');
    const humidity = metric('humidity');
    const precip = metric('precip');
    const wind = metric('wind');
    const windDir = metric('windDir');
    const visibility = metric('visibility');

    ui.panel.querySelector('[data-w3-temp]').textContent =
      Number.isFinite(temp) ? `${temp.toFixed(1)} °C` : '—';
    ui.panel.querySelector('[data-w3-humidity]').textContent =
      Number.isFinite(humidity) ? `${Math.round(humidity)}%` : '—';
    ui.panel.querySelector('[data-w3-precip]').textContent =
      Number.isFinite(precip) ? `${precip.toFixed(1)} mm/h` : '—';
    ui.panel.querySelector('[data-w3-wind]').textContent =
      Number.isFinite(wind)
        ? `${wind.toFixed(1)} m/s${Number.isFinite(windDir) ? ` · ${Math.round(windDir)}°` : ''}`
        : '—';
    ui.panel.querySelector('[data-w3-visibility]').textContent =
      Number.isFinite(visibility) ? `${Math.round(visibility / 1000)} km` : '—';

    const slider = ui.panel.querySelector('[data-w3-slider]');
    slider.value = String(timePosition);
  }

  function goNow() {
    if (!dataset) return;
    timePosition = nearestNowPosition(dataset);
    stopPlay();
    renderClouds(true);
    updateNowButton();
  }

  function updateNowButton() {
    const node = ui.panel.querySelector('[data-w3-action="now"]');
    if (!dataset || !node) return;
    node.classList.toggle('active', Math.abs(timePosition - nearestNowPosition(dataset)) < .51);
  }

  function togglePlay() {
    if (playing) stopPlay();
    else startPlay();
  }

  function startPlay() {
    if (!dataset || playing) return;
    playing = true;
    holdContinuousRender('weather3d-play');
    const button = ui.panel.querySelector('[data-w3-action="play"]');
    if (button) {
      button.textContent = '⏸ PAUSE';
      button.classList.add('active');
    }
    playTimer = setInterval(() => {
      const max = dataset.times.length - 1;
      timePosition += .25; // 15-minute visual interpolation steps.
      if (timePosition > max) timePosition = nearestNowPosition(dataset);
      renderClouds(true);
      updateNowButton();
    }, 320);
  }

  function stopPlay() {
    if (!playing) return;
    playing = false;
    if (playTimer) clearInterval(playTimer);
    playTimer = null;
    releaseContinuousRender('weather3d-play');
    const button = ui.panel.querySelector('[data-w3-action="play"]');
    if (button) {
      button.textContent = '▶ PLAY';
      button.classList.remove('active');
    }
  }

  function useMapCenter() {
    const next = cameraCentre(viewer);
    if (!next) return;
    if (!dataset?.grid) {
      location = next;
    } else {
      // Keep point readout inside the forecast field so interpolation remains valid.
      location = {
        ...next,
        lat: clamp(next.lat, dataset.grid.south, dataset.grid.north),
        lon: clamp(next.lon, dataset.grid.west, dataset.grid.east),
      };
    }
    updateMetrics();
  }

  function onKey(event) {
    if (event.key.toLowerCase() === 'w' && event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      setOpen(!open);
    }
  }
  window.addEventListener('keydown', onKey);

  return Object.freeze({
    open() { setOpen(true); },
    close() { setOpen(false); },
    toggle() { setOpen(!open); },
    refresh,
    goNow,
    setQuality,
    setLocation(lat, lon, name = 'Custom') {
      if (!Number.isFinite(Number(lat)) || !Number.isFinite(Number(lon))) return false;
      location = { lat: Number(lat), lon: Number(lon), name };
      updateMetrics();
      return true;
    },
    getState() {
      return Object.freeze({
        open,
        quality,
        playing,
        timePosition,
        location: { ...location },
        retrievedAt: dataset?.retrievedAt || null,
      });
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopPlay();
      if (autoRefreshTimer) clearInterval(autoRefreshTimer);
      window.removeEventListener('keydown', onKey);
      destroyCollections();
      ui.panel.remove();
      ui.button.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
  });
}

export default initWeather3D;
