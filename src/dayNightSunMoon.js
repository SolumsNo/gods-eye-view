import * as Cesium from 'cesium';

/**
 * SOLUMS SKYNET SPYSAT — DAY/NIGHT + SUN/MOON SIMULATOR v1.4
 *
 * MAP-SAFE DESIGN
 * - Does NOT modify Google Photorealistic 3D selection
 * - Does NOT touch Visual Presets
 * - Does NOT add/remove/reorder imagery layers
 * - Does NOT hide/show or restyle 3D tilesets
 *
 * It temporarily owns only:
 * - Cesium clock while simulation is enabled
 * - globe lighting / shadow switches
 * - Viewer shadows
 * - its own CustomDataSource (terminator + Sun/Moon ground markers)
 *
 * All clock/lighting/shadow state is snapshotted and restored on SIMULATION OFF.
 */

const PANEL_ID = 'sz-day-night-panel';
const BUTTON_ID = 'sz-day-night-button';
const STYLE_ID = 'sz-day-night-style';
const SOURCE_NAME = 'Solums Skynet Spysat Day Night Simulator';

const SPEEDS = [1, 60, 600, 3600, 14400];

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const deg = r => Cesium.Math.toDegrees(r);
const rad = d => Cesium.Math.toRadians(d);

function cloneJulian(v) {
  return v ? Cesium.JulianDate.clone(v, new Cesium.JulianDate()) : null;
}

function pad2(n) {
  return String(Math.floor(Math.abs(n))).padStart(2, '0');
}

function utcDateString(jd) {
  const d = Cesium.JulianDate.toDate(jd);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth()+1)}-${pad2(d.getUTCDate())}`;
}

function utcTimeString(jd) {
  const d = Cesium.JulianDate.toDate(jd);
  return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())} UTC`;
}

function dateInputNow() {
  return new Date().toISOString().slice(0, 10);
}

function julianFromDateAndMinutes(dateString, minutes) {
  const base = new Date(`${dateString}T00:00:00.000Z`);
  base.setUTCMinutes(clamp(Number(minutes)||0, 0, 1439.999));
  return Cesium.JulianDate.fromDate(base);
}

function minutesOfUtcDay(jd) {
  const d = Cesium.JulianDate.toDate(jd);
  return d.getUTCHours()*60 + d.getUTCMinutes() + d.getUTCSeconds()/60;
}

function mapCenter(viewer) {
  const canvas = viewer.scene.canvas;
  const p = new Cesium.Cartesian2(canvas.clientWidth/2, canvas.clientHeight/2);
  let cart = null;
  try {
    const ray = viewer.camera.getPickRay(p);
    cart = ray ? viewer.scene.globe?.pick(ray, viewer.scene) : null;
  } catch {}
  if (!cart) {
    try { cart = viewer.camera.pickEllipsoid(p, viewer.scene.globe.ellipsoid); } catch {}
  }
  if (!cart) {
    const c = viewer.camera.positionCartographic;
    if (!c) return null;
    return {
      lat: deg(c.latitude),
      lon: deg(c.longitude),
      height: Number(c.height)||0,
      cartesian: Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, Math.max(0, Number(c.height)||0))
    };
  }
  const c = Cesium.Cartographic.fromCartesian(cart);
  return {
    lat: deg(c.latitude),
    lon: deg(c.longitude),
    height: Number(c.height)||0,
    cartesian: cart
  };
}

function normalizeDegrees180(v) {
  let x = ((v + 180) % 360 + 360) % 360 - 180;
  if (x === -180) x = 180;
  return x;
}

function approximateSunSubpoint(time) {
  // NOAA-style solar coordinates. This gives a stable Earth-fixed Sun
  // direction immediately, without waiting for ICRF Earth-orientation data.
  const d = Cesium.JulianDate.toDate(time);
  const jd = d.getTime() / 86400000 + 2440587.5;
  const T = (jd - 2451545.0) / 36525.0;

  let L0 = 280.46646 + T * (36000.76983 + 0.0003032 * T);
  L0 = ((L0 % 360) + 360) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const Mr = rad(M);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);

  const C =
    Math.sin(Mr) * (1.914602 - T * (0.004817 + 0.000014 * T))
    + Math.sin(2 * Mr) * (0.019993 - 0.000101 * T)
    + Math.sin(3 * Mr) * 0.000289;

  const trueLong = L0 + C;
  const omega = 125.04 - 1934.136 * T;
  const lambda = trueLong - 0.00569 - 0.00478 * Math.sin(rad(omega));

  const eps0 =
    23
    + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * Math.cos(rad(omega));

  const decl = deg(Math.asin(Math.sin(rad(eps)) * Math.sin(rad(lambda))));

  const y = Math.tan(rad(eps) / 2) ** 2;
  const eqTime = 4 * deg(
    y * Math.sin(2 * rad(L0))
    - 2 * e * Math.sin(Mr)
    + 4 * e * y * Math.sin(Mr) * Math.cos(2 * rad(L0))
    - 0.5 * y * y * Math.sin(4 * rad(L0))
    - 1.25 * e * e * Math.sin(2 * Mr)
  );

  const utcMinutes =
    d.getUTCHours() * 60
    + d.getUTCMinutes()
    + d.getUTCSeconds() / 60
    + d.getUTCMilliseconds() / 60000;

  const lon = normalizeDegrees180((720 - utcMinutes - eqTime) / 4);
  return { lat: decl, lon };
}

function solarDirectionFixed(time) {
  const p = approximateSunSubpoint(time);
  const v = Cesium.Cartesian3.fromDegrees(p.lon, p.lat, 100000000);
  return Cesium.Cartesian3.normalize(v, v);
}

async function preloadIcrfForDay(time) {
  try {
    const start = Cesium.JulianDate.addDays(time, -2, new Cesium.JulianDate());
    const stop = Cesium.JulianDate.addDays(time, 2, new Cesium.JulianDate());
    await Cesium.Transforms.preloadIcrfFixed(new Cesium.TimeInterval({ start, stop }));
  } catch {}
}

