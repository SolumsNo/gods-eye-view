import * as Cesium from 'cesium';

/**
 * GOD'S EYE VIEW — Astro Mode
 *
 * Local, keyless astronomy layer:
 * - observer defaults to Tønsberg, Norway
 * - sky radar with altitude / azimuth
 * - Sun + Moon position and Moon illumination
 * - deep-sky target ranking
 * - approximate tracking window above 25°
 * - can use the current map centre as the observer location
 *
 * V2 adds keyless live/forecast astro-weather through Open-Meteo:
 * cloud layers, humidity, dew point, precipitation, visibility and wind.
 * The combined ASTRO SCORE blends weather with darkness, Moon and target geometry.
 */

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const DAY_MS = 86_400_000;

const DEFAULT_OBSERVER = Object.freeze({
  name: 'Tønsberg',
  lat: 59.2675,
  lon: 10.4076,
});

const MIN_TRACK_ALTITUDE = 25;

const DEEP_SKY_OBJECTS = Object.freeze([
  { id: 'M31', name: 'Andromeda Galaxy', type: 'galaxy', ra: 0.7123, dec: 41.269, mag: 3.4 },
  { id: 'M33', name: 'Triangulum Galaxy', type: 'galaxy', ra: 1.5641, dec: 30.660, mag: 5.7 },
  { id: 'M42', name: 'Orion Nebula', type: 'nebula', ra: 5.5881, dec: -5.391, mag: 4.0 },
  { id: 'M45', name: 'Pleiades', type: 'cluster', ra: 3.7913, dec: 24.117, mag: 1.6 },
  { id: 'M81', name: 'Bode’s Galaxy', type: 'galaxy', ra: 9.9259, dec: 69.065, mag: 6.9 },
  { id: 'M82', name: 'Cigar Galaxy', type: 'galaxy', ra: 9.9313, dec: 69.679, mag: 8.4 },
  { id: 'M51', name: 'Whirlpool Galaxy', type: 'galaxy', ra: 13.4979, dec: 47.195, mag: 8.4 },
  { id: 'M101', name: 'Pinwheel Galaxy', type: 'galaxy', ra: 14.0535, dec: 54.349, mag: 7.9 },
  { id: 'M13', name: 'Hercules Cluster', type: 'cluster', ra: 16.6949, dec: 36.461, mag: 5.8 },
  { id: 'M92', name: 'Messier 92', type: 'cluster', ra: 17.2854, dec: 43.136, mag: 6.4 },
  { id: 'M57', name: 'Ring Nebula', type: 'planetary', ra: 18.8931, dec: 33.029, mag: 8.8 },
  { id: 'M27', name: 'Dumbbell Nebula', type: 'planetary', ra: 19.9934, dec: 22.721, mag: 7.4 },
  { id: 'NGC6888', name: 'Crescent Nebula', type: 'nebula', ra: 20.2010, dec: 38.355, mag: 7.4 },
  { id: 'NGC7000', name: 'North America Nebula', type: 'nebula', ra: 20.9680, dec: 44.330, mag: 4.0 },
  { id: 'IC5070', name: 'Pelican Nebula', type: 'nebula', ra: 20.8440, dec: 44.350, mag: 8.0 },
  { id: 'NGC6960', name: 'Western Veil Nebula', type: 'nebula', ra: 20.7610, dec: 30.720, mag: 7.0 },
  { id: 'NGC6992', name: 'Eastern Veil Nebula', type: 'nebula', ra: 20.9380, dec: 31.742, mag: 7.0 },
  { id: 'NGC7635', name: 'Bubble Nebula', type: 'nebula', ra: 23.3447, dec: 61.202, mag: 10.0 },
  { id: 'IC1805', name: 'Heart Nebula', type: 'nebula', ra: 2.5667, dec: 61.450, mag: 6.5 },
  { id: 'IC1848', name: 'Soul Nebula', type: 'nebula', ra: 2.8500, dec: 60.400, mag: 6.5 },
  { id: 'NGC281', name: 'Pacman Nebula', type: 'nebula', ra: 0.8740, dec: 56.620, mag: 7.4 },
  { id: 'NGC1499', name: 'California Nebula', type: 'nebula', ra: 4.0500, dec: 36.370, mag: 5.0 },
  { id: 'IC434', name: 'Horsehead / IC 434', type: 'nebula', ra: 5.6830, dec: -2.450, mag: 7.3 },
  { id: 'M1', name: 'Crab Nebula', type: 'nebula', ra: 5.5756, dec: 22.014, mag: 8.4 },
  { id: 'M78', name: 'Messier 78', type: 'reflection', ra: 5.7794, dec: 0.080, mag: 8.3 },
]);

