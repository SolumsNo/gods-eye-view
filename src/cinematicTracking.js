import * as Cesium from 'cesium';
import flightsLayer from './data/flights.js';
import militaryFlightsLayer from './data/militaryFlights.js';
import satellitesLayer from './data/satellites.js';
import aisLiveVesselsLayer from './data/aisLiveVessels.js';
import { resolvePickId } from './data/pickRegistry.js';
import {
  holdContinuousRender,
  releaseContinuousRender,
  governorRequestRender,
} from './renderGovernor.js';

/**
 * GOD'S EYE VIEW — Cinematic Tracking Mode
 *
 * Double-click a live flight, military aircraft, satellite or AIS vessel.
 * Camera modes:
 *   1 / CHASE    - behind the subject
 *   2 / ORBIT    - slow continuous orbit
 *   3 / SIDE     - side tracking
 *   4 / OVERHEAD - top-down pursuit
 *
 * Esc exits. K starts cinematic mode from the currently tracked/selected subject.
 *
 * This module intentionally consumes the existing public layer contracts rather
 * than modifying flights.js / militaryFlights.js / satellites.js / AIS internals.
 */

const STYLE_ID = 'gev-cinematic-tracking-style';
const HUD_ID = 'gev-cinematic-tracking-hud';
const HINT_ID = 'gev-cinematic-tracking-hint';

const FAMILY = Object.freeze({
  FLIGHT: 'flight',
  MILITARY: 'military',
  SATELLITE: 'satellite',
  VESSEL: 'vessel',
});

const MODE = Object.freeze({
  CHASE: 'chase',
  ORBIT: 'orbit',
  SIDE: 'side',
  OVERHEAD: 'overhead',
});

const DEFAULT_RANGES = Object.freeze({
  [FAMILY.FLIGHT]: 950,
  [FAMILY.MILITARY]: 1050,
  [FAMILY.VESSEL]: 320,
  [FAMILY.SATELLITE]: 120000,
});

const MIN_RANGE = Object.freeze({
  [FAMILY.FLIGHT]: 180,
  [FAMILY.MILITARY]: 220,
  [FAMILY.VESSEL]: 80,
  [FAMILY.SATELLITE]: 15000,
});

const MAX_RANGE = Object.freeze({
  [FAMILY.FLIGHT]: 12000,
  [FAMILY.MILITARY]: 15000,
  [FAMILY.VESSEL]: 6000,
  [FAMILY.SATELLITE]: 1_500_000,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function shortestAngleDeg(from, to) {
  let delta = normalizeDegrees(to) - normalizeDegrees(from);
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  return delta;
}

function lerpAngleDeg(from, to, t) {
  return normalizeDegrees(from + shortestAngleDeg(from, to) * t);
}

function safeNumber(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres >= 100000) return `${Math.round(metres / 1000)} km`;
  if (metres >= 10000) return `${(metres / 1000).toFixed(1)} km`;
  if (metres >= 1000) return `${(metres / 1000).toFixed(2)} km`;
  return `${Math.round(metres)} m`;
}

function formatAltitude(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres >= 100000) return `${Math.round(metres / 1000)} km`;
  return `${Math.round(metres).toLocaleString('nb-NO')} m`;
}

function formatSpeedMps(mps) {
  if (!Number.isFinite(mps)) return '—';
  const kmh = mps * 3.6;
  return `${Math.round(kmh)} km/h`;
}

