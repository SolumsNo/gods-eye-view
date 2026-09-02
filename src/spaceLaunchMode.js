import * as Cesium from 'cesium';
import {
  approximateOrbitPath,
  reconstructedAscentPath,
  samplePath,
  replayInitialCameraHeading,
  replayChaseCameraHeading,
  smoothReplayCameraHeading,
  replayCameraView,
} from './data/rocketLaunches.js';
import { holdContinuousRender, releaseContinuousRender, governorRequestRender } from './renderGovernor.js';

const PANEL_ID = 'gev-space-launch-mode';
const BUTTON_ID = 'gev-space-launch-button';
const STYLE_ID = 'gev-space-launch-style';
const DATA_SOURCE_ID = 'space-launch-upcoming';
const API_URL = '/api/upcoming-launches';

const CYAN = Cesium.Color.fromCssColorString('#22e6e6');
const GREEN = Cesium.Color.fromCssColorString('#7bed9f');
const PURPLE = Cesium.Color.fromCssColorString('#c084fc');
const AMBER = Cesium.Color.fromCssColorString('#ffd166');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;',
  }[c]));
}

function compact(value, max = 42) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

function dateMs(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function launchTimeOf(raw) {
  return raw?.net || raw?.window_start || raw?.window_end || null;
}

function normalizeLaunch(raw) {
  const pad = raw?.pad || {};
  const location = pad?.location || {};
  const coordinates = String(location?.coordinates || '').split(',').map(Number);
  const lon = Number.isFinite(Number(pad.longitude)) ? Number(pad.longitude) : coordinates[0];
  const lat = Number.isFinite(Number(pad.latitude)) ? Number(pad.latitude) : coordinates[1];
  const launchTime = launchTimeOf(raw);
  const ms = dateMs(launchTime);
  return {
    id: String(raw?.id || raw?.slug || raw?.name || `launch-${ms}`),
    name: raw?.name || 'Unnamed launch',
    launchTime: ms === null ? null : new Date(ms).toISOString(),
    status: raw?.status?.name || 'Scheduled',
    provider: raw?.launch_service_provider?.name || 'Unknown operator',
    launchSite: pad?.name || location?.name || 'Unknown launch site',
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    orbit: raw?.mission?.orbit || raw?.orbit || null,
    mission: raw?.mission?.description || null,
    missionName: raw?.mission?.name || null,
    image: raw?.image?.image_url || raw?.image || null,
  };
}

function formatCountdown(ms) {
  if (!Number.isFinite(ms)) return 'T− --';
  const sign = ms >= 0 ? 'T−' : 'T+';
  let seconds = Math.floor(Math.abs(ms) / 1000);
  const days = Math.floor(seconds / 86400); seconds %= 86400;
  const hours = Math.floor(seconds / 3600); seconds %= 3600;
  const minutes = Math.floor(seconds / 60); seconds %= 60;
  if (days > 0) return `${sign} ${days}D ${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
  return `${sign} ${String(hours).padStart(2,'0')}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

function formatLocalTime(iso) {
  const ms = dateMs(iso);
  if (ms === null) return 'UNAVAILABLE';
  return new Intl.DateTimeFormat('nb-NO', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(ms));
}

function formatUtc(iso) {
  const ms = dateMs(iso);
  return ms === null ? 'UNAVAILABLE' : new Date(ms).toISOString().replace('T',' ').slice(0,19) + ' UTC';
}

function orbitName(launch) {
  return launch?.orbit?.name || launch?.orbit?.abbrev || 'Orbit not specified';
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    #${BUTTON_ID} {
      position:fixed; right:18px; bottom:92px; z-index:2060;
      display:flex; align-items:center; gap:7px;
      border:1px solid rgba(70,224,255,.32); border-radius:9px;
      background:rgba(4,13,22,.90); color:#bff6ff;
      padding:8px 10px; font:700 10px ui-monospace,SFMono-Regular,Menlo,monospace;
      letter-spacing:.10em; cursor:pointer; backdrop-filter:blur(12px);
      box-shadow:0 8px 30px rgba(0,0,0,.34);
    }
    #${BUTTON_ID}:hover, #${BUTTON_ID}.active { background:rgba(15,75,96,.36); color:#fff; border-color:#65e7ff; }
    #${PANEL_ID} {
      position:fixed; right:18px; top:74px; z-index:2050;
      width:min(440px,calc(100vw - 28px)); max-height:calc(100vh - 185px); overflow:auto;
      color:#eafaff; background:
        radial-gradient(circle at 75% 0%,rgba(27,112,151,.18),transparent 38%),
        linear-gradient(180deg,rgba(5,14,24,.97),rgba(2,7,12,.96));
      border:1px solid rgba(92,218,255,.30); border-radius:12px;
      box-shadow:0 18px 60px rgba(0,0,0,.48); backdrop-filter:blur(15px);
      font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;
    }
    #${PANEL_ID}[hidden]{display:none!important}
    #${PANEL_ID} .sl-head{position:sticky;top:0;z-index:3;display:flex;justify-content:space-between;align-items:center;padding:11px 12px;background:rgba(4,12,20,.94);border-bottom:1px solid rgba(112,222,255,.12);backdrop-filter:blur(12px)}
    #${PANEL_ID} .sl-kicker{color:#65e7ff;font-size:10px;font-weight:800;letter-spacing:.16em}
    #${PANEL_ID} .sl-small{color:rgba(212,238,248,.46);font-size:8px;margin-top:3px}
    #${PANEL_ID} button{font:inherit}
    #${PANEL_ID} .sl-close{border:0;background:transparent;color:#9cbfcd;font-size:20px;cursor:pointer}
    #${PANEL_ID} .sl-body{padding:11px 12px 13px}
    #${PANEL_ID} .sl-next{border:1px solid rgba(95,225,255,.15);background:rgba(255,255,255,.025);border-radius:10px;padding:11px;margin-bottom:9px}
    #${PANEL_ID} .sl-countdown{color:#6cecff;font-weight:900;font-size:25px;letter-spacing:.04em;margin:3px 0 8px;text-shadow:0 0 20px rgba(76,220,255,.17)}
    #${PANEL_ID} .sl-name{font-size:14px;font-weight:800;color:#fff;line-height:1.25}
    #${PANEL_ID} .sl-provider{color:#9fc7d6;font-size:9px;margin-top:4px}
    #${PANEL_ID} .sl-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:9px 0}
    #${PANEL_ID} .sl-stat{border:1px solid rgba(122,214,246,.09);border-radius:6px;padding:6px 7px;background:rgba(255,255,255,.016)}
    #${PANEL_ID} .sl-label{color:rgba(196,225,237,.42);font-size:8px;letter-spacing:.11em}
    #${PANEL_ID} .sl-value{color:#eaf9ff;font-size:9px;font-weight:700;margin-top:2px;line-height:1.3}
    #${PANEL_ID} .sl-actions{display:flex;flex-wrap:wrap;gap:6px;margin:9px 0}
    #${PANEL_ID} .sl-action{border:1px solid rgba(97,219,255,.22);background:rgba(61,159,199,.07);color:#bcefff;border-radius:6px;padding:7px 8px;font-size:9px;cursor:pointer}
    #${PANEL_ID} .sl-action:hover{background:rgba(61,159,199,.18);border-color:rgba(97,219,255,.48);color:#fff}
    #${PANEL_ID} .sl-action.warn{border-color:rgba(255,201,90,.25);color:#ffd97f}
    #${PANEL_ID} .sl-section{display:flex;justify-content:space-between;color:#6edfff;font-size:9px;font-weight:800;letter-spacing:.13em;margin:11px 0 5px}
    #${PANEL_ID} .sl-list{border-top:1px solid rgba(114,211,246,.10)}
    #${PANEL_ID} .sl-row{width:100%;display:grid;grid-template-columns:58px 1fr auto;gap:8px;align-items:center;text-align:left;border:0;border-bottom:1px solid rgba(114,211,246,.07);background:transparent;color:#dff7ff;padding:7px 3px;cursor:pointer}
    #${PANEL_ID} .sl-row:hover,#${PANEL_ID} .sl-row.active{background:rgba(64,174,218,.07)}
    #${PANEL_ID} .sl-row-time{color:#6ee5ff;font-size:8px;font-weight:800}
    #${PANEL_ID} .sl-row strong{display:block;font-size:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .sl-row small{display:block;color:#789ba9;font-size:8px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #${PANEL_ID} .sl-row-chevron{color:#5b8999}
    #${PANEL_ID} .sl-note{color:rgba(192,221,232,.42);font-size:8px;line-height:1.45;margin-top:9px}
    #${PANEL_ID} .sl-replay{border:1px solid rgba(99,231,255,.15);border-radius:8px;padding:7px 8px;background:rgba(8,32,43,.31);margin-top:7px}
    #${PANEL_ID} .sl-replay[hidden]{display:none}
    #${PANEL_ID} .sl-replay-state{color:#7ceeff;font-size:9px;font-weight:800}
    #${PANEL_ID} .sl-speed{width:100%;margin-top:6px}
    @media(max-width:800px){
      #${BUTTON_ID}{right:12px;bottom:75px}
      #${PANEL_ID}{right:12px;top:64px;max-height:calc(100vh - 150px)}
    }
  `;
  document.head.appendChild(style);
}

function createUi(onToggle, onAction) {
  ensureStyles();
  let button = document.getElementById(BUTTON_ID);
  if (!button) {
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.innerHTML = '🚀 <span>LAUNCH MODE</span>';
    button.addEventListener('click', onToggle);
    document.body.appendChild(button);
  }

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    panel.hidden = true;
    panel.innerHTML = `
      <div class="sl-head">
        <div><div class="sl-kicker">🚀 SPACE LAUNCH MODE</div><div class="sl-small">MISSION CONTROL · UPCOMING 30 DAYS</div></div>
        <button type="button" class="sl-close" data-sl-action="close">×</button>
      </div>
      <div class="sl-body">
        <div class="sl-next">
          <div class="sl-label">SELECTED / NEXT LAUNCH</div>
          <div class="sl-countdown" data-sl-countdown>T− --</div>
          <div class="sl-name" data-sl-name>Loading launch schedule…</div>
          <div class="sl-provider" data-sl-provider></div>
          <div class="sl-grid">
            <div class="sl-stat"><div class="sl-label">LAUNCH SITE</div><div class="sl-value" data-sl-site>—</div></div>
            <div class="sl-stat"><div class="sl-label">STATUS</div><div class="sl-value" data-sl-status>—</div></div>
            <div class="sl-stat"><div class="sl-label">LOCAL TIME</div><div class="sl-value" data-sl-local>—</div></div>
            <div class="sl-stat"><div class="sl-label">TARGET ORBIT</div><div class="sl-value" data-sl-orbit>—</div></div>
          </div>
          <div class="sl-actions">
            <button class="sl-action" data-sl-action="focus">FOCUS PAD</button>
            <button class="sl-action" data-sl-action="simulate">SIMULATE ASCENT</button>
            <button class="sl-action" data-sl-action="refresh">REFRESH</button>
            <button class="sl-action warn" data-sl-action="recent">RECENT MISSIONS</button>
          </div>
          <div class="sl-replay" data-sl-replay hidden>
            <div class="sl-replay-state" data-sl-replay-state>RECONSTRUCTED ASCENT</div>
            <div class="sl-actions">
              <button class="sl-action" data-sl-action="pause">PAUSE</button>
              <button class="sl-action" data-sl-action="stop">STOP</button>
            </div>
            <input class="sl-speed" data-sl-speed type="range" min="0.25" max="4" value="1" step="0.25" aria-label="Simulation speed">
          </div>
        </div>
        <div class="sl-section"><span>UPCOMING LAUNCHES</span><span data-sl-count>—</span></div>
        <div class="sl-list" data-sl-list></div>
        <div class="sl-note">
          Schedule data: Launch Library 2. Countdown follows the published NET time and can change.
          Ascent/orbit graphics are reconstructed estimates unless the source explicitly provides trajectory data.
          This is not live rocket telemetry.
        </div>
      </div>`;
    panel.addEventListener('click', onAction);
    document.body.appendChild(panel);
  }
  return { button, panel };
}

function makeBillboardCanvas() {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  ctx.strokeStyle = '#22e6e6'; ctx.fillStyle = 'rgba(34,230,230,.18)';
  ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(32,32,16,0,Math.PI*2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(32,5); ctx.lineTo(32,20); ctx.moveTo(32,44); ctx.lineTo(32,59);
  ctx.moveTo(5,32); ctx.lineTo(20,32); ctx.moveTo(44,32); ctx.lineTo(59,32); ctx.stroke();
  return canvas;
}

export function initSpaceLaunchMode({ viewer, dataManager = null } = {}) {
  if (!viewer?.scene) throw new Error('Space Launch Mode requires Cesium Viewer');

  const source = new Cesium.CustomDataSource(DATA_SOURCE_ID);
  viewer.dataSources.add(source);
  source.show = false;

  let launches = [];
  let selected = null;
  let open = false;
  let destroyed = false;
  let refreshPromise = null;
  let timer = null;
  let replay = null;
  let preUpdateRemover = null;
  const markerImage = makeBillboardCanvas();

  const ui = createUi(
    () => setOpen(!open),
    (event) => {
      const button = event.target.closest?.('[data-sl-action]');
      if (button) handleAction(button.dataset.slAction);
      const row = event.target.closest?.('[data-sl-index]');
      if (row) selectLaunch(Number(row.dataset.slIndex), true);
    },
  );

  function setOpen(value) {
    open = Boolean(value);
    ui.panel.hidden = !open;
    ui.button.classList.toggle('active', open);
    source.show = open;
    if (open) {
      if (!launches.length) void refresh();
      render();
    } else {
      stopReplay();
    }
    governorRequestRender('space-launch-toggle');
  }

  function renderMarkers() {
    source.entities.removeAll();
    if (!open) return;
    for (const [index, launch] of launches.entries()) {
      if (!Number.isFinite(launch.lat) || !Number.isFinite(launch.lon)) continue;
      const isSelected = selected?.id === launch.id;
      source.entities.add({
        id: `upcoming-launch:${launch.id}`,
        position: Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat, 30),
        billboard: {
          image: markerImage,
          width: isSelected ? 34 : 22,
          height: isSelected ? 34 : 22,
          color: isSelected ? Cesium.Color.WHITE : Cesium.Color.WHITE.withAlpha(0.72),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
        label: isSelected ? {
          text: compact(launch.name, 30).toUpperCase(),
          font: '11px monospace',
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 3,
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          pixelOffset: new Cesium.Cartesian2(0, -28),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        } : undefined,
        properties: { launchIndex: index, launchId: launch.id },
      });
    }
    drawSelectedPath();
  }

  function drawSelectedPath() {
    if (!selected || !Number.isFinite(selected.lat) || !Number.isFinite(selected.lon)) return;
    const launch = selected;
    let orbit = approximateOrbitPath(launch);
    if (!orbit?.length) {
      // Unknown target orbit: show ascent only to a conservative 350 km eastward endpoint.
      const lon = launch.lon + 8 / Math.max(0.25, Math.cos(Cesium.Math.toRadians(launch.lat)));
      orbit = [Cesium.Cartesian3.fromDegrees(lon, launch.lat, 350000)];
    }
    const insertion = orbit[0];
    const pad = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat, 0);
    const ascent = reconstructedAscentPath(pad, insertion, 180);

    source.entities.add({
      id: `upcoming-ascent:${launch.id}`,
      polyline: {
        positions: ascent,
        width: 2.2,
        material: new Cesium.PolylineDashMaterialProperty({
          color: GREEN.withAlpha(.85),
          dashLength: 18,
        }),
        arcType: Cesium.ArcType.NONE,
      },
    });
    if (orbit.length > 2) {
      source.entities.add({
        id: `upcoming-orbit:${launch.id}`,
        polyline: {
          positions: orbit,
          width: 1.7,
          material: new Cesium.PolylineDashMaterialProperty({
            color: PURPLE.withAlpha(.72),
            dashLength: 22,
          }),
          arcType: Cesium.ArcType.NONE,
        },
      });
    }
  }

  function render() {
    const launch = selected || launches[0] || null;
    const now = Date.now();
    const ms = launch?.launchTime ? dateMs(launch.launchTime) - now : NaN;

    ui.panel.querySelector('[data-sl-countdown]').textContent = launch ? formatCountdown(ms) : 'T− --';
    ui.panel.querySelector('[data-sl-name]').textContent = launch?.name || (refreshPromise ? 'Loading launch schedule…' : 'No upcoming launches found');
    ui.panel.querySelector('[data-sl-provider]').textContent = launch ? launch.provider : '';
    ui.panel.querySelector('[data-sl-site]').textContent = launch?.launchSite || '—';
    ui.panel.querySelector('[data-sl-status]').textContent = launch?.status || '—';
    ui.panel.querySelector('[data-sl-local]').textContent = launch ? formatLocalTime(launch.launchTime) : '—';
    ui.panel.querySelector('[data-sl-orbit]').textContent = launch ? orbitName(launch) : '—';
    ui.panel.querySelector('[data-sl-count]').textContent = `${launches.length} / 30D`;

    const list = ui.panel.querySelector('[data-sl-list]');
    list.innerHTML = launches.slice(0, 14).map((item, index) => {
      const diff = dateMs(item.launchTime) - now;
      const hours = Math.max(0, diff / 3600000);
      const time = hours < 24 ? `${hours.toFixed(1)}H` : `${Math.floor(hours / 24)}D`;
      return `<button type="button" class="sl-row ${selected?.id === item.id ? 'active' : ''}" data-sl-index="${index}">
        <span class="sl-row-time">${escapeHtml(time)}</span>
        <span><strong>${escapeHtml(compact(item.name, 34))}</strong><small>${escapeHtml(compact(item.provider, 22))} · ${escapeHtml(formatLocalTime(item.launchTime))}</small></span>
        <span class="sl-row-chevron">›</span>
      </button>`;
    }).join('') || '<div class="sl-note">No upcoming launches in the current feed.</div>';

    const replayBox = ui.panel.querySelector('[data-sl-replay]');
    replayBox.hidden = !replay;
    if (replay) {
      ui.panel.querySelector('[data-sl-replay-state]').textContent =
        replay.paused ? 'PAUSED · RECONSTRUCTED ASCENT' : 'RECONSTRUCTED ASCENT · CAMERA FOLLOW';
      const pauseButton = ui.panel.querySelector('[data-sl-action="pause"]');
      if (pauseButton) pauseButton.textContent = replay.paused ? 'PLAY' : 'PAUSE';
    }
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      try {
        const response = await fetch(API_URL, { cache: 'no-store' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const rows = Array.isArray(payload) ? payload : payload?.results;
        if (!Array.isArray(rows)) throw new Error('Malformed launch response');
        launches = rows.map(normalizeLaunch)
          .filter((launch) => (
            launch.launchTime
            && dateMs(launch.launchTime) >= Date.now() - 5 * 60_000
            && Number.isFinite(launch.lat)
            && Number.isFinite(launch.lon)
          ))
          .sort((a,b) => dateMs(a.launchTime) - dateMs(b.launchTime));
        if (!selected || !launches.some((item) => item.id === selected.id)) selected = launches[0] || null;
        renderMarkers();
        render();
      } catch (error) {
        console.warn('[SpaceLaunch] upcoming launch fetch failed:', error);
        ui.panel.querySelector('[data-sl-name]').textContent = 'Launch schedule unavailable';
        ui.panel.querySelector('[data-sl-provider]').textContent = error.message;
      } finally {
        refreshPromise = null;
      }
    })();
    return refreshPromise;
  }

  function selectLaunch(index, focus = false) {
    const launch = launches[index];
    if (!launch) return false;
    stopReplay();
    selected = launch;
    renderMarkers();
    render();
    if (focus) focusPad();
    return true;
  }

  function focusPad() {
    const launch = selected || launches[0];
    if (!launch) return false;
    stopReplay();
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat, 16000),
      orientation: {
        heading: Cesium.Math.toRadians(18),
        pitch: Cesium.Math.toRadians(-48),
        roll: 0,
      },
      duration: 2.3,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
    return true;
  }

  function startReplay() {
    const launch = selected || launches[0];
    if (!launch) return false;
    stopReplay();

    // Release our other optional camera add-on if it is currently active.
    try { window.__godsEyeView?.cinematicTracking?.stop?.({ clearSelection: false }); } catch {}

    let orbit = approximateOrbitPath(launch);
    if (!orbit?.length) {
      const lon = launch.lon + 8 / Math.max(.25, Math.cos(Cesium.Math.toRadians(launch.lat)));
      orbit = [Cesium.Cartesian3.fromDegrees(lon, launch.lat, 350000)];
    }
    const pad = Cesium.Cartesian3.fromDegrees(launch.lon, launch.lat, 0);
    const ascent = reconstructedAscentPath(pad, orbit[0], 300);

    replay = {
      launch,
      ascent,
      orbit,
      startedAt: performance.now(),
      paused: false,
      pausedAt: null,
      accumulatedPauseMs: 0,
      speed: Number(ui.panel.querySelector('[data-sl-speed]')?.value) || 1,
      heading: replayInitialCameraHeading(ascent),
      vehicle: source.entities.add({
        id: `upcoming-sim-vehicle:${launch.id}`,
        position: ascent[0],
        point: {
          pixelSize: 10,
          color: CYAN,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      }),
    };

    holdContinuousRender('space-launch-replay');
    viewer.camera.cancelFlight();
    render();
    return true;
  }

  function stopReplay() {
    if (!replay) return false;
    source.entities.removeById(`upcoming-sim-vehicle:${replay.launch.id}`);
    replay = null;
    releaseContinuousRender('space-launch-replay');
    try { viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY); } catch {}
    render();
    governorRequestRender('space-launch-replay-stop');
    return true;
  }

  function togglePause() {
    if (!replay) return false;
    if (!replay.paused) {
      replay.paused = true;
      replay.pausedAt = performance.now();
    } else {
      replay.paused = false;
      if (Number.isFinite(replay.pausedAt)) {
        replay.accumulatedPauseMs += performance.now() - replay.pausedAt;
      }
      replay.pausedAt = null;
    }
    render();
    return true;
  }

  function updateReplay() {
    if (!replay || replay.paused) return;
    const now = performance.now();
    replay.speed = Number(ui.panel.querySelector('[data-sl-speed]')?.value) || replay.speed || 1;
    const elapsed = Math.max(0, (now - replay.startedAt - replay.accumulatedPauseMs) / 1000 * replay.speed);
    const ascentDuration = 28;
    const orbitDuration = 35;
    const total = ascentDuration + orbitDuration;
    const loopElapsed = elapsed % total;
    const ascending = loopElapsed < ascentDuration;
    const progress = ascending
      ? loopElapsed / ascentDuration
      : (loopElapsed - ascentDuration) / orbitDuration;
    const path = ascending ? replay.ascent : replay.orbit;
    if (!path?.length) return;
    const position = samplePath(path, progress);
    if (!position) return;

    replay.vehicle.position = new Cesium.ConstantPositionProperty(position);

    const cartographic = Cesium.Cartographic.fromCartesian(position);
    const altitude = cartographic?.height || 0;
    const view = replayCameraView({ ascending, phaseProgress: progress }, altitude);

    let tangent = samplePath(path, Math.min(1, progress + .012));
    if (!tangent) tangent = position;

    // The helper returns a robust path bearing. For our schedule-based simulation
    // we keep the same rear-quarter chase concept as Space Missions.
    const current = Cesium.Cartographic.fromCartesian(position);
    const next = Cesium.Cartographic.fromCartesian(tangent);
    let pathHeading = replay.heading;
    if (current && next) {
      const geodesic = new Cesium.EllipsoidGeodesic(current, next);
      if (Number.isFinite(geodesic.startHeading)) pathHeading = geodesic.startHeading;
    }
    const desired = replayChaseCameraHeading(pathHeading, ascending ? 0 : progress);
    replay.heading = smoothReplayCameraHeading(replay.heading, desired, Cesium.Math.toRadians(2.5));

    viewer.camera.lookAt(
      position,
      new Cesium.HeadingPitchRange(replay.heading, view.pitch, view.range),
    );

    const state = ui.panel.querySelector('[data-sl-replay-state]');
    if (state) {
      state.textContent = ascending
        ? `RECONSTRUCTED ASCENT · T+${Math.floor(loopElapsed)}s`
        : `PROJECTED ORBIT · T+${Math.floor(loopElapsed)}s`;
    }
  }

  async function openRecentMissions() {
    try {
      await dataManager?.setEnabled?.('rocket-launches', true);
    } catch (error) {
      console.warn('[SpaceLaunch] Could not enable recent Space Missions:', error);
    }
  }

  function handleAction(action) {
    if (action === 'close') setOpen(false);
    else if (action === 'focus') focusPad();
    else if (action === 'simulate') startReplay();
    else if (action === 'refresh') void refresh();
    else if (action === 'pause') togglePause();
    else if (action === 'stop') stopReplay();
    else if (action === 'recent') void openRecentMissions();
  }

  function onClick(movement) {
    if (!open || replay) return;
    const picked = viewer.scene.drillPick(movement.position, 12)
      .map((entry) => entry?.id)
      .find((entity) => String(entity?.id || '').startsWith('upcoming-launch:'));
    if (!picked) return;
    const launchId = String(picked.id).slice('upcoming-launch:'.length);
    const index = launches.findIndex((item) => item.id === launchId);
    if (index >= 0) selectLaunch(index, true);
  }

  const clickHandler = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clickHandler.setInputAction(onClick, Cesium.ScreenSpaceEventType.LEFT_CLICK);
  preUpdateRemover = viewer.scene.preUpdate.addEventListener(updateReplay);

  function onKey(event) {
    if (event.key.toLowerCase() === 'l' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      setOpen(!open);
    }
    if (event.key === 'Escape' && replay) {
      event.preventDefault();
      stopReplay();
    }
  }
  window.addEventListener('keydown', onKey);

  timer = setInterval(() => {
    if (open) render();
  }, 1000);

  return Object.freeze({
    open() { setOpen(true); },
    close() { setOpen(false); },
    toggle() { setOpen(!open); },
    refresh,
    focusPad,
    simulate: startReplay,
    stopReplay,
    getUpcoming() { return launches.map((item) => ({ ...item })); },
    getSelected() { return selected ? { ...selected } : null; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stopReplay();
      clearInterval(timer);
      window.removeEventListener('keydown', onKey);
      clickHandler.destroy();
      preUpdateRemover?.();
      viewer.dataSources.remove(source, true);
      ui.panel.remove();
      ui.button.remove();
      document.getElementById(STYLE_ID)?.remove();
    },
  });
}

export default initSpaceLaunchMode;