function fixedBodyVectors(time) {
  const sunI = Cesium.Simon1994PlanetaryPositions.computeSunPositionInEarthInertialFrame(time);
  const moonI = Cesium.Simon1994PlanetaryPositions.computeMoonPositionInEarthInertialFrame(time);

  // Sun is available immediately and is also what the global night shader uses.
  const sun = solarDirectionFixed(time);

  // Moon uses the correct ICRF -> Earth-fixed transform. No TEME fallback:
  // TEME is a different inertial frame and produced visibly wrong subpoints.
  let moon = null;
  try {
    const m = Cesium.Transforms.computeIcrfToFixedMatrix(time);
    if (m) moon = Cesium.Matrix3.multiplyByVector(m, moonI, new Cesium.Cartesian3());
  } catch {}

  return { sun, moon, sunI, moonI };
}

function bodySubpoint(bodyFixed) {
  if (!bodyFixed) return null;
  const dir = Cesium.Cartesian3.normalize(bodyFixed, new Cesium.Cartesian3());
  const surfaceGuess = Cesium.Cartesian3.multiplyByScalar(
    dir,
    Cesium.Ellipsoid.WGS84.maximumRadius * 1.02,
    new Cesium.Cartesian3()
  );
  const surface = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(
    surfaceGuess,
    new Cesium.Cartesian3()
  );
  if (!surface) return null;
  const c = Cesium.Cartographic.fromCartesian(surface);
  return { lat: deg(c.latitude), lon: deg(c.longitude), cartesian: surface };
}

function localAzEl(observer, target) {
  if (!observer?.cartesian || !target) return null;

  const ellipsoid = Cesium.Ellipsoid.WGS84;
  const surface = ellipsoid.scaleToGeodeticSurface(
    observer.cartesian,
    new Cesium.Cartesian3()
  ) || observer.cartesian;

  const up = ellipsoid.geodeticSurfaceNormal(surface, new Cesium.Cartesian3());
  let east = Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_Z, up, new Cesium.Cartesian3());

  if (Cesium.Cartesian3.magnitudeSquared(east) < 1e-10) {
    east = Cesium.Cartesian3.cross(Cesium.Cartesian3.UNIT_X, up, east);
  }
  Cesium.Cartesian3.normalize(east, east);
  const north = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(up, east, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  const dir = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, surface, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  const e = Cesium.Cartesian3.dot(dir, east);
  const n = Cesium.Cartesian3.dot(dir, north);
  const u = clamp(Cesium.Cartesian3.dot(dir, up), -1, 1);

  let az = deg(Math.atan2(e, n));
  if (az < 0) az += 360;
  const el = deg(Math.asin(u));
  return { az, el };
}

function twilightLabel(sunElevation) {
  if (!Number.isFinite(sunElevation)) return '—';
  if (sunElevation >= 0) return 'DAYLIGHT';
  if (sunElevation >= -6) return 'CIVIL TWILIGHT';
  if (sunElevation >= -12) return 'NAUTICAL TWILIGHT';
  if (sunElevation >= -18) return 'ASTRONOMICAL TWILIGHT';
  return 'ASTRONOMICAL NIGHT';
}

function moonIllumination(sunI, moonI) {
  if (!sunI || !moonI) return null;
  const a = Cesium.Cartesian3.normalize(sunI, new Cesium.Cartesian3());
  const b = Cesium.Cartesian3.normalize(moonI, new Cesium.Cartesian3());
  const cos = clamp(Cesium.Cartesian3.dot(a, b), -1, 1);
  return clamp((1 - cos) / 2, 0, 1);
}

function moonPhaseLabel(f) {
  if (!Number.isFinite(f)) return '—';
  if (f < .03) return 'NEW MOON';
  if (f < .35) return 'CRESCENT';
  if (f < .65) return 'QUARTER';
  if (f < .97) return 'GIBBOUS';
  return 'FULL MOON';
}

function solarTime(lon, jd) {
  const d = Cesium.JulianDate.toDate(jd);
  const utc = d.getUTCHours() + d.getUTCMinutes()/60 + d.getUTCSeconds()/3600;
  let hours = (utc + lon/15) % 24;
  if (hours < 0) hours += 24;
  const h = Math.floor(hours);
  const m = Math.floor((hours-h)*60);
  return `${pad2(h)}:${pad2(m)} approx. solar`;
}

function terminatorPositions(sunFixed) {
  if (!sunFixed) return [];
  const s = Cesium.Cartesian3.normalize(sunFixed, new Cesium.Cartesian3());
  let axis = Math.abs(Cesium.Cartesian3.dot(s, Cesium.Cartesian3.UNIT_Z)) < .85
    ? Cesium.Cartesian3.UNIT_Z
    : Cesium.Cartesian3.UNIT_X;

  const u = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(s, axis, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );
  const v = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(s, u, new Cesium.Cartesian3()),
    new Cesium.Cartesian3()
  );

  const out = [];
  const ellipsoid = Cesium.Ellipsoid.WGS84;

  for (let angle=0; angle<=360; angle+=3) {
    const a = rad(angle);
    const dir = Cesium.Cartesian3.add(
      Cesium.Cartesian3.multiplyByScalar(u, Math.cos(a), new Cesium.Cartesian3()),
      Cesium.Cartesian3.multiplyByScalar(v, Math.sin(a), new Cesium.Cartesian3()),
      new Cesium.Cartesian3()
    );
    Cesium.Cartesian3.normalize(dir, dir);
    const guess = Cesium.Cartesian3.multiplyByScalar(
      dir,
      ellipsoid.maximumRadius * 1.05,
      new Cesium.Cartesian3()
    );
    let surface = ellipsoid.scaleToGeodeticSurface(guess, new Cesium.Cartesian3());
    if (!surface) continue;
    surface = Cesium.Cartesian3.multiplyByScalar(surface, 1.00035, surface);
    out.push(surface);
  }
  return out;
}