const TYPE_COLORS = Object.freeze({
  galaxy: '#69b7ff',
  nebula: '#f46cff',
  reflection: '#80d8ff',
  planetary: '#52f5cb',
  cluster: '#ffd66b',
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function julianDay(date) {
  return date.getTime() / DAY_MS + 2440587.5;
}

function gmstDegrees(date) {
  const jd = julianDay(date);
  const t = (jd - 2451545.0) / 36525;
  return normalizeDegrees(
    280.46061837
      + 360.98564736629 * (jd - 2451545.0)
      + 0.000387933 * t * t
      - (t * t * t) / 38710000,
  );
}

function sunEquatorial(date) {
  const d = julianDay(date) - 2451545.0;
  const meanLongitude = normalizeDegrees(280.460 + 0.9856474 * d);
  const anomaly = normalizeDegrees(357.528 + 0.9856003 * d) * DEG;
  const eclipticLongitude = normalizeDegrees(
    meanLongitude + 1.915 * Math.sin(anomaly) + 0.020 * Math.sin(2 * anomaly),
  );
  const obliquity = (23.439 - 0.0000004 * d) * DEG;
  const lambda = eclipticLongitude * DEG;
  const ra = normalizeDegrees(Math.atan2(
    Math.cos(obliquity) * Math.sin(lambda),
    Math.cos(lambda),
  ) * RAD) / 15;
  const dec = Math.asin(Math.sin(obliquity) * Math.sin(lambda)) * RAD;
  return { ra, dec, eclipticLongitude };
}

function solveEccentricAnomaly(meanAnomalyRad, eccentricity) {
  let e = meanAnomalyRad + eccentricity * Math.sin(meanAnomalyRad) * (1 + eccentricity * Math.cos(meanAnomalyRad));
  for (let i = 0; i < 5; i += 1) {
    e -= (e - eccentricity * Math.sin(e) - meanAnomalyRad) / (1 - eccentricity * Math.cos(e));
  }
  return e;
}

function moonEquatorial(date) {
  // Low-precision geocentric Moon position — ample for a God’s Eye sky radar.
  const d = julianDay(date) - 2451543.5;
  const n = normalizeDegrees(125.1228 - 0.0529538083 * d) * DEG;
  const inclination = 5.1454 * DEG;
  const periapsis = normalizeDegrees(318.0634 + 0.1643573223 * d) * DEG;
  const a = 60.2666;
  const e = 0.054900;
  const meanAnomaly = normalizeDegrees(115.3654 + 13.0649929509 * d) * DEG;
  const eccentricAnomaly = solveEccentricAnomaly(meanAnomaly, e);

  const xv = a * (Math.cos(eccentricAnomaly) - e);
  const yv = a * Math.sqrt(1 - e * e) * Math.sin(eccentricAnomaly);
  const trueAnomaly = Math.atan2(yv, xv);
  const radius = Math.sqrt(xv * xv + yv * yv);
  const longitudeOrbital = trueAnomaly + periapsis;

  const xh = radius * (
    Math.cos(n) * Math.cos(longitudeOrbital)
      - Math.sin(n) * Math.sin(longitudeOrbital) * Math.cos(inclination)
  );
  const yh = radius * (
    Math.sin(n) * Math.cos(longitudeOrbital)
      + Math.cos(n) * Math.sin(longitudeOrbital) * Math.cos(inclination)
  );
  const zh = radius * Math.sin(longitudeOrbital) * Math.sin(inclination);

  const eclipticLongitude = normalizeDegrees(Math.atan2(yh, xh) * RAD);
  const eclipticLatitude = Math.atan2(zh, Math.sqrt(xh * xh + yh * yh));

  const obliquity = (23.4393 - 3.563e-7 * d) * DEG;
  const lon = eclipticLongitude * DEG;
  const x = Math.cos(lon) * Math.cos(eclipticLatitude);
  const y = Math.sin(lon) * Math.cos(eclipticLatitude);
  const z = Math.sin(eclipticLatitude);

  const xeq = x;
  const yeq = y * Math.cos(obliquity) - z * Math.sin(obliquity);
  const zeq = y * Math.sin(obliquity) + z * Math.cos(obliquity);

  const ra = normalizeDegrees(Math.atan2(yeq, xeq) * RAD) / 15;
  const dec = Math.atan2(zeq, Math.sqrt(xeq * xeq + yeq * yeq)) * RAD;
  return { ra, dec, eclipticLongitude };
}

function equatorialToHorizontal(raHours, decDeg, observer, date) {
  const lat = observer.lat * DEG;
  const dec = decDeg * DEG;
  const lst = normalizeDegrees(gmstDegrees(date) + observer.lon);
  const hourAngle = normalizeDegrees(lst - raHours * 15);
  const signedHourAngle = hourAngle > 180 ? hourAngle - 360 : hourAngle;
  const h = signedHourAngle * DEG;

  const sinAlt = (
    Math.sin(dec) * Math.sin(lat)
      + Math.cos(dec) * Math.cos(lat) * Math.cos(h)
  );
  const altitude = Math.asin(clamp(sinAlt, -1, 1));

  const az = Math.atan2(
    Math.sin(h),
    Math.cos(h) * Math.sin(lat) - Math.tan(dec) * Math.cos(lat),
  );

  return {
    alt: altitude * RAD,
    az: normalizeDegrees(az * RAD + 180),
  };
}

function angularSeparation(a, b) {
  const ra1 = a.ra * 15 * DEG;
  const dec1 = a.dec * DEG;
  const ra2 = b.ra * 15 * DEG;
  const dec2 = b.dec * DEG;
  const cosine = (
    Math.sin(dec1) * Math.sin(dec2)
      + Math.cos(dec1) * Math.cos(dec2) * Math.cos(ra1 - ra2)
  );
  return Math.acos(clamp(cosine, -1, 1)) * RAD;
}

function phaseInfo(sun, moon) {
  const phaseAngle = normalizeDegrees(moon.eclipticLongitude - sun.eclipticLongitude);
  const separation = angularSeparation(sun, moon);
  const illumination = (1 - Math.cos(separation * DEG)) / 2;
  const labels = [
    'New Moon',
    'Waxing crescent',
    'First quarter',
    'Waxing gibbous',
    'Full Moon',
    'Waning gibbous',
    'Last quarter',
    'Waning crescent',
  ];
  const index = Math.round(phaseAngle / 45) % 8;
  return {
    illumination: clamp(illumination, 0, 1),
    phaseAngle,
    label: labels[index],
  };
}

function darknessInfo(sunAltitude) {
  if (sunAltitude >= 0) return { label: 'DAYLIGHT', factor: 0.00, accent: '#ffc55c' };
  if (sunAltitude >= -6) return { label: 'CIVIL TWILIGHT', factor: 0.12, accent: '#ffab6b' };
  if (sunAltitude >= -12) return { label: 'NAUTICAL TWILIGHT', factor: 0.42, accent: '#9f9cff' };
  if (sunAltitude >= -18) return { label: 'ASTRONOMICAL TWILIGHT', factor: 0.72, accent: '#7d89ff' };
  return { label: 'ASTRONOMICAL DARK', factor: 1.00, accent: '#5ee6ff' };
}

function compassDirection(azimuth) {
  const names = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return names[Math.round(normalizeDegrees(azimuth) / 22.5) % 16];
}

function formatDegrees(value) {
  return `${Math.round(value)}°`;
}

function formatTime(date) {
  return new Intl.DateTimeFormat('nb-NO', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
  }).format(date);
}

function formatObserver(observer) {
  return `${observer.lat.toFixed(3)}°, ${observer.lon.toFixed(3)}°`;
}

function trackWindowHours(object, observer, startDate) {
  const start = equatorialToHorizontal(object.ra, object.dec, observer, startDate);
  if (start.alt < MIN_TRACK_ALTITUDE) return 0;
  const stepMinutes = 10;
  const maxHours = 8;
  let minutes = 0;
  for (let i = 1; i <= (maxHours * 60) / stepMinutes; i += 1) {
    const probe = new Date(startDate.getTime() + i * stepMinutes * 60_000);
    const pos = equatorialToHorizontal(object.ra, object.dec, observer, probe);
    if (pos.alt < MIN_TRACK_ALTITUDE) break;
    minutes = i * stepMinutes;
  }
  return minutes / 60;
}

function targetScore(object, horizontal, moonEq, moonPhase, darkness) {
  if (horizontal.alt <= 0) return -999;
  const altitudeFactor = clamp((horizontal.alt - 10) / 65, 0, 1);
  const moonSeparation = angularSeparation(object, moonEq);
  const moonProximity = clamp((75 - moonSeparation) / 75, 0, 1);
  const moonSensitivity = object.type === 'nebula' || object.type === 'planetary'
    ? 0.50
    : object.type === 'cluster' ? 0.72 : 1.00;
  const moonPenalty = moonPhase.illumination * moonProximity * moonSensitivity * 28;
  const brightnessBonus = clamp((10 - (object.mag ?? 10)) / 10, 0, 1) * 8;
  return altitudeFactor * 64 + darkness.factor * 30 + brightnessBonus - moonPenalty;
}

function skyGeometryScore(darkness, moonPhase, topTarget) {
  const targetTerm = topTarget ? clamp((topTarget.alt - 15) / 60, 0, 1) : 0;
  const moonTerm = 1 - moonPhase.illumination * 0.45;
  const raw = darkness.factor * 6.2 + moonTerm * 1.8 + targetTerm * 2.0;
  return clamp(Math.round(raw), 1, 10);
}



const WEATHER_REFRESH_MS = 15 * 60_000;
const WEATHER_FORECAST_DAYS = 3;

function buildWeatherUrl(observer) {
  const url = new URL('https://api.open-meteo.com/v1/forecast');
  url.searchParams.set('latitude', observer.lat.toFixed(5));
  url.searchParams.set('longitude', observer.lon.toFixed(5));
  url.searchParams.set('hourly', [
    'temperature_2m',
    'relative_humidity_2m',
    'dew_point_2m',
    'precipitation_probability',
    'precipitation',
    'cloud_cover',
    'cloud_cover_low',
    'cloud_cover_mid',
    'cloud_cover_high',
    'visibility',
    'wind_speed_10m',
    'wind_gusts_10m',
  ].join(','));
  url.searchParams.set('timezone', 'UTC');
  url.searchParams.set('forecast_days', String(WEATHER_FORECAST_DAYS));
  url.searchParams.set('wind_speed_unit', 'ms');
  return url.toString();
}

function numericAt(series, index, fallback = 0) {
  const value = Number(series?.[index]);
  return Number.isFinite(value) ? value : fallback;
}

async function fetchAstroWeather(observer, signal) {
  const response = await fetch(buildWeatherUrl(observer), {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error(`Weather HTTP ${response.status}`);
  const data = await response.json();
  const hourly = data?.hourly;
  if (!hourly?.time?.length) throw new Error('Weather response had no hourly data');

  const rows = hourly.time.map((iso, index) => ({
    time: new Date(`${iso}Z`),
    temperature: numericAt(hourly.temperature_2m, index),
    humidity: numericAt(hourly.relative_humidity_2m, index),
    dewPoint: numericAt(hourly.dew_point_2m, index),
    precipitationProbability: numericAt(hourly.precipitation_probability, index),
    precipitation: numericAt(hourly.precipitation, index),
    cloud: numericAt(hourly.cloud_cover, index),
    cloudLow: numericAt(hourly.cloud_cover_low, index),
    cloudMid: numericAt(hourly.cloud_cover_mid, index),
    cloudHigh: numericAt(hourly.cloud_cover_high, index),
    visibility: numericAt(hourly.visibility, index),
    wind: numericAt(hourly.wind_speed_10m, index),
    gust: numericAt(hourly.wind_gusts_10m, index),
  }));

  return {
    rows,
    latitude: Number(data.latitude),
    longitude: Number(data.longitude),
    elevation: Number(data.elevation),
    fetchedAt: Date.now(),
    source: 'Open-Meteo',
  };
}

function nearestWeatherRow(weather, date) {
  if (!weather?.rows?.length) return null;
  let best = null;
  let bestDelta = Infinity;
  for (const row of weather.rows) {
    const delta = Math.abs(row.time.getTime() - date.getTime());
    if (delta < bestDelta) {
      best = row;
      bestDelta = delta;
    }
  }
  return bestDelta <= 90 * 60_000 ? best : null;
}

function weatherQuality(row) {
  if (!row) return null;
  const effectiveCloud = Math.max(
    row.cloud,
    row.cloudLow * 0.95,
    row.cloudMid * 0.88,
    row.cloudHigh * 0.78,
  );
  const clear = 1 - clamp(effectiveCloud / 100, 0, 1);
  const humidity = 1 - clamp((row.humidity - 68) / 32, 0, 1);
  const dewSpread = row.temperature - row.dewPoint;
  const dew = clamp(dewSpread / 5, 0, 1);
  const precipitation = 1 - Math.max(
    clamp(row.precipitationProbability / 100, 0, 1),
    clamp(row.precipitation / 1.5, 0, 1),
  );
  const wind = 1 - clamp((Math.max(row.wind, row.gust * 0.55) - 2) / 10, 0, 1);
  const visibilityKm = row.visibility / 1000;
  const visibility = clamp((visibilityKm - 2) / 23, 0, 1);

  const quality = clamp(
    clear * 0.52
      + humidity * 0.13
      + dew * 0.08
      + precipitation * 0.12
      + wind * 0.08
      + visibility * 0.07,
    0,
    1,
  );

  const warnings = [];
  if (row.cloud >= 70) warnings.push('heavy cloud');
  else if (row.cloud >= 35) warnings.push('broken cloud');
  if (row.humidity >= 90 || dewSpread <= 1.5) warnings.push('dew risk');
  if (row.precipitationProbability >= 35 || row.precipitation > 0.1) warnings.push('precipitation');
  if (row.wind >= 8 || row.gust >= 12) warnings.push('wind');
  if (visibilityKm < 8) warnings.push('haze / fog');

  return {
    quality,
    score: clamp(Math.round(quality * 10), 1, 10),
    effectiveCloud,
    dewSpread,
    visibilityKm,
    warnings,
  };
}

function combinedAstroScore(geometryScore, darkness, weather) {
  if (!weather) return geometryScore;
  const geometry = clamp(geometryScore / 10, 0, 1);
  const darkGate = 0.45 + 0.55 * darkness.factor;
  let score = 10 * (weather.quality * darkGate * 0.72 + geometry * 0.28);
  if (darkness.factor < 0.15) score = Math.min(score, 3);
  return clamp(Math.round(score), 1, 10);
}

function astroScoreLabel(score) {
  if (score >= 9) return 'EXCELLENT';
  if (score >= 7) return 'GOOD';
  if (score >= 5) return 'FAIR';
  if (score >= 3) return 'POOR';
  return 'VERY POOR';
}

function weatherBar(label, value, className = '') {
  const safe = clamp(Number(value) || 0, 0, 100);
  return `
    <div class="astro-weather-bar-row ${className}">
      <span>${escapeHtml(label)}</span>
      <div class="astro-weather-bar"><i style="width:${safe.toFixed(0)}%"></i></div>
      <strong>${safe.toFixed(0)}%</strong>
    </div>`;
}

function weatherTimeline(weather, selectedDate) {
  if (!weather?.rows?.length) return '';
  const future = weather.rows
    .filter((row) => row.time.getTime() >= selectedDate.getTime() - 31 * 60_000)
    .slice(0, 7);
  if (!future.length) return '';
  return `<div class="astro-weather-timeline">${future.map((row) => {
    const q = weatherQuality(row);
    return `<div class="astro-weather-hour">
      <span>${String(row.time.getHours()).padStart(2, '0')}:00</span>
      <strong>${Math.round(row.cloud)}%</strong>
      <small>${q?.score ?? '–'}/10</small>
    </div>`;
  }).join('')}</div>`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
  }[char]));
}

