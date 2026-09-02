import * as Cesium from 'cesium';

const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
const FORECAST_HOURS = 49;
const REFRESH_MS = 15 * 60_000;
const REQUEST_BATCH_SIZE = 45;
const CELL_OVERLAP_DEG = 0.012;

export const ASTRO_WEATHER_LOCATIONS = Object.freeze({
  ringshaug: Object.freeze({
    id: 'ringshaug',
    name: 'RINGSHAUG',
    latitude: 59.28064,
    longitude: 10.49167,
  }),
  observatory: Object.freeze({
    id: 'observatory',
    name: 'OBSERVATORIET',
    latitude: 59.29139502027921,
    longitude: 9.995156084450006,
  }),
});

// National planning grid. The mainland corridor follows Norway's shape with
// latitude-dependent west/east limits so we do not paint one huge rectangle
// across Sweden, Finland and the North Atlantic. Grid cells are intentionally
// coarse (roughly 50–85 km) because this is a trip-planning overview, not a
// claim of local meteorological resolution. Svalbard and Jan Mayen are also
// included so the layer is genuinely Norway-wide.
const NORWAY_MAINLAND_RANGE = Object.freeze([
  Object.freeze({ lat: 58.0, west: 5.0, east: 8.8 }),
  Object.freeze({ lat: 58.75, west: 4.8, east: 11.4 }),
  Object.freeze({ lat: 60.0, west: 4.5, east: 12.2 }),
  Object.freeze({ lat: 61.5, west: 4.3, east: 13.0 }),
  Object.freeze({ lat: 63.0, west: 4.8, east: 14.8 }),
  Object.freeze({ lat: 64.5, west: 6.0, east: 16.4 }),
  Object.freeze({ lat: 66.0, west: 8.3, east: 18.0 }),
  Object.freeze({ lat: 67.5, west: 10.5, east: 20.4 }),
  Object.freeze({ lat: 69.0, west: 13.2, east: 24.2 }),
  Object.freeze({ lat: 70.5, west: 18.0, east: 31.2 }),
  Object.freeze({ lat: 71.5, west: 24.0, east: 31.4 }),
]);

const SVALBARD_RANGE = Object.freeze([
  Object.freeze({ lat: 76.0, west: 13.0, east: 23.0 }),
  Object.freeze({ lat: 77.0, west: 10.0, east: 28.0 }),
  Object.freeze({ lat: 78.0, west: 10.0, east: 30.0 }),
  Object.freeze({ lat: 79.0, west: 10.0, east: 32.0 }),
  Object.freeze({ lat: 80.0, west: 15.0, east: 31.0 }),
  Object.freeze({ lat: 81.2, west: 18.0, east: 28.0 }),
]);

const MAINLAND_LAT_STEP = 0.75;
const MAINLAND_MAX_LON_STEP = 1.2;
const SVALBARD_LAT_STEP = 1.0;
const SVALBARD_MAX_LON_STEP = 2.5;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function finite(value, fallback = null) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

/**
 * A planning score for long-exposure astrophotography, 0..100.
 * Cloud cover dominates. Precipitation, near-saturation/dew risk and wind
 * reduce the score further. This is intentionally described as an astro
 * planning score rather than a meteorological "seeing" measurement.
 */
export function astroWeatherScore(sample = {}) {
  const cloud = clamp(finite(sample.cloudCoverPct, 100), 0, 100);
  const precipitation = Math.max(0, finite(sample.precipitationMm, 0));
  const humidity = clamp(finite(sample.humidityPct, 100), 0, 100);
  const wind = Math.max(0, finite(sample.windMs, 0));
  const temperature = finite(sample.temperatureC);
  const dewPoint = finite(sample.dewPointC);

  let score = 100;
  score -= cloud * 0.58;
  score -= Math.min(28, precipitation * 32);
  score -= Math.max(0, humidity - 78) * 0.48;
  score -= Math.max(0, wind - 4) * 1.65;

  if (temperature !== null && dewPoint !== null) {
    const dewSpread = temperature - dewPoint;
    if (dewSpread < 1) score -= 14;
    else if (dewSpread < 2) score -= 9;
    else if (dewSpread < 3) score -= 4;
  }

  if (precipitation >= 0.2) score = Math.min(score, 30);
  if (cloud >= 92) score = Math.min(score, 18);
  return Math.round(clamp(score, 0, 100));
}

