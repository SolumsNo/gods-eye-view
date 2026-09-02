import * as Cesium from 'cesium';

const PANEL_ID = 'gev-area-intelligence';
const BUTTON_ID = 'gev-area-intelligence-button';
const STYLE_ID = 'gev-area-intelligence-style';
const MARKER_ID = 'gev-area-intelligence-marker';

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));
}

function fmtNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? new Intl.NumberFormat('nb-NO').format(Math.round(n)) : '—';
}

function pickGround(viewer, x, y) {
  const p2 = new Cesium.Cartesian2(x, y);
  let p = null;
  try {
    const ray = viewer.camera.getPickRay(p2);
    p = ray ? viewer.scene.globe?.pick(ray, viewer.scene) : null;
  } catch {}
  if (!p) {
    try { p = viewer.camera.pickEllipsoid(p2, viewer.scene.globe.ellipsoid); } catch {}
  }
  if (!p) return null;
  const c = Cesium.Cartographic.fromCartesian(p);
  return {
    latitude: Cesium.Math.toDegrees(c.latitude),
    longitude: Cesium.Math.toDegrees(c.longitude),
  };
}

function viewportSamples(viewer) {
  const canvas = viewer.scene.canvas;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const pts = [
    ['center', .50, .50],
    ['foreground', .50, .78],
    ['distance', .50, .24],
    ['left', .22, .52],
    ['right', .78, .52],
    ['lowerLeft', .28, .72],
    ['lowerRight', .72, .72],
  ];
  const out = [];
  for (const [role, fx, fy] of pts) {
    const p = pickGround(viewer, w * fx, h * fy);
    if (p) out.push({role, ...p});
  }
  return out;
}

function cameraMeta(viewer) {
  const c = viewer.camera.positionCartographic;
  return {
    altitudeM: Number(c?.height) || null,
    headingDeg: Cesium.Math.toDegrees(viewer.camera.heading || 0),
    pitchDeg: Cesium.Math.toDegrees(viewer.camera.pitch || 0),
  };
}

function layerStats(dataManager) {
  if (!dataManager?.layers) return [];
  const out = [];
  for (const [id, entry] of dataManager.layers) {
    const enabled = typeof dataManager.isEffectivelyEnabled === 'function'
      ? dataManager.isEffectivelyEnabled(id)
      : Boolean(entry?.enabled);
    if (!enabled) continue;
    let stats = {};
    try { stats = entry?.module?.getStats?.() || {}; } catch {}
    out.push({
      id,
      name: entry?.module?.name || id,
      count: Number.isFinite(Number(stats.count)) ? Number(stats.count) : null,
      source: stats.source || entry?.module?.source || null,
      status: stats.status || null,
    });
  }
  return out.slice(0, 30);
}