function formatKnots(knots) {
  if (!Number.isFinite(knots)) return '—';
  return `${knots.toFixed(knots < 10 ? 1 : 0)} kt`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char]));
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${HUD_ID} {
      position: fixed;
      left: 50%;
      bottom: 38px;
      transform: translateX(-50%);
      z-index: 2100;
      width: min(760px, calc(100vw - 28px));
      color: #eafaff;
      background:
        linear-gradient(180deg, rgba(8,17,26,.91), rgba(3,8,13,.94)),
        radial-gradient(circle at 50% 0%, rgba(70,194,255,.15), transparent 52%);
      border: 1px solid rgba(108,220,255,.35);
      border-radius: 11px;
      box-shadow: 0 18px 65px rgba(0,0,0,.48), inset 0 0 35px rgba(88,211,255,.035);
      backdrop-filter: blur(14px);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      letter-spacing: .035em;
      user-select: none;
    }
    #${HUD_ID}[hidden] { display: none !important; }
    #${HUD_ID} .cinematic-top {
      display: grid;
      grid-template-columns: auto minmax(140px, 1fr) auto;
      align-items: center;
      gap: 11px;
      padding: 9px 11px 8px;
      border-bottom: 1px solid rgba(129,218,255,.12);
    }
    #${HUD_ID} .cinematic-badge {
      display:inline-flex; align-items:center; gap:6px;
      color:#83e8ff; font-size:10px; font-weight:800; letter-spacing:.15em;
      white-space:nowrap;
    }
    #${HUD_ID} .cinematic-live-dot {
      width:7px; height:7px; border-radius:50%; background:#5cffb0;
      box-shadow:0 0 12px rgba(92,255,176,.75);
    }
    #${HUD_ID} .cinematic-subject { min-width:0; }
    #${HUD_ID} .cinematic-name {
      font-size:13px; font-weight:800; color:#fff; overflow:hidden;
      text-overflow:ellipsis; white-space:nowrap;
    }
    #${HUD_ID} .cinematic-type {
      margin-top:2px; color:rgba(206,237,249,.5); font-size:9px; letter-spacing:.12em;
    }
    #${HUD_ID} .cinematic-stop {
      border:1px solid rgba(255,126,126,.26); background:rgba(255,70,70,.06);
      color:#ffb2b2; border-radius:6px; padding:6px 9px; font:inherit; font-size:9px;
      cursor:pointer;
    }
    #${HUD_ID} .cinematic-stop:hover { background:rgba(255,70,70,.15); }
    #${HUD_ID} .cinematic-body {
      display:grid; grid-template-columns:minmax(250px,1fr) auto;
      gap:10px; padding:9px 11px 10px;
    }
    #${HUD_ID} .cinematic-metrics {
      display:grid; grid-template-columns:repeat(5,minmax(70px,1fr)); gap:6px;
    }
    #${HUD_ID} .cinematic-metric {
      border:1px solid rgba(119,211,247,.10); border-radius:6px;
      background:rgba(255,255,255,.022); padding:6px 7px;
    }
    #${HUD_ID} .cinematic-label { color:rgba(192,224,237,.43); font-size:8px; letter-spacing:.12em; }
    #${HUD_ID} .cinematic-value { color:#ebfaff; font-size:10px; font-weight:700; margin-top:2px; white-space:nowrap; }
    #${HUD_ID} .cinematic-modes { display:flex; flex-wrap:wrap; gap:5px; justify-content:flex-end; align-content:start; }
    #${HUD_ID} .cinematic-mode {
      border:1px solid rgba(109,212,251,.18); background:rgba(62,158,203,.06);
      color:#aeeaff; border-radius:6px; padding:6px 7px; font:inherit; font-size:8px;
      cursor:pointer; min-width:54px;
    }
    #${HUD_ID} .cinematic-mode.active {
      background:rgba(72,194,238,.20); color:#fff; border-color:rgba(119,226,255,.58);
      box-shadow:inset 0 0 14px rgba(93,218,255,.08);
    }
    #${HINT_ID} {
      position:fixed; z-index:2050; left:50%; top:82px; transform:translateX(-50%);
      color:#c9f4ff; background:rgba(4,13,21,.88); border:1px solid rgba(102,214,255,.24);
      border-radius:8px; padding:8px 12px;
      font:10px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      letter-spacing:.06em; pointer-events:none; opacity:0; transition:opacity .25s ease;
      backdrop-filter:blur(10px);
    }
    #${HINT_ID}.show { opacity:1; }
    body.gev-cinematic-active #cesiumContainer { cursor: crosshair; }
    @media(max-width:760px) {
      #${HUD_ID} { bottom:18px; }
      #${HUD_ID} .cinematic-top { grid-template-columns:auto minmax(0,1fr) auto; }
      #${HUD_ID} .cinematic-body { grid-template-columns:1fr; }
      #${HUD_ID} .cinematic-metrics { grid-template-columns:repeat(3,1fr); }
      #${HUD_ID} .cinematic-modes { justify-content:flex-start; }
    }
  `;
  document.head.appendChild(style);
}

function ensureHud(stopFn, setModeFn) {
  ensureStyles();
  let hud = document.getElementById(HUD_ID);
  if (hud) return hud;

  hud = document.createElement('aside');
  hud.id = HUD_ID;
  hud.hidden = true;
  hud.innerHTML = `
    <div class="cinematic-top">
      <div class="cinematic-badge"><span class="cinematic-live-dot"></span> CINEMATIC TRACK</div>
      <div class="cinematic-subject">
        <div class="cinematic-name" data-cinematic-name>—</div>
        <div class="cinematic-type" data-cinematic-type>—</div>
      </div>
      <button class="cinematic-stop" type="button" data-cinematic-stop>ESC · RELEASE</button>
    </div>
    <div class="cinematic-body">
      <div class="cinematic-metrics">
        <div class="cinematic-metric"><div class="cinematic-label">SPEED</div><div class="cinematic-value" data-cinematic-speed>—</div></div>
        <div class="cinematic-metric"><div class="cinematic-label">ALTITUDE</div><div class="cinematic-value" data-cinematic-altitude>—</div></div>
        <div class="cinematic-metric"><div class="cinematic-label">COURSE</div><div class="cinematic-value" data-cinematic-course>—</div></div>
        <div class="cinematic-metric"><div class="cinematic-label">CAM RANGE</div><div class="cinematic-value" data-cinematic-range>—</div></div>
        <div class="cinematic-metric"><div class="cinematic-label">SOURCE</div><div class="cinematic-value" data-cinematic-source>—</div></div>
      </div>
      <div class="cinematic-modes">
        <button type="button" class="cinematic-mode" data-cinematic-mode="chase">1 · CHASE</button>
        <button type="button" class="cinematic-mode" data-cinematic-mode="orbit">2 · ORBIT</button>
        <button type="button" class="cinematic-mode" data-cinematic-mode="side">3 · SIDE</button>
        <button type="button" class="cinematic-mode" data-cinematic-mode="overhead">4 · TOP</button>
      </div>
    </div>`;

  hud.querySelector('[data-cinematic-stop]')?.addEventListener('click', stopFn);
  hud.querySelectorAll('[data-cinematic-mode]').forEach((button) => {
    button.addEventListener('click', () => setModeFn(button.dataset.cinematicMode));
  });
  document.body.appendChild(hud);
  return hud;
}

function ensureHint() {
  let hint = document.getElementById(HINT_ID);
  if (hint) return hint;
  hint = document.createElement('div');
  hint.id = HINT_ID;
  hint.textContent = '🎬 CINEMATIC READY · DOUBLE-CLICK FLIGHT, SATELLITE OR AIS VESSEL';
  document.body.appendChild(hint);
  return hint;
}

function subjectSourceLabel(family) {
  if (family === FAMILY.FLIGHT) return 'OPENSKY';
  if (family === FAMILY.MILITARY) return 'ADSB.LOL';
  if (family === FAMILY.SATELLITE) return 'CELESTRAK';
  if (family === FAMILY.VESSEL) return 'AIS';
  return 'LIVE';
}

function subjectTypeLabel(family, info = {}) {
  if (family === FAMILY.FLIGHT) return info.typeName || info.typeCode || 'CIVIL AIRCRAFT';
  if (family === FAMILY.MILITARY) return info.typeName || info.typeCode || 'MILITARY AIRCRAFT';
  if (family === FAMILY.SATELLITE) return 'SATELLITE';
  if (family === FAMILY.VESSEL) return info.type || 'VESSEL';
  return 'CONTACT';
}

function identityLabel(family, info, id) {
  if (family === FAMILY.FLIGHT || family === FAMILY.MILITARY) {
    return info?.callsign || info?.registration || id;
  }
  if (family === FAMILY.SATELLITE) return info?.name || `SAT-${id}`;
  if (family === FAMILY.VESSEL) return info?.name || `MMSI ${id}`;
  return String(id);
}

function detectFamily(pickId) {
  if (!pickId) return null;

  try {
    if (flightsLayer.hasContact?.(pickId) === true) return FAMILY.FLIGHT;
  } catch {}
  try {
    if (militaryFlightsLayer.hasContact?.(pickId) === true) return FAMILY.MILITARY;
  } catch {}
  try {
    if (aisLiveVesselsLayer.hasContact?.(pickId) === true) return FAMILY.VESSEL;
  } catch {}

  // Satellite ids are numeric; findByQuery is exact for numeric NORAD ids.
  if (/^\d+$/.test(String(pickId))) {
    try {
      if (satellitesLayer.findByQuery?.(pickId)) return FAMILY.SATELLITE;
    } catch {}
  }
  return null;
}

function startLayerSelection(family, id) {
  if (family === FAMILY.FLIGHT) return flightsLayer.trackById?.(id, { origin: 'user' }) === true;
  if (family === FAMILY.MILITARY) return militaryFlightsLayer.trackById?.(id, { origin: 'user' }) === true;
  if (family === FAMILY.SATELLITE) return satellitesLayer.trackById?.(id, { origin: 'user' }) === true;
  if (family === FAMILY.VESSEL) return aisLiveVesselsLayer.selectById?.(id) === true;
  return false;
}

function clearLayerSelection(family) {
  try {
    if (family === FAMILY.FLIGHT) flightsLayer.stopTracking?.({ origin: 'user' });
    else if (family === FAMILY.MILITARY) militaryFlightsLayer.stopTracking?.({ origin: 'user' });
    else if (family === FAMILY.SATELLITE) satellitesLayer.stopTracking?.({ origin: 'user' });
    else if (family === FAMILY.VESSEL) aisLiveVesselsLayer.clearSelection?.();
  } catch {}
}

function getLiveSubject(family, id) {
  if (family === FAMILY.FLIGHT) {
    const info = flightsLayer.getTrackedInfo?.();
    const subject = flightsLayer.getTrackedSubject?.();
    if (!info || !subject?.position) return null;
    return { info, position: Cesium.Cartesian3.clone(subject.position) };
  }

  if (family === FAMILY.MILITARY) {
    const info = militaryFlightsLayer.getTrackedInfo?.();
    const subject = militaryFlightsLayer.getTrackedSubject?.();
    if (!info || !subject?.position) return null;
    return { info, position: Cesium.Cartesian3.clone(subject.position) };
  }

  if (family === FAMILY.SATELLITE) {
    const info = satellitesLayer.getTrackedInfo?.();
    if (!info || !Number.isFinite(info.longitude) || !Number.isFinite(info.latitude)) return null;
    const position = Cesium.Cartesian3.fromDegrees(
      info.longitude,
      info.latitude,
      Number.isFinite(info.altitudeM) ? info.altitudeM : 0,
    );
    return { info, position };
  }

  if (family === FAMILY.VESSEL) {
    const record = aisLiveVesselsLayer.findByQuery?.(id);
    const info = aisLiveVesselsLayer.getSelectedInfo?.() || record;
    if (!record?.position || !info) return null;
    return { info, position: Cesium.Cartesian3.clone(record.position) };
  }

  return null;
}

function currentSelectedCandidate() {
  try {
    const info = flightsLayer.getTrackedInfo?.();
    if (info?.icao24) return { family: FAMILY.FLIGHT, id: info.icao24 };
  } catch {}
  try {
    const info = militaryFlightsLayer.getTrackedInfo?.();
    if (info?.icao24) return { family: FAMILY.MILITARY, id: info.icao24 };
  } catch {}
  try {
    const info = satellitesLayer.getTrackedInfo?.();
    if (Number.isFinite(info?.noradId)) return { family: FAMILY.SATELLITE, id: String(info.noradId) };
  } catch {}
  try {
    const info = aisLiveVesselsLayer.getSelectedInfo?.();
    if (info?.mmsi) return { family: FAMILY.VESSEL, id: String(info.mmsi) };
  } catch {}
  return null;
}

function modePose(mode, family, courseDeg, orbitDeg) {
  const course = Number.isFinite(courseDeg) ? courseDeg : orbitDeg;
  if (mode === MODE.ORBIT) {
    return { headingDeg: orbitDeg, pitchDeg: family === FAMILY.SATELLITE ? -26 : -18 };
  }
  if (mode === MODE.SIDE) {
    return { headingDeg: course + 90, pitchDeg: family === FAMILY.SATELLITE ? -20 : -12 };
  }
  if (mode === MODE.OVERHEAD) {
    return { headingDeg: course, pitchDeg: -82 };
  }
  return { headingDeg: course + 180, pitchDeg: family === FAMILY.SATELLITE ? -18 : -14 };
}

export function initCinematicTrackingMode({ viewer, dataManager = null } = {}) {
  if (!viewer?.scene?.canvas || !viewer?.camera) {
    throw new Error('Cinematic Tracking requires a Cesium Viewer');
  }

  let active = null;
  let mode = MODE.CHASE;
  let orbitHeadingDeg = 0;
  let smoothedHeadingDeg = 0;
  let lastFrameMs = performance.now();
  let currentRange = null;
  let requestedRange = null;
  let preRenderRemove = null;
  let doubleClickHandler = null;
  let destroyed = false;
  let missingFrames = 0;
  let lastPosition = null;
  let lastPositionMs = null;
  let estimatedSpeedMps = null;
  let hintTimer = null;
  let hudUpdateMs = 0;
  let inputStateBefore = true;

  const hud = ensureHud(
    () => stop({ clearSelection: true }),
    (next) => setMode(next),
  );
  const hint = ensureHint();

  function showHint(message = null, duration = 4200) {
    if (destroyed) return;
    if (message) hint.textContent = message;
    hint.classList.add('show');
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => hint.classList.remove('show'), duration);
  }

  function setMode(nextMode) {
    if (!Object.values(MODE).includes(nextMode)) return false;
    mode = nextMode;
    hud.querySelectorAll('[data-cinematic-mode]').forEach((button) => {
      button.classList.toggle('active', button.dataset.cinematicMode === mode);
    });
    if (active) governorRequestRender('cinematic-mode-change');
    return true;
  }

  function desiredRangeFor(family, nextMode) {
    const base = DEFAULT_RANGES[family] || 1000;
    if (nextMode === MODE.OVERHEAD) return base * (family === FAMILY.SATELLITE ? 0.82 : 0.78);
    if (nextMode === MODE.SIDE) return base * 1.08;
    if (nextMode === MODE.ORBIT) return base * 1.18;
    return base;
  }

  function updateHud(subject, cameraRange) {
    const now = performance.now();
    if (now - hudUpdateMs < 120) return;
    hudUpdateMs = now;

    const info = subject.info || {};
    const family = active?.family;
    const name = identityLabel(family, info, active?.id);
    const type = subjectTypeLabel(family, info);
    const course = safeNumber(info.track ?? info.course);
    const speed = family === FAMILY.VESSEL
      ? formatKnots(safeNumber(info.speedKt ?? info.speed))
      : formatSpeedMps(safeNumber(info.velocityMps) ?? estimatedSpeedMps);

    hud.querySelector('[data-cinematic-name]').textContent = name;
    hud.querySelector('[data-cinematic-type]').textContent =
      `${String(type).toUpperCase()} · ${String(active?.id ?? '').toUpperCase()}`;
    hud.querySelector('[data-cinematic-speed]').textContent = speed;
    hud.querySelector('[data-cinematic-altitude]').textContent =
      formatAltitude(safeNumber(info.altitudeM) ?? (family === FAMILY.VESSEL ? 0 : null));
    hud.querySelector('[data-cinematic-course]').textContent =
      Number.isFinite(course) ? `${Math.round(normalizeDegrees(course))}°` : '—';
    hud.querySelector('[data-cinematic-range]').textContent = formatDistance(cameraRange);
    hud.querySelector('[data-cinematic-source]').textContent = subjectSourceLabel(family);
  }

  function estimateSpeed(position, nowMs) {
    if (lastPosition && Number.isFinite(lastPositionMs) && nowMs > lastPositionMs) {
      const dt = (nowMs - lastPositionMs) / 1000;
      if (dt >= 0.08 && dt <= 2.5) {
        const distance = Cesium.Cartesian3.distance(lastPosition, position);
        if (Number.isFinite(distance)) {
          const raw = distance / dt;
          estimatedSpeedMps = estimatedSpeedMps == null
            ? raw
            : estimatedSpeedMps * 0.82 + raw * 0.18;
        }
      }
    }
    lastPosition = Cesium.Cartesian3.clone(position, lastPosition || new Cesium.Cartesian3());
    lastPositionMs = nowMs;
  }

  function updateCamera() {
    if (!active || destroyed) return;
    const now = performance.now();
    const dt = clamp((now - lastFrameMs) / 1000, 0, 0.1);
    lastFrameMs = now;

    const subject = getLiveSubject(active.family, active.id);
    if (!subject?.position) {
      missingFrames += 1;
      if (missingFrames > 90) stop({ clearSelection: false, reason: 'TARGET LOST' });
      return;
    }
    missingFrames = 0;
    estimateSpeed(subject.position, now);

    const course = safeNumber(subject.info?.track ?? subject.info?.course);
    orbitHeadingDeg = normalizeDegrees(orbitHeadingDeg + dt * (active.family === FAMILY.SATELLITE ? 4 : 6));

    const pose = modePose(mode, active.family, course, orbitHeadingDeg);
    const follow = 1 - Math.pow(0.002, dt || 0.016);
    smoothedHeadingDeg = lerpAngleDeg(smoothedHeadingDeg, pose.headingDeg, follow);

    requestedRange = desiredRangeFor(active.family, mode);
    if (!Number.isFinite(currentRange)) currentRange = requestedRange * 2.4;
    const rangeEase = 1 - Math.pow(0.035, dt || 0.016);
    currentRange += (requestedRange - currentRange) * rangeEase;
    currentRange = clamp(
      currentRange,
      MIN_RANGE[active.family] || 50,
      MAX_RANGE[active.family] || 2_000_000,
    );

    // Release any layer-owned Cesium EntityView. Internal tracking remains active:
    // the flight/military cross-layer guards only clear when another trackedEntity
    // actually takes ownership, and satellites keep their own tracked record.
    if (viewer.trackedEntity) viewer.trackedEntity = undefined;

    const offset = new Cesium.HeadingPitchRange(
      Cesium.Math.toRadians(smoothedHeadingDeg),
      Cesium.Math.toRadians(pose.pitchDeg),
      currentRange,
    );
    viewer.camera.lookAt(subject.position, offset);
    updateHud(subject, currentRange);
  }

  function start(candidate, { fromDoubleClick = false } = {}) {
    if (!candidate?.family || candidate.id === null || candidate.id === undefined) return false;
    if (active) stop({ clearSelection: false });

    const id = String(candidate.id);
    if (!startLayerSelection(candidate.family, id)) {
      showHint('🎬 TARGET COULD NOT BE TRACKED', 2400);
      return false;
    }

    active = { family: candidate.family, id };
    mode = MODE.CHASE;
    orbitHeadingDeg = 0;
    const initial = getLiveSubject(candidate.family, id);
    const course = safeNumber(initial?.info?.track ?? initial?.info?.course) ?? 0;
    smoothedHeadingDeg = normalizeDegrees(course + 180);
    currentRange = desiredRangeFor(candidate.family, MODE.CHASE) * 2.6;
    requestedRange = desiredRangeFor(candidate.family, MODE.CHASE);
    lastFrameMs = performance.now();
    missingFrames = 0;
    lastPosition = null;
    lastPositionMs = null;
    estimatedSpeedMps = null;

    inputStateBefore = viewer.scene.screenSpaceCameraController.enableInputs !== false;
    viewer.scene.screenSpaceCameraController.enableInputs = false;
    viewer.camera.cancelFlight();
    viewer.trackedEntity = undefined;

    document.body.classList.add('gev-cinematic-active');
    hud.hidden = false;
    setMode(MODE.CHASE);
    holdContinuousRender('cinematic-tracking');
    governorRequestRender('cinematic-start');

    if (fromDoubleClick) {
      showHint('🎬 CINEMATIC TRACKING · 1 CHASE · 2 ORBIT · 3 SIDE · 4 TOP · ESC RELEASE', 3000);
    }
    return true;
  }

  function stop({ clearSelection = false, reason = null } = {}) {
    if (!active) return false;
    const previous = active;
    active = null;

    releaseContinuousRender('cinematic-tracking');
    document.body.classList.remove('gev-cinematic-active');
    hud.hidden = true;

    viewer.scene.screenSpaceCameraController.enableInputs = inputStateBefore;
    try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch {}

    if (clearSelection) clearLayerSelection(previous.family);
    if (reason) showHint(`🎬 ${reason}`, 2200);
    governorRequestRender('cinematic-stop');
    return true;
  }

  function onDoubleClick(click) {
    if (destroyed || document.body.classList.contains('cockpit-mode')) return;
    const picked = viewer.scene.pick(click.position);
    const pickId = resolvePickId(picked);
    if (!pickId) return;
    const family = detectFamily(pickId);
    if (!family) return;
    start({ family, id: pickId }, { fromDoubleClick: true });
  }

  function onKeyDown(event) {
    if (destroyed) return;

    if (active && event.key === 'Escape') {
      // Capture-phase handler prevents the layer's normal Escape handler from
      // racing this camera release and issuing a second teardown.
      event.preventDefault();
      event.stopImmediatePropagation();
      stop({ clearSelection: true });
      return;
    }

    if (active && ['1', '2', '3', '4'].includes(event.key)) {
      const table = { '1': MODE.CHASE, '2': MODE.ORBIT, '3': MODE.SIDE, '4': MODE.OVERHEAD };
      setMode(table[event.key]);
      return;
    }

    if (event.key.toLowerCase() === 'k' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (active) {
        stop({ clearSelection: false });
        return;
      }
      const candidate = currentSelectedCandidate();
      if (candidate) start(candidate);
      else showHint('🎬 SELECT A FLIGHT, SATELLITE OR AIS VESSEL FIRST', 2600);
    }
  }

  doubleClickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  doubleClickHandler.setInputAction(onDoubleClick, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);

  preRenderRemove = viewer.scene.preRender.addEventListener(updateCamera);
  window.addEventListener('keydown', onKeyDown, true);

  showHint();

  const api = Object.freeze({
    startById(family, id) {
      return start({ family, id });
    },
    startCurrent() {
      const candidate = currentSelectedCandidate();
      return candidate ? start(candidate) : false;
    },
    stop,
    setMode,
    isActive() {
      return Boolean(active);
    },
    getState() {
      return active
        ? Object.freeze({ ...active, mode, rangeM: currentRange })
        : Object.freeze({ active: false, mode });
    },
    destroy() {
      if (destroyed) return;
      stop({ clearSelection: false });
      destroyed = true;
      if (hintTimer) clearTimeout(hintTimer);
      doubleClickHandler?.destroy?.();
      doubleClickHandler = null;
      preRenderRemove?.();
      preRenderRemove = null;
      window.removeEventListener('keydown', onKeyDown, true);
      hud.remove();
      hint.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
  });

  return api;
}

export default initCinematicTrackingMode;