export function astroWeatherCategory(score) {
  if (score >= 82) return { label: 'SVÆRT BRA', color: '#35d07f' };
  if (score >= 67) return { label: 'BRA', color: '#9bdc4d' };
  if (score >= 48) return { label: 'MIDDELS', color: '#e9c84a' };
  if (score >= 28) return { label: 'DÅRLIG', color: '#ef8c3a' };
  return { label: 'SVÆRT DÅRLIG', color: '#e05252' };
}

function weatherSample(forecast, hourIndex) {
  const hourly = forecast?.hourly || {};
  const pick = (name) => finite(hourly?.[name]?.[hourIndex]);
  const sample = {
    time: hourly?.time?.[hourIndex] || null,
    cloudCoverPct: pick('cloud_cover'),
    precipitationMm: pick('precipitation'),
    humidityPct: pick('relative_humidity_2m'),
    dewPointC: pick('dew_point_2m'),
    temperatureC: pick('temperature_2m'),
    windMs: pick('wind_speed_10m'),
    weatherCode: pick('weather_code'),
  };
  sample.score = astroWeatherScore(sample);
  sample.category = astroWeatherCategory(sample.score);
  return sample;
}

function interpolateRange(latitude, support) {
  if (latitude <= support[0].lat) return { west: support[0].west, east: support[0].east };
  for (let i = 0; i < support.length - 1; i++) {
    const current = support[i];
    const next = support[i + 1];
    if (latitude <= next.lat) {
      const span = next.lat - current.lat || 1;
      const t = (latitude - current.lat) / span;
      return {
        west: current.west + (next.west - current.west) * t,
        east: current.east + (next.east - current.east) * t,
      };
    }
  }
  const last = support[support.length - 1];
  return { west: last.west, east: last.east };
}

function makeBandGrid({ idPrefix, south, north, latStep, maxLonStep, support, region }) {
  const cells = [];
  let row = 0;
  for (let rowSouth = south; rowSouth < north - 1e-6; rowSouth += latStep, row++) {
    const rowNorth = Math.min(north, rowSouth + latStep);
    const latitude = (rowSouth + rowNorth) / 2;
    const range = interpolateRange(latitude, support);
    const width = Math.max(0.1, range.east - range.west);
    const columns = Math.max(1, Math.ceil(width / maxLonStep));
    const lonStep = width / columns;

    for (let col = 0; col < columns; col++) {
      const west = range.west + col * lonStep;
      const east = col === columns - 1 ? range.east : west + lonStep;
      cells.push({
        id: `${idPrefix}-${row}-${col}`,
        region,
        row,
        col,
        south: rowSouth,
        north: rowNorth,
        west,
        east,
        latitude,
        longitude: (west + east) / 2,
      });
    }
  }
  return cells;
}

function makeGrid() {
  const mainland = makeBandGrid({
    idPrefix: 'norway-mainland',
    region: 'Fastlands-Norge',
    south: 58.0,
    north: 71.5,
    latStep: MAINLAND_LAT_STEP,
    maxLonStep: MAINLAND_MAX_LON_STEP,
    support: NORWAY_MAINLAND_RANGE,
  });

  const svalbard = makeBandGrid({
    idPrefix: 'norway-svalbard',
    region: 'Svalbard',
    south: 76.0,
    north: 81.2,
    latStep: SVALBARD_LAT_STEP,
    maxLonStep: SVALBARD_MAX_LON_STEP,
    support: SVALBARD_RANGE,
  });

  // Jan Mayen is small enough that one planning cell is more honest than a
  // dense grid whose apparent precision would exceed the forecast purpose.
  const janMayen = [{
    id: 'norway-jan-mayen-0-0',
    region: 'Jan Mayen',
    row: 0,
    col: 0,
    south: 70.65,
    north: 71.25,
    west: -9.4,
    east: -7.6,
    latitude: 70.95,
    longitude: -8.5,
  }];

  return [...mainland, ...svalbard, ...janMayen];
}

function formatTime(value) {
  if (!value) return 'UKJENT TID';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return String(value);
  return `${match[3]}.${match[2]} ${match[4]}:${match[5]}`;
}

function formatNumber(value, suffix, digits = 0) {
  if (!Number.isFinite(Number(value))) return '—';
  return `${Number(value).toFixed(digits)}${suffix}`;
}