function radarPoint(altitude, azimuth, radius = 136, cx = 160, cy = 160) {
  const radial = radius * (90 - clamp(altitude, 0, 90)) / 90;
  const a = azimuth * DEG;
  return {
    x: cx + radial * Math.sin(a),
    y: cy - radial * Math.cos(a),
  };
}

function objectColor(type) {
  return TYPE_COLORS[type] || '#ffffff';
}

function buildRadarSvg(targets, sunHorizontal, moonHorizontal) {
  const visibleTargets = targets
    .filter((entry) => entry.alt > 0)
    .slice(0, 12);

  const targetNodes = visibleTargets.map((entry) => {
    const p = radarPoint(entry.alt, entry.az);
    const color = objectColor(entry.object.type);
    return `
      <g class="astro-radar-target">
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.1"
          fill="${color}" stroke="rgba(255,255,255,.75)" stroke-width="0.7"/>
        <text x="${(p.x + 7).toFixed(1)}" y="${(p.y - 6).toFixed(1)}">${escapeHtml(entry.object.id)}</text>
      </g>`;
  }).join('');

  const sunNode = sunHorizontal.alt > -6 ? (() => {
    const p = radarPoint(Math.max(0, sunHorizontal.alt), sunHorizontal.az);
    return `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6.5"
      fill="#ffb44c" stroke="#fff4d8" stroke-width="1.2"/>`;
  })() : '';

  const moonNode = moonHorizontal.alt > 0 ? (() => {
    const p = radarPoint(moonHorizontal.alt, moonHorizontal.az);
    return `<g><circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="6.2"
      fill="#d9e5ff" stroke="#ffffff" stroke-width="1.1"/>
      <text class="astro-radar-moon-label" x="${(p.x + 8).toFixed(1)}" y="${(p.y + 4).toFixed(1)}">MOON</text></g>`;
  })() : '';

  return `
    <svg class="astro-radar" viewBox="0 0 320 320" role="img" aria-label="Sky radar">
      <circle class="astro-radar-horizon" cx="160" cy="160" r="136"/>
      <circle class="astro-radar-ring" cx="160" cy="160" r="90.7"/>
      <circle class="astro-radar-ring" cx="160" cy="160" r="45.3"/>
      <line class="astro-radar-cross" x1="24" y1="160" x2="296" y2="160"/>
      <line class="astro-radar-cross" x1="160" y1="24" x2="160" y2="296"/>
      <text class="astro-radar-dir" x="160" y="17" text-anchor="middle">N</text>
      <text class="astro-radar-dir" x="304" y="165" text-anchor="middle">E</text>
      <text class="astro-radar-dir" x="160" y="314" text-anchor="middle">S</text>
      <text class="astro-radar-dir" x="16" y="165" text-anchor="middle">W</text>
      <text class="astro-radar-alt" x="165" y="67">60°</text>
      <text class="astro-radar-alt" x="165" y="113">30°</text>
      ${targetNodes}
      ${sunNode}
      ${moonNode}
      <circle cx="160" cy="160" r="2.2" fill="#ffffff"/>
    </svg>`;
}