function smoothstep(edge0, edge1, x) {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

function screenNightAlpha(solarDot, darkness) {
  // solarDot = sin(solar elevation) for a spherical Earth approximation.
  // Convert twilight thresholds to dot products:
  const d0  = Math.sin(rad(0));
  const d6  = Math.sin(rad(-6));
  const d12 = Math.sin(rad(-12));
  const d18 = Math.sin(rad(-18));

  const target = clamp(darkness, 0.35, 0.95);

  if (solarDot >= d0) return 0;

  if (solarDot >= d6) {
    const t = 1 - smoothstep(d6, d0, solarDot);
    return target * 0.20 * t;
  }

  if (solarDot >= d12) {
    const t = 1 - smoothstep(d12, d6, solarDot);
    return target * (0.20 + 0.20 * t);
  }

  if (solarDot >= d18) {
    const t = 1 - smoothstep(d18, d12, solarDot);
    return target * (0.40 + 0.28 * t);
  }

  const deep = clamp((-solarDot - Math.abs(d18)) / 0.42, 0, 1);
  return target * (0.68 + 0.32 * deep);
}

function screenNightTint(alpha) {
  // Deep blue-black rather than neutral black preserves terrain detail.
  const a = clamp(alpha, 0, 0.96);
  return [2, 8, 20, Math.round(a * 255)];
}

function ensureStyle() {
  document.getElementById(STYLE_ID)?.remove();
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
#${BUTTON_ID}{position:fixed;right:18px;bottom:360px;z-index:2060;border:1px solid rgba(101,224,255,.34);border-radius:9px;background:rgba(4,13,22,.93);color:#ccf8ff;padding:9px 11px;font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.11em;cursor:pointer;backdrop-filter:blur(12px)}
#${BUTTON_ID}.active,#${BUTTON_ID}:hover{border-color:#72ecff;background:rgba(23,93,120,.38);color:#fff}
#${PANEL_ID}{position:fixed;right:18px;top:72px;z-index:2059;width:min(510px,calc(100vw - 30px));max-height:calc(100vh - 145px);overflow:auto;border:1px solid rgba(91,220,255,.26);border-radius:13px;background:linear-gradient(180deg,rgba(4,13,22,.975),rgba(2,7,12,.975));color:#eafaff;box-shadow:0 20px 64px rgba(0,0,0,.48);backdrop-filter:blur(15px);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#${PANEL_ID}[hidden]{display:none!important}
#${PANEL_ID} .head{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:11px 12px;background:rgba(4,13,21,.96);border-bottom:1px solid rgba(97,220,255,.11)}
#${PANEL_ID} .title{font-size:10px;font-weight:900;letter-spacing:.16em;color:#72eaff}
#${PANEL_ID} .sub{font-size:8px;color:rgba(205,235,246,.46);margin-top:3px}
#${PANEL_ID} button{font:inherit} #${PANEL_ID} .close{border:0;background:transparent;color:#91b6c3;font-size:20px;cursor:pointer}
#${PANEL_ID} .body{padding:12px}
#${PANEL_ID} .safe{border:1px solid rgba(78,235,170,.17);border-radius:8px;padding:7px;color:#86f1c3;background:rgba(31,137,91,.06);font-size:8px;line-height:1.45}
#${PANEL_ID} .master{display:grid;grid-template-columns:1fr auto;align-items:center;gap:8px;margin-top:10px;padding:9px;border:1px solid rgba(97,219,250,.13);border-radius:8px;background:rgba(255,255,255,.015)}
#${PANEL_ID} .master-state{font-size:11px;font-weight:900;color:#91aeb8} #${PANEL_ID} .master-state.on{color:#83f1c0}
#${PANEL_ID} .section{margin-top:11px} #${PANEL_ID} .sect{display:flex;justify-content:space-between;gap:8px;color:#6de7ff;font-size:8px;font-weight:900;letter-spacing:.13em;margin-bottom:6px}
#${PANEL_ID} .actions{display:flex;gap:6px;flex-wrap:wrap}
#${PANEL_ID} .action{border:1px solid rgba(92,219,249,.18);background:rgba(48,153,191,.07);color:#bceef8;border-radius:6px;padding:8px 9px;font-size:8px;cursor:pointer}
#${PANEL_ID} .action.active,#${PANEL_ID} .action:hover{border-color:rgba(104,230,255,.55);background:rgba(48,153,191,.18);color:#fff}
#${PANEL_ID} .danger{border-color:rgba(255,115,88,.26);color:#ffc0b3}
#${PANEL_ID} input[type=range]{width:100%;margin:6px 0} #${PANEL_ID} input[type=date]{background:#06131d;color:#daf7ff;border:1px solid rgba(96,220,250,.18);border-radius:5px;padding:6px;font:9px ui-monospace}
#${PANEL_ID} .time-big{font-size:24px;font-weight:900;color:#f3fbff;letter-spacing:.04em}
#${PANEL_ID} .range{display:flex;justify-content:space-between;color:#6e929f;font-size:7px}
#${PANEL_ID} .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
#${PANEL_ID} .stat{border:1px solid rgba(100,213,245,.09);border-radius:6px;padding:7px;background:rgba(255,255,255,.015)}
#${PANEL_ID} .label{font-size:7px;color:#6e94a2;letter-spacing:.1em} #${PANEL_ID} .value{font-size:10px;color:#effbff;font-weight:800;margin-top:3px;line-height:1.35}
#${PANEL_ID} .daystate{font-size:15px;font-weight:900;color:#78eaff}
#${PANEL_ID} .speed{min-width:62px}
#${PANEL_ID} .status{font-size:8px;color:#81dff1;line-height:1.45}
#${PANEL_ID} .note{margin-top:10px;font:9px/1.45 system-ui,-apple-system,sans-serif;color:#678793}
@media(max-width:820px){#${BUTTON_ID}{right:12px;bottom:370px}#${PANEL_ID}{right:12px;top:64px;width:calc(100vw - 24px);max-height:calc(100vh - 130px)}}`;
  document.head.appendChild(s);
}

function createUi(togglePanel) {
  ensureStyle();
  let button = document.getElementById(BUTTON_ID);
  if (!button) {
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '☀ DAY / NIGHT';
    document.body.appendChild(button);
  }

  let panel = document.getElementById(PANEL_ID);
  if (!panel) {
    panel = document.createElement('aside');
    panel.id = PANEL_ID;
    document.body.appendChild(panel);
  }

  panel.hidden = true;
  panel.innerHTML = `
<div class="head">
  <div><div class="title">☀ DAY/NIGHT + SUN/MOON</div><div class="sub">SCREEN NIGHT MASK · SHADOWS · SUN/MOON GEOMETRY</div></div>
  <button class="close" data-dn-close>×</button>
</div>
<div class="body">
  <div class="safe">✓ MAP SAFE — kartgrunnlag, Google 3D og Visual Presets blir aldri byttet eller skjult. SIMULATION OFF gjenoppretter klokke og lysinnstillinger.</div>

  <div class="master">
    <div><div class="master-state" data-dn-master-state>SIMULATION OFF</div><div class="sub" data-dn-master-sub>Current God’s Eye clock is untouched.</div></div>
    <button class="action" data-dn-action="master">SIMULATION ON</button>
  </div>

  <div class="section">
    <div class="sect"><span>DATE</span><span data-dn-day>—</span></div>
    <input type="date" data-dn-date>
  </div>

  <div class="section">
    <div class="sect"><span>UTC TIME SLIDER</span><span data-dn-solar>—</span></div>
    <div class="time-big" data-dn-time>—</div>
    <input type="range" min="0" max="1439" value="720" step="1" data-dn-time-slider>
    <div class="range"><span>00:00</span><span>06:00</span><span>12:00</span><span>18:00</span><span>23:59 UTC</span></div>
  </div>

  <div class="section">
    <div class="sect"><span>ANIMATION</span><span data-dn-speed-label>3600×</span></div>
    <div class="actions">
      <button class="action" data-dn-action="play">▶ PLAY</button>
      <button class="action" data-dn-action="pause">❚❚ PAUSE</button>
      <button class="action" data-dn-action="now">NOW</button>
      <button class="action speed" data-dn-action="speed">SPEED 3600×</button>
    </div>
  </div>

  <div class="section">
    <div class="sect"><span>LIGHTING + SHADOWS</span><span>CESIUM SUNLIGHT</span></div>
    <div class="actions">
      <button class="action active" data-dn-action="shadows">SHADOWS ON</button>
      <button class="action" data-dn-action="soft">SOFT SHADOWS OFF</button>
      <button class="action" data-dn-action="terminator">TERMINATOR OFF</button>
    </div>
  </div>

  <div class="section">
    <div class="sect"><span>SCREEN NIGHT MASK</span><span data-dn-band-count>MASK READY</span></div>
    <div class="actions">
      <button class="action active" data-dn-action="nightshade">NIGHT MASK ON</button>
    </div>
    <div class="sect" style="margin-top:8px"><span>NIGHT DARKNESS</span><span data-dn-shade-label>86%</span></div>
    <input type="range" min="35" max="95" value="86" step="1" data-dn-night-darkness>
    <div class="range"><span>LIGHTER NIGHT</span><span>DEEP NIGHT</span></div>
    <div class="status" data-dn-mask-status style="margin-top:7px">CPU SCREEN MASK · waiting for simulation</div>
  </div>

  <div class="section">
    <div class="sect"><span>MAP CENTER</span><span data-dn-coords>—</span></div>
    <div class="grid">
      <div class="stat"><div class="label">LIGHT STATE</div><div class="value daystate" data-dn-light-state>—</div></div>
      <div class="stat"><div class="label">LOCAL SOLAR TIME</div><div class="value" data-dn-local-solar>—</div></div>
      <div class="stat"><div class="label">SUN AZ / ELEV</div><div class="value" data-dn-sun-azel>—</div></div>
      <div class="stat"><div class="label">MOON AZ / ELEV</div><div class="value" data-dn-moon-azel>—</div></div>
    </div>
  </div>

  <div class="section">
    <div class="sect"><span>SUN</span><span>SUBSOLAR POINT</span></div>
    <div class="grid">
      <div class="stat"><div class="label">LAT / LON</div><div class="value" data-dn-sun-sub>—</div></div>
      <div class="stat"><div class="label">DIRECTION AT CENTER</div><div class="value" data-dn-sun-dir>—</div></div>
    </div>
  </div>

  <div class="section">
    <div class="sect"><span>MOON</span><span data-dn-phase>—</span></div>
    <div class="grid">
      <div class="stat"><div class="label">SUBLUNAR LAT / LON</div><div class="value" data-dn-moon-sub>—</div></div>
      <div class="stat"><div class="label">ILLUMINATED</div><div class="value" data-dn-moon-illum>—</div></div>
    </div>
  </div>

  <div class="section">
    <div class="actions">
      <button class="action danger" data-dn-action="restore">RETURN TO LIVE / RESTORE</button>
    </div>
    <div class="status" data-dn-status style="margin-top:7px">Open the simulator without changing time. Press SIMULATION ON to take temporary control of Cesium time and lighting.</div>
  </div>

  <div class="note">
    The Screen Night Mask is a transparent visual canvas above the map and does not change the Google 3D source or Visual Presets. The simulator changes the shared Cesium clock while active. Time-dependent layers such as satellites may therefore move to the simulated time too. RETURN TO LIVE / RESTORE returns the exact clock and lighting state captured before the simulation started.
  </div>
</div>`;

  button.onclick = togglePanel;
  return {button, panel};
}

export function initDayNightSunMoonSimulator({ viewer } = {}) {
  if (!viewer?.scene || !viewer?.clock) throw new Error('Day/Night Simulator requires a Cesium Viewer');

  const ds = new Cesium.CustomDataSource(SOURCE_NAME);
  viewer.dataSources.add(ds);

  let panelOpen = false;
  let simulation = false;
  let snapshot = null;
  let selectedDate = dateInputNow();
  let speedIndex = 3; // 3600×
  let shadowsEnabled = true;
  let softShadows = false;
  let terminatorEnabled = false;
  let lastUiAt = 0;
  let subsolarEntity = null;
  let sublunarEntity = null;
  let terminatorEntity = null;

  let nightShadeEnabled = true;
  let nightDarkness = 0.86;
  let lastNightBuildAt = 0;

  let nightMaskCanvas = null;
  let nightMaskCtx = null;
  let nightMaskImage = null;
  let maskWidth = 0;
  let maskHeight = 0;

  // Low-resolution CPU mask is intentionally scaled up by the browser.
  // At globe scale this is very smooth; at local scale the solar gradient
  // varies so slowly that higher resolution is unnecessary.
  const MASK_LONG_SIDE = 220;

  const ui = createUi(() => panelOpen ? closePanel() : openPanel());
  const dateInput = ui.panel.querySelector('[data-dn-date]');
  const slider = ui.panel.querySelector('[data-dn-time-slider]');
  dateInput.value = selectedDate;

  function status(t) {
    ui.panel.querySelector('[data-dn-status]').textContent = t;
  }

  function ensureNightMaskCanvas() {
    if (nightMaskCanvas) return nightMaskCanvas;

    const c = document.createElement('canvas');
    c.id = 'sz-day-night-screen-mask';
    c.setAttribute('aria-hidden', 'true');
    Object.assign(c.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '0px',
      height: '0px',
      pointerEvents: 'none',
      zIndex: '1500',
      display: 'none',
      opacity: '1',
      mixBlendMode: 'multiply',
      imageRendering: 'auto',
    });

    document.body.appendChild(c);
    nightMaskCanvas = c;
    nightMaskCtx = c.getContext('2d', {
      alpha: true,
      willReadFrequently: false,
    });

    return c;
  }

  function syncNightMaskCanvas() {
    const c = ensureNightMaskCanvas();
    const target = viewer.scene.canvas;
    const r = target.getBoundingClientRect();

    c.style.left = `${Math.round(r.left)}px`;
    c.style.top = `${Math.round(r.top)}px`;
    c.style.width = `${Math.max(1, Math.round(r.width))}px`;
    c.style.height = `${Math.max(1, Math.round(r.height))}px`;

    const aspect = Math.max(0.25, r.width / Math.max(1, r.height));
    if (aspect >= 1) {
      maskWidth = MASK_LONG_SIDE;
      maskHeight = Math.max(70, Math.round(MASK_LONG_SIDE / aspect));
    } else {
      maskHeight = MASK_LONG_SIDE;
      maskWidth = Math.max(70, Math.round(MASK_LONG_SIDE * aspect));
    }

    if (c.width !== maskWidth || c.height !== maskHeight) {
      c.width = maskWidth;
      c.height = maskHeight;
      nightMaskImage = nightMaskCtx.createImageData(maskWidth, maskHeight);
    }

    return { canvas: c, rect: r };
  }

  function hideNightMask() {
    if (nightMaskCanvas) {
      nightMaskCanvas.style.display = 'none';
      if (nightMaskCtx) nightMaskCtx.clearRect(0, 0, nightMaskCanvas.width, nightMaskCanvas.height);
    }
    ui.panel.querySelector('[data-dn-band-count]').textContent = 'MASK OFF';
    ui.panel.querySelector('[data-dn-mask-status]').textContent =
      'CPU SCREEN MASK · disabled';
  }

  function rebuildNightClassification(force = false) {
    const now = performance.now();
    if (!force && now - lastNightBuildAt < 240) return;
    lastNightBuildAt = now;

    if (!simulation || !nightShadeEnabled) {
      hideNightMask();
      updateNightShadeState();
      return;
    }

    const { canvas: overlay, rect } = syncNightMaskCanvas();
    overlay.style.display = 'block';

    const sun = solarDirectionFixed(viewer.clock.currentTime);
    const data = nightMaskImage.data;
    const target = viewer.scene.canvas;
    const ellipsoid = viewer.scene.globe?.ellipsoid || Cesium.Ellipsoid.WGS84;

    let shaded = 0;
    let earthPixels = 0;
    let p = 0;

    // Sample the visible WGS84 ellipsoid. This is independent of Google 3D
    // depth/classification support, which is precisely why v1.4 is robust.
    for (let y = 0; y < maskHeight; y++) {
      const sy = ((y + 0.5) / maskHeight) * target.clientHeight;

      for (let x = 0; x < maskWidth; x++) {
        const sx = ((x + 0.5) / maskWidth) * target.clientWidth;
        let cart = null;

        try {
          cart = viewer.camera.pickEllipsoid(
            new Cesium.Cartesian2(sx, sy),
            ellipsoid
          );
        } catch {}

        if (!cart) {
          data[p++] = 0;
          data[p++] = 0;
          data[p++] = 0;
          data[p++] = 0;
          continue;
        }

        earthPixels++;

        const normal = ellipsoid.geodeticSurfaceNormal(
          cart,
          new Cesium.Cartesian3()
        );
        const solarDot = clamp(
          Cesium.Cartesian3.dot(normal, sun),
          -1,
          1
        );
        const alpha = screenNightAlpha(solarDot, nightDarkness);

        if (alpha > 0.006) shaded++;
        const [r, g, b, a] = screenNightTint(alpha);

        data[p++] = r;
        data[p++] = g;
        data[p++] = b;
        data[p++] = a;
      }
    }

    nightMaskCtx.putImageData(nightMaskImage, 0, 0);

    const pct = earthPixels ? Math.round((shaded / earthPixels) * 100) : 0;
    ui.panel.querySelector('[data-dn-band-count]').textContent =
      `${pct}% VISIBLE EARTH NIGHT`;
    ui.panel.querySelector('[data-dn-mask-status]').textContent =
      `CPU SCREEN MASK · ${maskWidth}×${maskHeight} · ${earthPixels} earth samples`;

    updateNightShadeState();
  }

  function updateNightShadeState() {
    const button = ui.panel.querySelector('[data-dn-action="nightshade"]');
    button.textContent = nightShadeEnabled ? 'NIGHT MASK ON' : 'NIGHT MASK OFF';
    button.classList.toggle('active', nightShadeEnabled);

    ui.panel.querySelector('[data-dn-shade-label]').textContent =
      `${Math.round(nightDarkness * 100)}%`;
  }

  function capture() {
    if (snapshot) return;
    snapshot = {
      currentTime: cloneJulian(viewer.clock.currentTime),
      startTime: cloneJulian(viewer.clock.startTime),
      stopTime: cloneJulian(viewer.clock.stopTime),
      multiplier: viewer.clock.multiplier,
      shouldAnimate: viewer.clock.shouldAnimate,
      clockRange: viewer.clock.clockRange,
      clockStep: viewer.clock.clockStep,
      viewerShadows: viewer.shadows,
      terrainShadows: viewer.terrainShadows,
      globeEnableLighting: viewer.scene.globe?.enableLighting,
      globeDynamicAtmosphereLighting: viewer.scene.globe?.dynamicAtmosphereLighting,
      globeDynamicAtmosphereLightingFromSun: viewer.scene.globe?.dynamicAtmosphereLightingFromSun,
      globeShadows: viewer.scene.globe?.shadows,
      shadowSoft: viewer.shadowMap?.softShadows,
    };
  }

  function applyDayBounds() {
    const start = Cesium.JulianDate.fromDate(new Date(`${selectedDate}T00:00:00.000Z`));
    const stop = Cesium.JulianDate.addDays(start, 1, new Cesium.JulianDate());
    viewer.clock.startTime = cloneJulian(start);
    viewer.clock.stopTime = cloneJulian(stop);
    viewer.clock.clockRange = Cesium.ClockRange.LOOP_STOP;
  }

  function applyLighting() {
    const globe = viewer.scene.globe;
    if (globe) {
      globe.enableLighting = true;
      globe.dynamicAtmosphereLighting = true;
      globe.dynamicAtmosphereLightingFromSun = true;
      if ('shadows' in globe) {
        globe.shadows = shadowsEnabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.RECEIVE_ONLY;
      }
    }

    viewer.shadows = shadowsEnabled;
    if ('terrainShadows' in viewer) {
      viewer.terrainShadows = shadowsEnabled ? Cesium.ShadowMode.ENABLED : Cesium.ShadowMode.RECEIVE_ONLY;
    }
    if (viewer.shadowMap) {
      viewer.shadowMap.softShadows = Boolean(softShadows);
    }
    viewer.scene.requestRender();
  }

  function restore() {
    if (!snapshot) {
      simulation = false;
      renderMaster();
      return false;
    }

    viewer.clock.currentTime = cloneJulian(snapshot.currentTime);
    viewer.clock.startTime = cloneJulian(snapshot.startTime);
    viewer.clock.stopTime = cloneJulian(snapshot.stopTime);
    viewer.clock.multiplier = snapshot.multiplier;
    viewer.clock.shouldAnimate = snapshot.shouldAnimate;
    viewer.clock.clockRange = snapshot.clockRange;
    viewer.clock.clockStep = snapshot.clockStep;

    viewer.shadows = snapshot.viewerShadows;
    if ('terrainShadows' in viewer) viewer.terrainShadows = snapshot.terrainShadows;

    const globe = viewer.scene.globe;
    if (globe) {
      globe.enableLighting = snapshot.globeEnableLighting;
      globe.dynamicAtmosphereLighting = snapshot.globeDynamicAtmosphereLighting;
      globe.dynamicAtmosphereLightingFromSun = snapshot.globeDynamicAtmosphereLightingFromSun;
      if ('shadows' in globe && snapshot.globeShadows !== undefined) globe.shadows = snapshot.globeShadows;
    }
    if (viewer.shadowMap && snapshot.shadowSoft !== undefined) {
      viewer.shadowMap.softShadows = snapshot.shadowSoft;
    }

    snapshot = null;
    simulation = false;
    hideNightMask();
    clearCelestialEntities();
    renderMaster();
    updateUi(true);
    viewer.scene.requestRender();
    status('Original God’s Eye time, lighting and shadow state restored.');
    return true;
  }

  function enableSimulation() {
    if (simulation) return true;
    capture();
    simulation = true;
    selectedDate = utcDateString(viewer.clock.currentTime);
    dateInput.value = selectedDate;
    applyDayBounds();
    viewer.clock.multiplier = SPEEDS[speedIndex];
    viewer.clock.shouldAnimate = false;
    applyLighting();
    rebuildNightClassification(true);

    void preloadIcrfForDay(viewer.clock.currentTime).then(() => {
      if (!simulation) return;
      updateCelestialEntities();
      updateUi(true);
      viewer.scene.requestRender();
    });

    updateCelestialEntities();
    renderMaster();
    updateUi(true);
    status('Simulation active. Move the slider or press PLAY.');
    return true;
  }

  function renderMaster() {
    const st = ui.panel.querySelector('[data-dn-master-state]');
    const sub = ui.panel.querySelector('[data-dn-master-sub]');
    const btn = ui.panel.querySelector('[data-dn-action="master"]');
    st.textContent = simulation ? 'SIMULATION ON' : 'SIMULATION OFF';
    st.classList.toggle('on', simulation);
    btn.textContent = simulation ? 'SIMULATION OFF' : 'SIMULATION ON';
    btn.classList.toggle('active', simulation);
    sub.textContent = simulation
      ? 'Cesium clock + sunlight temporarily controlled.'
      : 'Current God’s Eye clock is untouched.';
  }

  function ensureSimulation() {
    if (!simulation) enableSimulation();
  }

  function setMinutes(value) {
    ensureSimulation();
    const mins = clamp(Number(value)||0, 0, 1439);
    viewer.clock.shouldAnimate = false;
    viewer.clock.currentTime = julianFromDateAndMinutes(selectedDate, mins);
    rebuildNightClassification(true);
    updateCelestialEntities();
    updateUi(true);
    viewer.scene.requestRender();
  }

  function setDate(value) {
    if (!value) return;
    ensureSimulation();
    const currentMinutes = minutesOfUtcDay(viewer.clock.currentTime);
    selectedDate = value;
    applyDayBounds();
    viewer.clock.currentTime = julianFromDateAndMinutes(selectedDate, currentMinutes);
    rebuildNightClassification(true);
    void preloadIcrfForDay(viewer.clock.currentTime).then(() => {
      if (simulation) {
        updateCelestialEntities();
        updateUi(true);
        viewer.scene.requestRender();
      }
    });
    updateCelestialEntities();
    updateUi(true);
    viewer.scene.requestRender();
  }

  function clearCelestialEntities() {
    ds.entities.removeAll();
    subsolarEntity = null;
    sublunarEntity = null;
    terminatorEntity = null;
  }

  function updateCelestialEntities() {
    if (!simulation) return;
    const vectors = fixedBodyVectors(viewer.clock.currentTime);
    if (!vectors) return;

    const sunSub = bodySubpoint(vectors.sun);
    const moonSub = bodySubpoint(vectors.moon);

    if (sunSub) {
      const pos = Cesium.Cartesian3.fromDegrees(sunSub.lon, sunSub.lat, 65000);
      if (!subsolarEntity) {
        subsolarEntity = ds.entities.add({
          position: pos,
          point: {
            pixelSize: 11,
            color: Cesium.Color.fromCssColorString('#ffd65a'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: '☀ SUBSOLAR',
            font: '10px ui-monospace',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(.62),
            pixelOffset: new Cesium.Cartesian2(0,-16),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
      } else {
        subsolarEntity.position = pos;
      }
    }

    if (moonSub) {
      const pos = Cesium.Cartesian3.fromDegrees(moonSub.lon, moonSub.lat, 65000);
      if (!sublunarEntity) {
        sublunarEntity = ds.entities.add({
          position: pos,
          point: {
            pixelSize: 9,
            color: Cesium.Color.fromCssColorString('#cbd3df'),
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1,
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          },
          label: {
            text: '☾ SUBLUNAR',
            font: '10px ui-monospace',
            fillColor: Cesium.Color.WHITE,
            showBackground: true,
            backgroundColor: Cesium.Color.BLACK.withAlpha(.62),
            pixelOffset: new Cesium.Cartesian2(0,-15),
            disableDepthTestDistance: Number.POSITIVE_INFINITY
          }
        });
      } else {
        sublunarEntity.position = pos;
      }
    }

    if (terminatorEnabled) {
      const positions = terminatorPositions(vectors.sun);
      if (!terminatorEntity) {
        terminatorEntity = ds.entities.add({
          polyline: {
            positions,
            width: 2.5,
            material: new Cesium.PolylineGlowMaterialProperty({
              glowPower: 0.10,
              taperPower: 0.7,
              color: Cesium.Color.fromCssColorString('#6de7ff').withAlpha(.58)
            }),
            arcType: Cesium.ArcType.NONE
          }
        });
      } else {
        terminatorEntity.polyline.positions = positions;
        terminatorEntity.show = true;
      }
    } else if (terminatorEntity) {
      terminatorEntity.show = false;
    }
  }

  function updateUi(force=false) {
    const now = performance.now();
    if (!force && now - lastUiAt < 160) return;
    lastUiAt = now;

    const jd = viewer.clock.currentTime;
    const ctr = mapCenter(viewer);
    const vectors = fixedBodyVectors(jd);

    ui.panel.querySelector('[data-dn-time]').textContent = utcTimeString(jd);
    ui.panel.querySelector('[data-dn-day]').textContent = utcDateString(jd);

    if (simulation) {
      slider.value = String(Math.round(minutesOfUtcDay(jd)));
      if (dateInput.value !== selectedDate) dateInput.value = selectedDate;
    }

    if (!ctr || !vectors) {
      ui.panel.querySelector('[data-dn-coords]').textContent = '—';
      return;
    }

    const sunSub = bodySubpoint(vectors.sun);
    const moonSub = bodySubpoint(vectors.moon);
    const sunAE = localAzEl(ctr, vectors.sun);
    const moonAE = localAzEl(ctr, vectors.moon);
    const illum = moonIllumination(vectors.sunI, vectors.moonI);

    ui.panel.querySelector('[data-dn-coords]').textContent =
      `${ctr.lat.toFixed(3)}°, ${ctr.lon.toFixed(3)}°`;
    ui.panel.querySelector('[data-dn-local-solar]').textContent = solarTime(ctr.lon, jd);
    ui.panel.querySelector('[data-dn-solar]').textContent = solarTime(ctr.lon, jd);

    const light = twilightLabel(sunAE?.el);
    ui.panel.querySelector('[data-dn-light-state]').textContent = light;

    ui.panel.querySelector('[data-dn-sun-azel]').textContent =
      sunAE ? `${sunAE.az.toFixed(1)}° / ${sunAE.el.toFixed(1)}°` : '—';
    ui.panel.querySelector('[data-dn-moon-azel]').textContent =
      moonAE ? `${moonAE.az.toFixed(1)}° / ${moonAE.el.toFixed(1)}°` : '—';

    ui.panel.querySelector('[data-dn-sun-sub]').textContent =
      sunSub ? `${sunSub.lat.toFixed(2)}°, ${sunSub.lon.toFixed(2)}°` : '—';
    ui.panel.querySelector('[data-dn-sun-dir]').textContent =
      sunAE ? `AZ ${sunAE.az.toFixed(1)}° · ALT ${sunAE.el.toFixed(1)}°` : '—';

    ui.panel.querySelector('[data-dn-moon-sub]').textContent =
      moonSub ? `${moonSub.lat.toFixed(2)}°, ${moonSub.lon.toFixed(2)}°` : '—';
    ui.panel.querySelector('[data-dn-moon-illum]').textContent =
      Number.isFinite(illum) ? `${Math.round(illum*100)}%` : '—';
    ui.panel.querySelector('[data-dn-phase]').textContent = moonPhaseLabel(illum);

    const speed = SPEEDS[speedIndex];
    ui.panel.querySelector('[data-dn-speed-label]').textContent = `${speed}×`;
    ui.panel.querySelector('[data-dn-action="speed"]').textContent = `SPEED ${speed}×`;

    const play = ui.panel.querySelector('[data-dn-action="play"]');
    play.classList.toggle('active', simulation && viewer.clock.shouldAnimate);
  }

  function openPanel() {
    panelOpen = true;
    ui.panel.hidden = false;
    ui.button.classList.add('active');
    renderMaster();
    updateUi(true);
  }

  function closePanel() {
    panelOpen = false;
    ui.panel.hidden = true;
    ui.button.classList.remove('active');
  }

  ui.panel.addEventListener('click', e => {
    const action = e.target.closest('[data-dn-action]')?.dataset.dnAction;

    if (action === 'master') {
      if (simulation) restore();
      else enableSimulation();
    }

    if (action === 'play') {
      ensureSimulation();
      viewer.clock.multiplier = SPEEDS[speedIndex];
      viewer.clock.shouldAnimate = true;
      status(`Playing at ${SPEEDS[speedIndex]}×. The simulated day loops continuously.`);
      updateUi(true);
    }

    if (action === 'pause') {
      ensureSimulation();
      viewer.clock.shouldAnimate = false;
      updateUi(true);
    }

    if (action === 'now') {
      ensureSimulation();
      const now = Cesium.JulianDate.now();
      selectedDate = utcDateString(now);
      dateInput.value = selectedDate;
      applyDayBounds();
      viewer.clock.currentTime = cloneJulian(now);
      viewer.clock.shouldAnimate = false;
      rebuildNightClassification(true);
      updateCelestialEntities();
      updateUi(true);
      viewer.scene.requestRender();
    }

    if (action === 'speed') {
      speedIndex = (speedIndex + 1) % SPEEDS.length;
      if (simulation) viewer.clock.multiplier = SPEEDS[speedIndex];
      updateUi(true);
    }

    if (action === 'shadows') {
      ensureSimulation();
      shadowsEnabled = !shadowsEnabled;
      const b = ui.panel.querySelector('[data-dn-action="shadows"]');
      b.textContent = shadowsEnabled ? 'SHADOWS ON' : 'SHADOWS OFF';
      b.classList.toggle('active', shadowsEnabled);
      applyLighting();
    }

    if (action === 'soft') {
      ensureSimulation();
      softShadows = !softShadows;
      const b = ui.panel.querySelector('[data-dn-action="soft"]');
      b.textContent = softShadows ? 'SOFT SHADOWS ON' : 'SOFT SHADOWS OFF';
      b.classList.toggle('active', softShadows);
      applyLighting();
    }

    if (action === 'nightshade') {
      ensureSimulation();
      nightShadeEnabled = !nightShadeEnabled;
      if (nightShadeEnabled) rebuildNightClassification(true);
      else clearNightClassification();
      updateNightShadeState();
      status(
        nightShadeEnabled
          ? 'Screen Night Mask active — the visible Earth is darkened according to solar geometry, independent of Google 3D rendering.'
          : 'Screen Night Mask disabled. Cesium sunlight/shadows remain active.'
      );
    }

    if (action === 'terminator') {
      ensureSimulation();
      terminatorEnabled = !terminatorEnabled;
      const b = ui.panel.querySelector('[data-dn-action="terminator"]');
      b.textContent = terminatorEnabled ? 'TERMINATOR ON' : 'TERMINATOR OFF';
      b.classList.toggle('active', terminatorEnabled);
      updateCelestialEntities();
      viewer.scene.requestRender();
    }

    if (action === 'restore') restore();
    if (e.target.closest('[data-dn-close]')) closePanel();
  });

  slider.addEventListener('input', e => setMinutes(e.target.value));
  dateInput.addEventListener('change', e => setDate(e.target.value));

  ui.panel.querySelector('[data-dn-night-darkness]').addEventListener('input', e => {
    nightDarkness = clamp((Number(e.target.value) || 86) / 100, 0.35, 0.95);
    if (simulation && nightShadeEnabled) rebuildNightClassification(true);
    else updateNightShadeState();
  });

  const removeTick = viewer.clock.onTick.addEventListener(() => {
    if (!simulation) return;
    // Keep date selector in sync when LOOP_STOP / clock tick crosses day edge.
    selectedDate = utcDateString(viewer.clock.currentTime);
    rebuildNightClassification(false);
    updateCelestialEntities();
    updateUi();
    viewer.scene.requestRender();
  });

  const removeMove = viewer.camera.moveEnd.addEventListener(() => {
    if (simulation && nightShadeEnabled) rebuildNightClassification(true);
    updateUi(true);
  });

  const onResize = () => {
    if (simulation && nightShadeEnabled) rebuildNightClassification(true);
  };
  window.addEventListener('resize', onResize);

  renderMaster();
  updateNightShadeState();
  updateUi(true);

  return Object.freeze({
    open: openPanel,
    close: closePanel,
    enable: enableSimulation,
    restore,
    setDate,
    setMinutes,
    play(speed = null) {
      ensureSimulation();
      if (Number.isFinite(Number(speed))) {
        const target = Number(speed);
        let best=0, dist=Infinity;
        SPEEDS.forEach((s,i)=>{const d=Math.abs(s-target);if(d<dist){dist=d;best=i}});
        speedIndex=best;
      }
      viewer.clock.multiplier=SPEEDS[speedIndex];
      viewer.clock.shouldAnimate=true;
      updateUi(true);
      return true;
    },
    pause() {
      if (simulation) viewer.clock.shouldAnimate=false;
      updateUi(true);
      return true;
    },
    getState() {
      return {
        panelOpen,
        simulation,
        date: selectedDate,
        utcTime: utcTimeString(viewer.clock.currentTime),
        multiplier: viewer.clock.multiplier,
        shadowsEnabled,
        softShadows,
        terminatorEnabled,
        nightShadeEnabled,
        nightDarkness,
        screenMaskWidth: maskWidth,
        screenMaskHeight: maskHeight,
        shadingMethod: 'CPU screen-space WGS84 solar mask',
        mapSafe: true,
      };
    },
    destroy() {
      if (simulation) restore();
      removeTick?.();
      removeMove?.();
      ds.entities.removeAll();
      try { viewer.dataSources.remove(ds, true); } catch {}
      window.removeEventListener('resize', onResize);
      if (nightMaskCanvas) {
        nightMaskCanvas.remove();
        nightMaskCanvas = null;
        nightMaskCtx = null;
        nightMaskImage = null;
      }
      ui.panel.remove();
      ui.button.remove();
      document.getElementById(STYLE_ID)?.remove();
    }
  });
}

export default initDayNightSunMoonSimulator;