function forecastBestWindow(forecast, startIndex = 0, hours = 12) {
  const end = Math.min(FORECAST_HOURS, startIndex + hours);
  let bestStart = startIndex;
  let bestAverage = -1;
  const windowSize = 3;
  for (let i = startIndex; i < Math.max(startIndex + 1, end - windowSize + 1); i++) {
    let total = 0;
    let count = 0;
    for (let j = i; j < Math.min(i + windowSize, end); j++) {
      total += weatherSample(forecast, j).score;
      count += 1;
    }
    const average = count ? total / count : -1;
    if (average > bestAverage) {
      bestAverage = average;
      bestStart = i;
    }
  }
  const first = weatherSample(forecast, bestStart);
  const last = weatherSample(forecast, Math.min(bestStart + windowSize - 1, FORECAST_HOURS - 1));
  return {
    label: `${formatTime(first.time)}–${formatTime(last.time).slice(-5)}`,
    score: Math.round(Math.max(0, bestAverage)),
  };
}

function createPanel() {
  const existing = document.getElementById('astro-weather-panel');
  if (existing) return existing;
  const panel = document.createElement('section');
  panel.id = 'astro-weather-panel';
  panel.className = 'astro-weather-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="astro-weather-head">
      <div>
        <div class="astro-weather-kicker">ASTRO WEATHER · NORGE</div>
        <div class="astro-weather-time" data-astro-time>48-TIMERS PLANLEGGING</div>
      </div>
      <div class="astro-weather-hour" data-astro-hour>+0 T</div>
    </div>
    <div class="astro-weather-locations">
      <button type="button" class="astro-weather-card" data-astro-focus="ringshaug">
        <span class="astro-weather-place">RINGSHAUG</span>
        <strong data-astro-score="ringshaug">—</strong>
        <span data-astro-summary="ringshaug">Henter vær …</span>
        <small data-astro-best="ringshaug"></small>
      </button>
      <button type="button" class="astro-weather-card" data-astro-focus="observatory">
        <span class="astro-weather-place">OBSERVATORIET</span>
        <strong data-astro-score="observatory">—</strong>
        <span data-astro-summary="observatory">Henter vær …</span>
        <small data-astro-best="observatory"></small>
      </button>
    </div>
    <div class="astro-weather-selected" data-astro-selected hidden></div>
    <div class="astro-weather-timeline">
      <label for="astro-weather-range">PROGNOSE</label>
      <input id="astro-weather-range" type="range" min="0" max="48" step="1" value="0" aria-label="Astrovær 0 til 48 timer frem i tid">
      <div class="astro-weather-ticks" aria-hidden="true"><span>NÅ</span><span>+12</span><span>+24</span><span>+36</span><span>+48 T</span></div>
    </div>
    <div class="astro-weather-legend" aria-label="Astroforhold fargeskala">
      <span><i class="excellent"></i>Svært bra</span>
      <span><i class="good"></i>Bra</span>
      <span><i class="fair"></i>Middels</span>
      <span><i class="poor"></i>Dårlig</span>
      <span><i class="bad"></i>Svært dårlig</span>
    </div>
    <div class="astro-weather-note">Norge-dekkende planleggingsrutenett · farge = astro-score · transparens = værbegrensning · terreng/3D-fliser. Klikk et værfelt for lokal detalj.</div>
    <a class="astro-weather-credit" href="https://open-meteo.com/en/licence" target="_blank" rel="noopener">Weather data by Open-Meteo.com · CC BY 4.0</a>
  `;
  document.body.appendChild(panel);
  return panel;
}

function buildRequest(points) {
  const params = new URLSearchParams({
    latitude: points.map((point) => point.latitude.toFixed(5)).join(','),
    longitude: points.map((point) => point.longitude.toFixed(5)).join(','),
    hourly: [
      'temperature_2m',
      'relative_humidity_2m',
      'dew_point_2m',
      'precipitation',
      'cloud_cover',
      'wind_speed_10m',
      'weather_code',
    ].join(','),
    forecast_hours: String(FORECAST_HOURS),
    timezone: 'Europe/Oslo',
    wind_speed_unit: 'ms',
  });
  return `${OPEN_METEO_URL}?${params}`;
}

export function createAstroWeatherLayer() {
  const grid = makeGrid();
  const points = [ASTRO_WEATHER_LOCATIONS.ringshaug, ASTRO_WEATHER_LOCATIONS.observatory, ...grid];
  let viewerRef = null;
  let dataSource = null;
  let panel = null;
  let forecasts = [];
  let gridEntities = [];
  let enabled = false;
  let hourIndex = 0;
  let selectedGridIndex = null;
  let clickHandler = null;
  let lastUpdate = null;
  let lastError = null;
  let abortController = null;

  function showPanel(show) {
    if (panel) panel.hidden = !show;
  }

  function flyTo(point) {
    if (!viewerRef || !point) return;
    viewerRef.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 65000),
      duration: 1.4,
    });
  }

  function addLocationMarker(point, color) {
    dataSource.entities.add({
      id: `astro-weather-location:${point.id}`,
      position: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 40),
      point: {
        pixelSize: 13,
        color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.9),
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
      label: {
        text: point.name,
        font: '600 13px system-ui, sans-serif',
        fillColor: Cesium.Color.WHITE,
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 3,
        style: Cesium.LabelStyle.FILL_AND_OUTLINE,
        pixelOffset: new Cesium.Cartesian2(0, -22),
        distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 450000),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  function colorForSample(sample) {
    const base = Cesium.Color.fromCssColorString(sample.category.color) || Cesium.Color.WHITE;
    const cloud = clamp(finite(sample.cloudCoverPct, 100), 0, 100);
    const limitation = 1 - sample.score / 100;
    const alpha = clamp(0.09 + cloud * 0.0017 + limitation * 0.23, 0.10, 0.48);
    return base.withAlpha(alpha);
  }

  function rebuildEntities() {
    if (!dataSource || forecasts.length !== points.length) return;
    dataSource.entities.removeAll();
    gridEntities = [];
    addLocationMarker(ASTRO_WEATHER_LOCATIONS.ringshaug, Cesium.Color.WHITE);
    addLocationMarker(ASTRO_WEATHER_LOCATIONS.observatory, Cesium.Color.CYAN);

    grid.forEach((cell, index) => {
      const forecast = forecasts[index + 2];
      const sample = weatherSample(forecast, hourIndex);
      const entity = dataSource.entities.add({
        id: `astro-weather-grid:${cell.id}`,
        show: false,
        rectangle: {
          // Keep the overlay as ground geometry so Cesium classifies both the
          // terrain and Google Photorealistic 3D Tiles. A fixed ellipsoid
          // height is easily buried by Norwegian terrain and creates the
          // apparent gaps seen at national zoom levels.
          coordinates: Cesium.Rectangle.fromDegrees(
            cell.west - CELL_OVERLAP_DEG,
            cell.south - CELL_OVERLAP_DEG,
            cell.east + CELL_OVERLAP_DEG,
            cell.north + CELL_OVERLAP_DEG,
          ),
          material: new Cesium.ColorMaterialProperty(colorForSample(sample)),
          classificationType: Cesium.ClassificationType.BOTH,
          zIndex: 6,
        },
        properties: {
          astroWeatherIndex: index,
        },
      });
      gridEntities.push(entity);
    });
  }

  function updateGridMaterials() {
    if (!gridEntities.length || forecasts.length !== points.length) return;
    gridEntities.forEach((entity, index) => {
      const sample = weatherSample(forecasts[index + 2], hourIndex);
      entity.rectangle.material = new Cesium.ColorMaterialProperty(colorForSample(sample));
    });
  }

  function describeSample(sample) {
    return `${sample.category.label} · skyer ${formatNumber(sample.cloudCoverPct, '%')} · vind ${formatNumber(sample.windMs, ' m/s', 1)} · fukt ${formatNumber(sample.humidityPct, '%')}`;
  }

  function updateCard(locationId, forecast) {
    if (!panel || !forecast) return;
    const sample = weatherSample(forecast, hourIndex);
    const score = panel.querySelector(`[data-astro-score="${locationId}"]`);
    const summary = panel.querySelector(`[data-astro-summary="${locationId}"]`);
    const best = panel.querySelector(`[data-astro-best="${locationId}"]`);
    if (score) {
      score.textContent = `${sample.score}/100`;
      score.style.color = sample.category.color;
    }
    if (summary) summary.textContent = describeSample(sample);
    if (best) {
      const window = forecastBestWindow(forecast, hourIndex, Math.min(12, FORECAST_HOURS - hourIndex));
      best.textContent = `Beste 3 t: ${window.label} · ${window.score}/100`;
    }
  }

  function updateSelected() {
    if (!panel) return;
    const selected = panel.querySelector('[data-astro-selected]');
    if (!selected) return;
    if (selectedGridIndex === null || !grid[selectedGridIndex] || !forecasts[selectedGridIndex + 2]) {
      selected.hidden = true;
      selected.textContent = '';
      return;
    }
    const cell = grid[selectedGridIndex];
    const sample = weatherSample(forecasts[selectedGridIndex + 2], hourIndex);
    selected.hidden = false;
    selected.innerHTML = `<strong>${cell.region.toUpperCase()} · ${cell.latitude.toFixed(3)}, ${cell.longitude.toFixed(3)}</strong><span>${describeSample(sample)} · nedbør ${formatNumber(sample.precipitationMm, ' mm', 1)}</span>`;
  }

  function updatePanel() {
    if (!panel || forecasts.length !== points.length) return;
    const reference = weatherSample(forecasts[0], hourIndex);
    const time = panel.querySelector('[data-astro-time]');
    const hour = panel.querySelector('[data-astro-hour]');
    if (time) time.textContent = formatTime(reference.time);
    if (hour) hour.textContent = `+${hourIndex} T`;
    updateCard('ringshaug', forecasts[0]);
    updateCard('observatory', forecasts[1]);
    updateSelected();
  }

  function setHour(index) {
    hourIndex = clamp(Math.round(finite(index, 0)), 0, FORECAST_HOURS - 1);
    updateGridMaterials();
    updatePanel();
    viewerRef?.scene?.requestRender?.();
  }

  async function fetchForecasts(signal) {
    const forecasts = [];
    for (let offset = 0; offset < points.length; offset += REQUEST_BATCH_SIZE) {
      const batch = points.slice(offset, offset + REQUEST_BATCH_SIZE);
      const response = await fetch(buildRequest(batch), { signal });
      if (!response.ok) throw new Error(`Open-Meteo HTTP ${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [payload];
      if (rows.length !== batch.length) {
        throw new Error(`Open-Meteo returned ${rows.length}/${batch.length} forecast locations in batch`);
      }
      for (const row of rows) {
        if (!Array.isArray(row?.hourly?.time) || row.hourly.time.length < FORECAST_HOURS) {
          throw new Error('Open-Meteo forecast did not include the full 48-hour timeline');
        }
      }
      forecasts.push(...rows);
    }
    if (forecasts.length !== points.length) {
      throw new Error(`Open-Meteo returned ${forecasts.length}/${points.length} total forecast locations`);
    }
    return forecasts;
  }

  return {
    id: 'astro-weather',
    name: 'Astro Weather · Norge',
    icon: '✦',
    source: 'Open-Meteo · Norge 48H',
    updateInterval: REFRESH_MS,

    init(viewer) {
      viewerRef = viewer;
      dataSource = new Cesium.CustomDataSource('astro-weather');
      dataSource.show = false;
      viewer.dataSources.add(dataSource);
      panel = createPanel();

      panel.querySelector('#astro-weather-range')?.addEventListener('input', (event) => {
        setHour(event.target.value);
      });
      panel.querySelectorAll('[data-astro-focus]').forEach((button) => {
        button.addEventListener('click', () => flyTo(ASTRO_WEATHER_LOCATIONS[button.dataset.astroFocus]));
      });

      clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
      clickHandler.setInputAction((movement) => {
        if (!enabled) return;
        const picked = viewer.scene.pick(movement.position);
        const index = picked?.id?.properties?.astroWeatherIndex?.getValue?.();
        if (!Number.isInteger(index)) return;
        selectedGridIndex = index;
        updateSelected();
      }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

      return true;
    },

    enable() {
      enabled = true;
      if (dataSource) dataSource.show = true;
      showPanel(true);
      return true;
    },

    disable() {
      enabled = false;
      abortController?.abort('astro-weather-disabled');
      abortController = null;
      if (dataSource) dataSource.show = false;
      showPanel(false);
      return true;
    },

    async update(viewer, { signal } = {}) {
      abortController?.abort('astro-weather-refresh');
      abortController = new AbortController();
      const combinedSignal = signal
        ? AbortSignal.any([signal, abortController.signal])
        : abortController.signal;
      try {
        const next = await fetchForecasts(combinedSignal);
        forecasts = next;
        rebuildEntities();
        updatePanel();
        dataSource.show = enabled;
        lastUpdate = Date.now();
        lastError = null;
        viewer.scene.requestRender();
        return true;
      } catch (error) {
        if (combinedSignal.aborted || error?.name === 'AbortError') throw error;
        lastError = String(error?.message || error || 'Weather request failed');
        console.warn('[Data:AstroWeather] Update failed:', error);
        return false;
      } finally {
        abortController = null;
      }
    },

    destroy(viewer) {
      enabled = false;
      abortController?.abort('astro-weather-destroy');
      abortController = null;
      clickHandler?.destroy();
      clickHandler = null;
      panel?.remove();
      panel = null;
      if (dataSource) viewer.dataSources.remove(dataSource, true);
      dataSource = null;
      forecasts = [];
      gridEntities = [];
      viewerRef = null;
      return true;
    },

    getStats() {
      return {
        count: grid.length,
        lastUpdate,
        error: lastError,
        source: 'Open-Meteo Norway 48h forecast',
      };
    },
  };
}

const astroWeatherLayer = createAstroWeatherLayer();
export default astroWeatherLayer;