function ensureStyle() {
  document.getElementById(STYLE_ID)?.remove();
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${BUTTON_ID}{
      position:fixed;right:18px;bottom:228px;z-index:2060;
      border:1px solid rgba(79,226,255,.35);border-radius:9px;
      background:rgba(4,13,22,.91);color:#c5f7ff;padding:9px 11px;
      font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace;
      letter-spacing:.11em;cursor:pointer;backdrop-filter:blur(12px)
    }
    #${BUTTON_ID}:hover,#${BUTTON_ID}.active{border-color:#67eaff;background:rgba(24,98,124,.35);color:#fff}
    #${PANEL_ID}{
      position:fixed;right:18px;top:72px;z-index:2055;width:min(540px,calc(100vw - 30px));
      max-height:calc(100vh - 150px);overflow:auto;border-radius:13px;
      border:1px solid rgba(87,220,255,.28);
      background:linear-gradient(180deg,rgba(5,15,24,.97),rgba(2,8,13,.97));
      color:#eafaff;box-shadow:0 20px 64px rgba(0,0,0,.48);backdrop-filter:blur(15px);
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace
    }
    #${PANEL_ID}[hidden]{display:none!important}
    #${PANEL_ID} .ai-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;
      padding:11px 12px;background:rgba(4,13,21,.95);border-bottom:1px solid rgba(97,220,255,.12);backdrop-filter:blur(12px)}
    #${PANEL_ID} .ai-title{color:#70eaff;font-size:10px;font-weight:900;letter-spacing:.16em}
    #${PANEL_ID} .ai-sub{font-size:8px;color:rgba(205,235,246,.45);margin-top:3px}
    #${PANEL_ID} button{font:inherit}
    #${PANEL_ID} .ai-close{border:0;background:transparent;color:#91b6c3;font-size:20px;cursor:pointer}
    #${PANEL_ID} .ai-body{padding:12px}
    #${PANEL_ID} .hero{padding:11px;border:1px solid rgba(97,221,255,.13);border-radius:9px;background:rgba(255,255,255,.022)}
    #${PANEL_ID} .place{font-size:18px;font-weight:900;color:#fff;line-height:1.16}
    #${PANEL_ID} .where{font-size:9px;color:#86dff2;margin-top:4px}
    #${PANEL_ID} .coords{font-size:8px;color:#668d9b;margin-top:4px}
    #${PANEL_ID} .actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}
    #${PANEL_ID} .action{border:1px solid rgba(88,220,255,.2);background:rgba(50,160,198,.07);color:#b9effa;
      border-radius:6px;padding:7px 8px;font-size:8px;cursor:pointer}
    #${PANEL_ID} .action:hover{background:rgba(50,160,198,.17);color:#fff}
    #${PANEL_ID} .section{margin-top:12px}
    #${PANEL_ID} .section-title{display:flex;justify-content:space-between;gap:8px;color:#6ce6ff;font-size:9px;font-weight:900;
      letter-spacing:.13em;margin-bottom:6px}
    #${PANEL_ID} .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px}
    #${PANEL_ID} .stat{border:1px solid rgba(122,214,246,.09);border-radius:6px;padding:7px;background:rgba(255,255,255,.016)}
    #${PANEL_ID} .label{color:rgba(196,225,237,.43);font-size:7px;letter-spacing:.11em}
    #${PANEL_ID} .value{color:#edfaff;font-size:9px;font-weight:700;margin-top:3px;line-height:1.35}
    #${PANEL_ID} .text{font-family:system-ui,-apple-system,sans-serif;font-size:12px;line-height:1.5;color:#d9edf4;
      border-left:2px solid rgba(90,220,255,.24);padding-left:9px}
    #${PANEL_ID} .view-card{border:1px solid rgba(108,222,255,.13);border-radius:8px;padding:8px;background:rgba(28,93,116,.09)}
    #${PANEL_ID} .view-main{font:700 12px system-ui,-apple-system,sans-serif;color:#eefcff;line-height:1.4}
    #${PANEL_ID} .view-rows{display:grid;gap:5px;margin-top:8px}
    #${PANEL_ID} .view-row{display:grid;grid-template-columns:92px 1fr;gap:8px;border-top:1px solid rgba(108,222,255,.07);padding-top:5px}
    #${PANEL_ID} .view-key{font-size:7px;color:#6fa3b5;letter-spacing:.1em}
    #${PANEL_ID} .view-val{font-size:9px;color:#d5f3fa}
    #${PANEL_ID} .chips{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px}
    #${PANEL_ID} .chip{border:1px solid rgba(97,215,248,.12);border-radius:999px;padding:5px 7px;font-size:8px;color:#bfeaf5}
    #${PANEL_ID} .news{display:grid;gap:5px}
    #${PANEL_ID} .news a{display:block;text-decoration:none;color:#d9f7ff;border:1px solid rgba(98,210,247,.08);
      border-radius:6px;padding:7px;background:rgba(255,255,255,.014);font-family:system-ui,-apple-system,sans-serif;font-size:11px}
    #${PANEL_ID} .news a small{display:block;color:#7195a3;margin-top:3px}
    #${PANEL_ID} .note{font-size:7px;color:#63828e;line-height:1.45;margin-top:10px}
    #${PANEL_ID} .loading{padding:28px 10px;text-align:center;color:#82dff2;font-size:10px;letter-spacing:.1em}
    @media(max-width:820px){
      #${BUTTON_ID}{right:12px;bottom:238px}
      #${PANEL_ID}{right:12px;top:64px;width:calc(100vw - 24px);max-height:calc(100vh - 130px)}
    }`;
  document.head.appendChild(s);
}

function createUi(onAnalyze) {
  ensureStyle();
  let button = document.getElementById(BUTTON_ID);
  if (!button) {
    button = document.createElement('button');
    button.id = BUTTON_ID;
    button.type = 'button';
    button.textContent = '◎ AREA INTEL';
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
    <div class="ai-head">
      <div><div class="ai-title">◎ AREA INTELLIGENCE v2</div><div class="ai-sub">VISUAL AREA ANALYSIS · PLACE · HISTORY · LIVE CONTEXT</div></div>
      <button class="ai-close" type="button" data-ai-close>×</button>
    </div><div class="ai-body"><div class="loading">READY TO ANALYZE VIEW</div></div>`;
  button.onclick = () => onAnalyze();
  panel.querySelector('[data-ai-close]').onclick = () => {
    panel.hidden = true;
    button.classList.remove('active');
  };
  return {button,panel};
}