const ASTRO_STYLE_ID = 'gev-astro-mode-style';
const ASTRO_PANEL_ID = 'gev-astro-mode-panel';

function ensureStyles() {
  if (document.getElementById(ASTRO_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = ASTRO_STYLE_ID;
  style.textContent = `
    #${ASTRO_PANEL_ID} {
      position: fixed;
      top: 78px;
      right: 84px;
      z-index: 1450;
      width: min(410px, calc(100vw - 28px));
      max-height: calc(100vh - 118px);
      overflow: auto;
      color: #eaf7ff;
      background:
        radial-gradient(circle at 72% 10%, rgba(43,99,145,.22), transparent 38%),
        linear-gradient(180deg, rgba(7,15,27,.96), rgba(3,8,15,.94));
      border: 1px solid rgba(111,215,255,.34);
      box-shadow: 0 18px 55px rgba(0,0,0,.48), inset 0 0 28px rgba(83,198,255,.035);
      backdrop-filter: blur(14px);
      border-radius: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 12px;
      letter-spacing: .02em;
      user-select: none;
    }
    #${ASTRO_PANEL_ID}[hidden] { display: none !important; }
    #${ASTRO_PANEL_ID} .astro-head {
      display:flex; align-items:center; justify-content:space-between; gap:10px;
      padding:12px 13px 9px; border-bottom:1px solid rgba(128,210,255,.15);
      position:sticky; top:0; z-index:3; background:rgba(5,12,22,.92); backdrop-filter:blur(12px);
    }
    #${ASTRO_PANEL_ID} .astro-title { font-weight:800; font-size:13px; letter-spacing:.16em; color:#8ee9ff; }
    #${ASTRO_PANEL_ID} .astro-sub { color:rgba(222,243,255,.58); font-size:10px; margin-top:3px; }
    #${ASTRO_PANEL_ID} .astro-close {
      border:0; background:transparent; color:#9ec4d5; font:inherit; font-size:18px; cursor:pointer;
      width:28px; height:28px; border-radius:6px;
    }
    #${ASTRO_PANEL_ID} .astro-close:hover { background:rgba(255,255,255,.08); color:white; }
    #${ASTRO_PANEL_ID} .astro-body { padding:11px 12px 13px; }
    #${ASTRO_PANEL_ID} .astro-status-grid {
      display:grid; grid-template-columns:1fr 1fr; gap:7px; margin-bottom:10px;
    }
    #${ASTRO_PANEL_ID} .astro-stat {
      padding:8px 9px; border:1px solid rgba(140,216,255,.12);
      background:rgba(255,255,255,.025); border-radius:8px;
    }
    #${ASTRO_PANEL_ID} .astro-stat-label { color:rgba(207,235,248,.5); font-size:9px; letter-spacing:.1em; }
    #${ASTRO_PANEL_ID} .astro-stat-value { margin-top:3px; font-weight:700; font-size:12px; color:#f2fbff; }
    #${ASTRO_PANEL_ID} .astro-score { font-size:18px; line-height:1; color:#6fe6ff; }
    #${ASTRO_PANEL_ID} .astro-radar-wrap {
      border:1px solid rgba(140,216,255,.13); background:rgba(1,5,10,.42);
      border-radius:10px; padding:5px; margin-bottom:10px;
    }
    #${ASTRO_PANEL_ID} .astro-radar { display:block; width:100%; max-height:310px; }
    #${ASTRO_PANEL_ID} .astro-radar-horizon { fill:rgba(25,62,88,.12); stroke:rgba(136,225,255,.48); stroke-width:1.2; }
    #${ASTRO_PANEL_ID} .astro-radar-ring { fill:none; stroke:rgba(131,205,233,.13); stroke-width:1; }
    #${ASTRO_PANEL_ID} .astro-radar-cross { stroke:rgba(131,205,233,.10); stroke-width:1; }
    #${ASTRO_PANEL_ID} .astro-radar-dir { fill:#86dcfa; font-size:12px; font-weight:800; }
    #${ASTRO_PANEL_ID} .astro-radar-alt { fill:rgba(185,224,239,.28); font-size:8px; }
    #${ASTRO_PANEL_ID} .astro-radar-target text,
    #${ASTRO_PANEL_ID} .astro-radar-moon-label {
      fill:#dff8ff; font-size:7.5px; paint-order:stroke; stroke:#03101a; stroke-width:2.5px; stroke-linejoin:round;
    }
    #${ASTRO_PANEL_ID} .astro-controls { display:flex; flex-wrap:wrap; gap:6px; margin:8px 0 11px; }
    #${ASTRO_PANEL_ID} .astro-btn {
      border:1px solid rgba(118,213,249,.22); color:#bdefff; background:rgba(74,164,204,.08);
      border-radius:6px; padding:6px 8px; font:inherit; font-size:10px; cursor:pointer;
    }
    #${ASTRO_PANEL_ID} .astro-btn:hover { background:rgba(74,164,204,.18); border-color:rgba(118,213,249,.44); }
    #${ASTRO_PANEL_ID} .astro-section-title {
      color:#79ddff; font-size:10px; font-weight:800; letter-spacing:.13em;
      margin:10px 0 5px; display:flex; justify-content:space-between; gap:10px;
    }
    #${ASTRO_PANEL_ID} .astro-target {
      display:grid; grid-template-columns:63px 1fr auto; gap:8px; align-items:center;
      padding:7px 2px; border-top:1px solid rgba(135,216,250,.08);
    }
    #${ASTRO_PANEL_ID} .astro-target-id { font-weight:800; color:#f5fbff; }
    #${ASTRO_PANEL_ID} .astro-target-name { color:#9dbdca; font-size:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    #${ASTRO_PANEL_ID} .astro-target-pos { text-align:right; color:#e3f7ff; font-size:10px; white-space:nowrap; }
    #${ASTRO_PANEL_ID} .astro-target-track { color:#71e9c5; }
    #${ASTRO_PANEL_ID} .astro-foot {
      margin-top:9px; color:rgba(191,220,232,.45); font-size:9px; line-height:1.45;
    }
    @media (max-width: 820px) {
      #${ASTRO_PANEL_ID} { right:14px; top:68px; max-height:calc(100vh - 92px); }
    }
  `;
  document.head.appendChild(style);
}

function createPanel(onClose) {
  ensureStyles();
  let panel = document.getElementById(ASTRO_PANEL_ID);
  if (panel) return panel;

  panel = document.createElement('aside');
  panel.id = ASTRO_PANEL_ID;
  panel.hidden = true;
  panel.innerHTML = `
    <div class="astro-head">
      <div>
        <div class="astro-title">🔭 ASTRO MODE</div>
        <div class="astro-sub" data-astro-observer>Observer</div>
      </div>
      <button class="astro-close" type="button" title="Hide Astro Mode">×</button>
    </div>
    <div class="astro-body">
      <div class="astro-status-grid" data-astro-status></div>
      <div class="astro-weather" data-astro-weather></div>
      <div class="astro-radar-wrap" data-astro-radar></div>
      <div class="astro-controls">
        <button class="astro-btn" type="button" data-astro-action="now">NOW</button>
        <button class="astro-btn" type="button" data-astro-action="-1h">−1 H</button>
        <button class="astro-btn" type="button" data-astro-action="+1h">+1 H</button>
        <button class="astro-btn" type="button" data-astro-action="+3h">+3 H</button>
        <button class="astro-btn" type="button" data-astro-action="tonsberg">TØNSBERG</button>
        <button class="astro-btn" type="button" data-astro-action="map">MAP CENTER</button>
      </div>
      <div class="astro-section-title"><span>BEST DEEP-SKY TARGETS</span><span>ALT / AZ / TRACK</span></div>
      <div data-astro-targets></div>
      <div class="astro-foot">
        V2 combines local astronomy with keyless Open-Meteo forecast data. ASTRO SCORE includes cloud,
        humidity/dew risk, precipitation, visibility, wind, darkness, Moon and target geometry. Seeing is not yet modelled.
      </div>
    </div>`;
  panel.querySelector('.astro-close')?.addEventListener('click', onClose);
  document.body.appendChild(panel);
  return panel;
}

function mapCentreObserver(viewer) {
  const scene = viewer?.scene;
  const canvas = scene?.canvas;
  const ellipsoid = scene?.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;
  if (!viewer?.camera || !canvas) return null;

  const centre = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  let cartesian = viewer.camera.pickEllipsoid(centre, ellipsoid);

  // If the camera is looking away from the ellipsoid, fall back to its ground projection.
  if (!cartesian && viewer.camera.positionCartographic) {
    const c = viewer.camera.positionCartographic;
    return {
      name: 'Map / camera',
      lat: Cesium.Math.toDegrees(c.latitude),
      lon: Cesium.Math.toDegrees(c.longitude),
    };
  }
  if (!cartesian) return null;

  const cartographic = ellipsoid.cartesianToCartographic(cartesian);
  if (!cartographic) return null;
  return {
    name: 'Map center',
    lat: Cesium.Math.toDegrees(cartographic.latitude),
    lon: Cesium.Math.toDegrees(cartographic.longitude),
  };
}

function buildTargetSnapshot(observer, date, moonEq, moonPhase, darkness) {
  return DEEP_SKY_OBJECTS.map((object) => {
    const pos = equatorialToHorizontal(object.ra, object.dec, observer, date);
    const moonSeparation = angularSeparation(object, moonEq);
    const trackHours = trackWindowHours(object, observer, date);
    const score = targetScore(object, pos, moonEq, moonPhase, darkness);
    return {
      object,
      alt: pos.alt,
      az: pos.az,
      direction: compassDirection(pos.az),
      moonSeparation,
      trackHours,
      score,
    };
  }).sort((a, b) => b.score - a.score);
}

export function createAstroModeLayer() {
  let viewerRef = null;
  let panel = null;
  let enabled = false;
  let lastUpdate = null;
  let observer = { ...DEFAULT_OBSERVER };
  let timeOffsetMs = 0;
  let visibleCount = 0;
  let weatherData = null;
  let weatherLoading = false;
  let weatherError = null;
  let weatherAbort = null;
  let weatherObserverKey = '';
  let lastWeatherFetch = 0;

  function selectedDate() {
    return new Date(Date.now() + timeOffsetMs);
  }

  function requestRender() {
    try { viewerRef?.scene?.requestRender?.(); } catch { /* DOM panel still works */ }
  }

  function observerWeatherKey() {
    return `${observer.lat.toFixed(3)},${observer.lon.toFixed(3)}`;
  }

  async function refreshWeather(force = false) {
    const key = observerWeatherKey();
    const stale = Date.now() - lastWeatherFetch > WEATHER_REFRESH_MS;
    if (!force && weatherData && weatherObserverKey === key && !stale) return;
    if (weatherLoading) return;

    weatherLoading = true;
    weatherError = null;
    if (weatherObserverKey !== key) weatherData = null;
    weatherObserverKey = key;
    weatherAbort?.abort?.();
    weatherAbort = new AbortController();
    render();

    try {
      weatherData = await fetchAstroWeather(observer, weatherAbort.signal);
      lastWeatherFetch = Date.now();
    } catch (error) {
      if (error?.name !== 'AbortError') {
        weatherError = error?.message || 'Weather fetch failed';
      }
    } finally {
      weatherLoading = false;
      if (enabled) render();
    }
  }

  function render() {
    if (!panel) return;
    const date = selectedDate();
    const sunEq = sunEquatorial(date);
    const moonEq = moonEquatorial(date);
    const sunHorizontal = equatorialToHorizontal(sunEq.ra, sunEq.dec, observer, date);
    const moonHorizontal = equatorialToHorizontal(moonEq.ra, moonEq.dec, observer, date);
    const moonPhase = phaseInfo(sunEq, moonEq);
    const darkness = darknessInfo(sunHorizontal.alt);
    const targets = buildTargetSnapshot(observer, date, moonEq, moonPhase, darkness);
    const visible = targets.filter((entry) => entry.alt > 0);
    visibleCount = visible.length;
    const top = visible[0] || null;
    const geometryScore = skyGeometryScore(darkness, moonPhase, top);
    const weatherRow = nearestWeatherRow(weatherData, date);
    const weather = weatherQuality(weatherRow);
    const astroScore = combinedAstroScore(geometryScore, darkness, weather);

    const observerNode = panel.querySelector('[data-astro-observer]');
    const statusNode = panel.querySelector('[data-astro-status]');
    const weatherNode = panel.querySelector('[data-astro-weather]');
    const radarNode = panel.querySelector('[data-astro-radar]');
    const targetsNode = panel.querySelector('[data-astro-targets]');

    if (observerNode) {
      observerNode.textContent = `${observer.name} · ${formatObserver(observer)} · ${formatTime(date)}`;
    }

    if (statusNode) {
      statusNode.innerHTML = `
        <div class="astro-stat">
          <div class="astro-stat-label">ASTRO SCORE</div>
          <div class="astro-stat-value"><span class="astro-score">${astroScore}/10</span> · ${astroScoreLabel(astroScore)}</div>
        </div>
        <div class="astro-stat">
          <div class="astro-stat-label">DARKNESS</div>
          <div class="astro-stat-value" style="color:${darkness.accent}">${darkness.label}</div>
        </div>
        <div class="astro-stat">
          <div class="astro-stat-label">SUN</div>
          <div class="astro-stat-value">${formatDegrees(sunHorizontal.alt)} · ${compassDirection(sunHorizontal.az)}</div>
        </div>
        <div class="astro-stat">
          <div class="astro-stat-label">MOON</div>
          <div class="astro-stat-value">${Math.round(moonPhase.illumination * 100)}% · ${formatDegrees(moonHorizontal.alt)} ${compassDirection(moonHorizontal.az)}</div>
        </div>`;
    }

    if (weatherNode) {
      if (weatherLoading && !weatherData) {
        weatherNode.innerHTML = `<div class="astro-weather-head"><strong>ASTRO WEATHER</strong><span>loading forecast…</span></div>`;
      } else if (weatherError && !weatherData) {
        weatherNode.innerHTML = `
          <div class="astro-weather-head"><strong>ASTRO WEATHER</strong><span>offline</span></div>
          <div class="astro-weather-error">${escapeHtml(weatherError)}<br>Astro Mode continues with astronomy-only scoring.</div>`;
      } else if (!weatherRow || !weather) {
        weatherNode.innerHTML = `
          <div class="astro-weather-head"><strong>ASTRO WEATHER</strong><span>${weatherData ? 'outside forecast range' : 'waiting for forecast'}</span></div>
          <div class="astro-weather-error">No hourly forecast is available for the selected time.</div>`;
      } else {
        const warnings = weather.warnings.length ? weather.warnings.join(' · ') : 'no major weather warnings';
        weatherNode.innerHTML = `
          <div class="astro-weather-head">
            <strong>ASTRO WEATHER · ${weather.score}/10</strong>
            <span>${escapeHtml(weatherData?.source || 'Open-Meteo')} · ${String(weatherRow.time.getUTCHours()).padStart(2, '0')}:00 UTC</span>
          </div>
          <div class="astro-weather-grid">
            <div class="astro-weather-chip"><span>TEMP</span><strong>${weatherRow.temperature.toFixed(1)}°C</strong></div>
            <div class="astro-weather-chip"><span>HUMIDITY</span><strong>${Math.round(weatherRow.humidity)}%</strong></div>
            <div class="astro-weather-chip"><span>WIND</span><strong>${weatherRow.wind.toFixed(1)} m/s</strong></div>
            <div class="astro-weather-chip"><span>VIS</span><strong>${weather.visibilityKm.toFixed(0)} km</strong></div>
          </div>
          ${weatherBar('TOTAL', weatherRow.cloud)}
          ${weatherBar('LOW', weatherRow.cloudLow)}
          ${weatherBar('MID', weatherRow.cloudMid)}
          ${weatherBar('HIGH', weatherRow.cloudHigh)}
          <div class="astro-weather-warning">${escapeHtml(warnings)} · dew spread ${weather.dewSpread.toFixed(1)}°C · precip ${Math.round(weatherRow.precipitationProbability)}%</div>
          ${weatherTimeline(weatherData, date)}
        `;
      }
    }

    if (radarNode) {
      radarNode.innerHTML = buildRadarSvg(targets, sunHorizontal, moonHorizontal);
    }

    if (targetsNode) {
      const best = targets.filter((entry) => entry.alt > 5).slice(0, 7);
      targetsNode.innerHTML = best.length ? best.map((entry) => {
        const track = entry.trackHours > 0
          ? `${entry.trackHours.toFixed(1)}h`
          : '<25°';
        return `
          <div class="astro-target">
            <div>
              <div class="astro-target-id" style="color:${objectColor(entry.object.type)}">${escapeHtml(entry.object.id)}</div>
              <div class="astro-target-name">${escapeHtml(entry.object.type.toUpperCase())}</div>
            </div>
            <div class="astro-target-name" title="${escapeHtml(entry.object.name)}">${escapeHtml(entry.object.name)}</div>
            <div class="astro-target-pos">
              ${Math.round(entry.alt)}° · ${entry.direction}<br>
              <span class="astro-target-track">${track}</span>
            </div>
          </div>`;
      }).join('') : '<div class="astro-foot">No catalogue targets are above the local horizon at this selected time.</div>';
    }

    lastUpdate = Date.now();
    requestRender();
  }

  function onAction(event) {
    const button = event.target?.closest?.('[data-astro-action]');
    if (!button) return;
    const action = button.dataset.astroAction;
    if (action === 'now') timeOffsetMs = 0;
    if (action === '-1h') timeOffsetMs -= 60 * 60_000;
    if (action === '+1h') timeOffsetMs += 60 * 60_000;
    if (action === '+3h') timeOffsetMs += 3 * 60 * 60_000;
    if (action === 'tonsberg') observer = { ...DEFAULT_OBSERVER };
    if (action === 'map') {
      const selected = mapCentreObserver(viewerRef);
      if (selected) observer = selected;
    }
    if (action === 'tonsberg' || action === 'map') refreshWeather(true);
    render();
  }

  const layer = {
    id: 'astro-mode',
    name: 'Astro Mode',
    icon: '🔭',
    source: 'Local astronomy + Open-Meteo',
    updateInterval: 60_000,

    init(viewer) {
      viewerRef = viewer;
      panel = createPanel(() => {
        // The close X only hides the panel. The data-layer toggle remains ON,
        // so opening the row again is deterministic and state persistence stays honest.
        if (panel) panel.hidden = true;
      });
      panel.addEventListener('click', onAction);
      panel.hidden = true;
      enabled = false;
      visibleCount = 0;
      weatherData = null;
      weatherError = null;
      weatherObserverKey = '';
      lastWeatherFetch = 0;
      return true;
    },

    enable() {
      enabled = true;
      if (panel) panel.hidden = false;
      render();
      refreshWeather(false);
      return true;
    },

    disable() {
      enabled = false;
      if (panel) panel.hidden = true;
      return true;
    },

    update() {
      if (enabled && panel && !panel.hidden) {
        render();
        refreshWeather(false);
      }
      lastUpdate = Date.now();
      return true;
    },

    destroy() {
      enabled = false;
      if (panel) {
        panel.removeEventListener('click', onAction);
        panel.remove();
        panel = null;
      }
      document.getElementById(ASTRO_STYLE_ID)?.remove();
      weatherAbort?.abort?.();
      weatherAbort = null;
      weatherData = null;
      weatherLoading = false;
      weatherError = null;
      viewerRef = null;
      visibleCount = 0;
      lastUpdate = null;
      return true;
    },

    getStats() {
      return {
        count: visibleCount,
        lastUpdate,
        source: 'Local astronomy + Open-Meteo · no API key',
      };
    },
  };

  return layer;
}

const astroModeLayer = createAstroModeLayer();
export default astroModeLayer;