function weatherHtml(w) {
  if (!w) return '<div class="text">Weather unavailable.</div>';
  const parts = [
    ['TEMP', w.temperatureC != null ? `${w.temperatureC} °C` : '—'],
    ['FEELS', w.apparentTemperatureC != null ? `${w.apparentTemperatureC} °C` : '—'],
    ['CLOUD', w.cloudCoverPct != null ? `${w.cloudCoverPct}%` : '—'],
    ['WIND', w.windSpeedKph != null ? `${w.windSpeedKph} km/h` : '—'],
    ['VISIBILITY', w.visibilityKm != null ? `${w.visibilityKm} km` : '—'],
    ['RAIN', w.precipitationMm != null ? `${w.precipitationMm} mm` : '—'],
  ];
  return `<div class="grid">${parts.map(([a,b]) =>
    `<div class="stat"><div class="label">${a}</div><div class="value">${esc(b)}</div></div>`
  ).join('')}</div>`;
}

function render(panel, result) {
  const d = result.intel || {};
  const p = d.place || {};
  const c = d.country || {};
  const wiki = d.wikipedia || {};
  const v = d.viewportAnalysis || {};
  const regional = result.regional || {};
  const live = result.liveLayers || [];
  const population = d.cityPopulation ?? p.population ?? null;
  const title = v.primaryArea || p.locality || p.district || p.region || p.country || 'Unknown area';
  const where = [v.parentLocality || p.locality, p.region, p.country]
    .filter((x,i,a)=>x && a.indexOf(x)===i && x !== title).join(' · ');

  const rows = [
    ['VIEW TYPE', v.viewType || '—'],
    ['FOREGROUND', v.foreground || '—'],
    ['DISTANCE', v.distance || '—'],
    ['LEFT SIDE', v.left || '—'],
    ['RIGHT SIDE', v.right || '—'],
  ];

  panel.querySelector('.ai-body').innerHTML = `
    <div class="hero">
      <div class="place">${esc(title)}</div>
      <div class="where">${esc(where)}</div>
      <div class="coords">${result.center.latitude.toFixed(5)}°, ${result.center.longitude.toFixed(5)}° · ALT ${fmtNum(result.camera?.altitudeM)} m</div>
      <div class="actions">
        <button class="action" type="button" data-ai-refresh>ANALYZE AGAIN</button>
        ${wiki.url ? `<button class="action" type="button" data-ai-wiki>WIKIPEDIA</button>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-title"><span>AI VIEW ANALYSIS</span><span>MULTI-POINT VIEWPORT</span></div>
      <div class="view-card">
        <div class="view-main">${esc(v.summary || 'Viewport context is limited at this camera angle.')}</div>
        <div class="view-rows">
          ${rows.map(([k,val])=>`<div class="view-row"><div class="view-key">${k}</div><div class="view-val">${esc(val)}</div></div>`).join('')}
        </div>
        ${(v.visibleDistricts||[]).length ? `<div class="chips">${v.visibleDistricts.map(x=>`<span class="chip">${esc(x)}</span>`).join('')}</div>` : ''}
      </div>
    </div>

    <div class="section">
      <div class="section-title"><span>PLACE & PEOPLE</span><span>${esc(p.type || '')}</span></div>
      <div class="grid">
        <div class="stat"><div class="label">POPULATION · PLACE</div><div class="value">${fmtNum(population)}</div></div>
        <div class="stat"><div class="label">NATIONALITY / DEMONYM</div><div class="value">${esc(c.demonym || '—')}</div></div>
        <div class="stat"><div class="label">COUNTRY POPULATION</div><div class="value">${fmtNum(c.population)}</div></div>
        <div class="stat"><div class="label">CAPITAL</div><div class="value">${esc(c.capital || '—')}</div></div>
        <div class="stat"><div class="label">LANGUAGES</div><div class="value">${esc(Array.isArray(c.languages)?c.languages.join(', '):'—')}</div></div>
        <div class="stat"><div class="label">CURRENCY</div><div class="value">${esc(Array.isArray(c.currencies)?c.currencies.join(', '):'—')}</div></div>
        <div class="stat"><div class="label">CONTINENT / REGION</div><div class="value">${esc([c.continent,c.region].filter(Boolean).join(' · ') || '—')}</div></div>
        <div class="stat"><div class="label">AREA</div><div class="value">${c.areaKm2 ? `${fmtNum(c.areaKm2)} km²` : '—'}</div></div>
      </div>
    </div>

    ${wiki.extract ? `<div class="section"><div class="section-title"><span>ABOUT · HISTORY · KNOWN FOR</span><span>ENCYCLOPEDIA</span></div>
      <div class="text">${esc(wiki.extract)}</div></div>` : ''}

    <div class="section"><div class="section-title"><span>WEATHER NOW</span><span>${esc(regional.weatherStatus || '')}</span></div>
      ${weatherHtml(regional.weather)}
    </div>

    <div class="section"><div class="section-title"><span>WHAT'S HAPPENING</span><span>${esc(regional.newsSource || '')}</span></div>
      <div class="news">${(regional.articles || []).slice(0,5).map(a =>
        `<a href="${esc(a.url)}" target="_blank" rel="noopener noreferrer">${esc(a.title)}<small>${esc(a.domain || '')}${a.publishedAt ? ' · '+esc(new Date(a.publishedAt).toLocaleString('nb-NO')) : ''}</small></a>`
      ).join('') || '<div class="text">No recent location-matched headlines returned.</div>'}</div>
    </div>

    <div class="section"><div class="section-title"><span>LIVE MAP LAYERS</span><span>LOADED DATA</span></div>
      <div class="chips">${live.map(l=>`<span class="chip">${esc(l.name)}${l.count!=null?` · ${fmtNum(l.count)}`:''}</span>`).join('') || '<span class="chip">No live layers enabled</span>'}</div>
    </div>

    <div class="note">
      v2 samples several points across the visible map, so boroughs/neighborhoods and adjacent areas can be distinguished more accurately than a single center coordinate.
      Visual-area labels are geographic estimates from map coordinates; they are not computer-vision identification of individual buildings.
    </div>`;
}

export function initAreaIntelligence({viewer, dataManager = null} = {}) {
  if (!viewer?.scene) throw new Error('Area Intelligence requires Cesium Viewer');
  let inFlight = null;
  let lastResult = null;
  let marker = null;
  const ui = createUi(() => void analyzeCenter({open:true}));

  function setMarker(point) {
    try {
      if (marker) viewer.entities.remove(marker);
      marker = viewer.entities.add({
        id: MARKER_ID,
        position: Cesium.Cartesian3.fromDegrees(point.longitude, point.latitude, 20),
        point: {
          pixelSize:10, color:Cesium.Color.CYAN,
          outlineColor:Cesium.Color.WHITE, outlineWidth:1,
          disableDepthTestDistance:Number.POSITIVE_INFINITY
        },
      });
    } catch {}
  }

  async function analyzeCenter({open=true} = {}) {
    if (inFlight) return inFlight;
    const samples = viewportSamples(viewer);
    const center = samples.find(x=>x.role==='center') || samples[0];
    if (!center) return {ok:false,action:'analyze_area',error:'Could not resolve visible ground'};

    if (open) {
      ui.panel.hidden=false;
      ui.button.classList.add('active');
      ui.panel.querySelector('.ai-body').innerHTML='<div class="loading">ANALYZING WHOLE VIEW…</div>';
    }
    setMarker(center);

    inFlight = (async()=>{
      const qs = new URLSearchParams({
        lat:center.latitude.toFixed(6),
        lon:center.longitude.toFixed(6),
        samples:JSON.stringify(samples.map(s=>({
          role:s.role,
          lat:Number(s.latitude.toFixed(6)),
          lon:Number(s.longitude.toFixed(6)),
        }))),
      });

      const [intelRes, regionalRes] = await Promise.allSettled([
        fetch(`/api/area-intel?${qs}`, {cache:'no-store'}).then(async r=>{
          if(!r.ok) throw new Error(`Area Intel HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`/api/regional-brief?lat=${center.latitude.toFixed(6)}&lon=${center.longitude.toFixed(6)}`, {cache:'no-store'}).then(async r=>r.ok?r.json():null),
      ]);

      const result = {
        ok:intelRes.status==='fulfilled',
        action:'analyze_area',
        center:{latitude:center.latitude,longitude:center.longitude},
        camera:cameraMeta(viewer),
        viewportSamples:samples,
        intel:intelRes.status==='fulfilled'?intelRes.value:{},
        regional:regionalRes.status==='fulfilled'?regionalRes.value:null,
        liveLayers:layerStats(dataManager),
      };
      lastResult=result;
      if(open) render(ui.panel,result);
      return result;
    })().finally(()=>{inFlight=null});
    return inFlight;
  }

  ui.panel.addEventListener('click', e=>{
    if(e.target.closest('[data-ai-refresh]')) void analyzeCenter({open:true});
    if(e.target.closest('[data-ai-wiki]') && lastResult?.intel?.wikipedia?.url) {
      window.open(lastResult.intel.wikipedia.url,'_blank','noopener');
    }
  });

  function onKey(e){
    if(e.shiftKey && e.key.toLowerCase()==='a' && !e.metaKey && !e.ctrlKey) {
      void analyzeCenter({open:true});
    }
  }
  window.addEventListener('keydown',onKey);

  return Object.freeze({
    analyzeCenter,
    open(){ui.panel.hidden=false;ui.button.classList.add('active')},
    close(){ui.panel.hidden=true;ui.button.classList.remove('active')},
    getLastResult(){return lastResult},
    destroy(){
      window.removeEventListener('keydown',onKey);
      if(marker) viewer.entities.remove(marker);
      ui.panel.remove();ui.button.remove();document.getElementById(STYLE_ID)?.remove();
    },
  });
}

export default initAreaIntelligence;
