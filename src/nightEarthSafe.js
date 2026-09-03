import * as Cesium from 'cesium';

/**
 * SOLUMS SKYNET SPYSAT — NIGHT EARTH / DARK SKY SAFE v1.1
 *
 * HARD SAFETY CONTRACT:
 * This module never modifies the base map, Google 3D or Visual Presets.
 * It only owns one CustomDataSource plus its UI.
 */

const PANEL_ID = 'sz-night-earth-safe-panel';
const BUTTON_ID = 'sz-night-earth-safe-button';
const STYLE_ID = 'sz-night-earth-safe-style';
const DATA_SOURCE_NAME = 'Solums Skynet Spysat Dark Sky Overlay';

const DEFAULT_DAYS_AGO = 4;
const MIN_DAYS_AGO = 2;
const MAX_DAYS_AGO = 24;
const ROUTE_LIMIT_SECONDS = 90 * 60;

const GRID_COLS = 10;
const GRID_ROWS = 7;

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function toDeg(rad) { return Cesium.Math.toDegrees(rad); }

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));
}

function isoDateDaysAgo(daysAgo) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(MIN_DAYS_AGO, Math.round(daysAgo)));
  return d.toISOString().slice(0, 10);
}

function dateLabel(iso) {
  const ms = Date.parse(`${iso}T12:00:00Z`);
  if (!Number.isFinite(ms)) return iso || '—';
  return new Intl.DateTimeFormat('nb-NO', {
    timeZone:'UTC', day:'2-digit', month:'short', year:'numeric'
  }).format(new Date(ms));
}

function mapCenter(viewer) {
  const canvas = viewer.scene.canvas;
  const p2 = new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2);
  let cart = null;
  try {
    const ray = viewer.camera.getPickRay(p2);
    cart = ray ? viewer.scene.globe?.pick(ray, viewer.scene) : null;
  } catch {}
  if (!cart) {
    try { cart = viewer.camera.pickEllipsoid(p2, viewer.scene.globe.ellipsoid); } catch {}
  }
  if (cart) {
    const c = Cesium.Cartographic.fromCartesian(cart);
    return { lat:toDeg(c.latitude), lon:toDeg(c.longitude) };
  }
  const c = viewer.camera.positionCartographic;
  return c ? { lat:toDeg(c.latitude), lon:toDeg(c.longitude) } : null;
}

function viewRectangle(viewer) {
  const center = mapCenter(viewer);
  if (!center) return null;

  try {
    const r = viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if (r) {
      const west=toDeg(r.west), east=toDeg(r.east), south=toDeg(r.south), north=toDeg(r.north);
      if (
        Number.isFinite(west+east+south+north)
        && east > west && east-west < 170
        && north > south
      ) {
        return {
          west, east,
          south:clamp(south,-84,84),
          north:clamp(north,-84,84),
          center
        };
      }
    }
  } catch {}

  const altitude = Math.max(500, Number(viewer.camera.positionCartographic?.height) || 10000);
  const latSpan = clamp(altitude / 135000, 0.08, 28);
  const cos = Math.max(.22, Math.cos(Cesium.Math.toRadians(center.lat)));
  const lonSpan = clamp(latSpan/cos, .10, 45);
  return {
    west:clamp(center.lon-lonSpan,-179.8,179.8),
    east:clamp(center.lon+lonSpan,-179.8,179.8),
    south:clamp(center.lat-latSpan,-84,84),
    north:clamp(center.lat+latSpan,-84,84),
    center,
  };
}

function imageUrl(bounds, requestedDate, width=700, height=430) {
  const q = new URLSearchParams({
    west:String(bounds.west), south:String(bounds.south),
    east:String(bounds.east), north:String(bounds.north),
    width:String(width), height:String(height),
    date:requestedDate,
  });
  return `/api/night-light-image?${q}`;
}

async function fetchNightImage(bounds, requestedDate, width=700, height=430) {
  const response = await fetch(imageUrl(bounds, requestedDate, width, height), {
    cache:'no-store',
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json())?.error || ''; } catch {}
    throw new Error(detail || `NASA VIIRS HTTP ${response.status}`);
  }

  const blob = await response.blob();
  if (!blob.type.startsWith('image/')) throw new Error('NASA returned non-image data');

  const bitmap = await createImageBitmap(blob);
  return {
    bitmap,
    blob,
    actualDate: response.headers.get('X-Night-Earth-Date') || requestedDate,
    fallbackDays: Number(response.headers.get('X-Night-Earth-Fallback-Days') || 0),
    sourceId: response.headers.get('X-Night-Earth-Source') || 'VIIRS',
    sourceLabel: response.headers.get('X-Night-Earth-Source-Label') || 'NASA VIIRS',
  };
}

function imageDataFromBitmap(bitmap) {
  const canvas=document.createElement('canvas');
  canvas.width=bitmap.width; canvas.height=bitmap.height;
  const ctx=canvas.getContext('2d',{willReadFrequently:true});
  ctx.drawImage(bitmap,0,0);
  bitmap.close?.();
  return ctx.getImageData(0,0,canvas.width,canvas.height);
}

function sampleImage(img,bounds,lat,lon,radius=4) {
  if (!img || !bounds) return null;
  const fx=(lon-bounds.west)/(bounds.east-bounds.west);
  const fy=(bounds.north-lat)/(bounds.north-bounds.south);
  if (!(fx>=0&&fx<=1&&fy>=0&&fy<=1)) return null;

  const cx=clamp(Math.round(fx*(img.width-1)),0,img.width-1);
  const cy=clamp(Math.round(fy*(img.height-1)),0,img.height-1);

  let sum=0,count=0;
  for(let dy=-radius;dy<=radius;dy++){
    for(let dx=-radius;dx<=radius;dx++){
      const x=clamp(cx+dx,0,img.width-1);
      const y=clamp(cy+dy,0,img.height-1);
      const i=(y*img.width+x)*4;
      const a=img.data[i+3]/255;
      if(a<=.02) continue;
      sum+=(img.data[i]+img.data[i+1]+img.data[i+2])/3;
      count++;
    }
  }
  if(!count) return null;
  const brightness=sum/count;
  return {brightness,darkness:clamp(Math.round((1-brightness/255)*100),0,100)};
}

function darknessClass(score){
  if(!Number.isFinite(score))return 'UKJENT';
  if(score>=94)return 'EKSTREMT MØRKT';
  if(score>=88)return 'SVÆRT MØRKT';
  if(score>=78)return 'MØRKT';
  if(score>=64)return 'MODERAT LYS';
  if(score>=48)return 'LYST';
  return 'MYE BYLYS';
}

function overlayColor(score){
  if(score>=92)return Cesium.Color.fromCssColorString('#17376d').withAlpha(.78);
  if(score>=82)return Cesium.Color.fromCssColorString('#166985').withAlpha(.78);
  if(score>=70)return Cesium.Color.fromCssColorString('#1d9a9a').withAlpha(.78);
  if(score>=56)return Cesium.Color.fromCssColorString('#c2ad42').withAlpha(.80);
  if(score>=40)return Cesium.Color.fromCssColorString('#d97a2f').withAlpha(.82);
  return Cesium.Color.fromCssColorString('#d74431').withAlpha(.84);
}

function pointSize(score,intensity){
  const pollution=100-clamp(score,0,100);
  return clamp((20+pollution*.28)*intensity,16,52);
}

function pointAtDistance(lat,lon,bearingDeg,distanceKm){
  const R=6371.0088,b=Cesium.Math.toRadians(bearingDeg);
  const p1=Cesium.Math.toRadians(lat),l1=Cesium.Math.toRadians(lon),d=distanceKm/R;
  const p2=Math.asin(Math.sin(p1)*Math.cos(d)+Math.cos(p1)*Math.sin(d)*Math.cos(b));
  const l2=l1+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(p1),Math.cos(d)-Math.sin(p1)*Math.sin(p2));
  return {lat:Cesium.Math.toDegrees(p2),lon:((Cesium.Math.toDegrees(l2)+540)%360)-180};
}

function searchBounds(points){
  const lats=points.map(p=>p.lat),lons=points.map(p=>p.lon);
  let west=Math.min(...lons),east=Math.max(...lons),south=Math.min(...lats),north=Math.max(...lats);
  const xp=Math.max(.05,(east-west)*.05),yp=Math.max(.05,(north-south)*.05);
  return {
    west:clamp(west-xp,-179.8,179.8),east:clamp(east+xp,-179.8,179.8),
    south:clamp(south-yp,-84,84),north:clamp(north+yp,-84,84),
  };
}

function median(values){
  const v=values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!v.length)return null;
  const m=Math.floor(v.length/2);
  return v.length%2?v[m]:(v[m-1]+v[m])/2;
}

function ensureStyle(){
  document.getElementById(STYLE_ID)?.remove();
  const s=document.createElement('style');
  s.id=STYLE_ID;
  s.textContent=`
    #${BUTTON_ID}{position:fixed;right:18px;bottom:272px;z-index:2060;border:1px solid rgba(90,222,255,.33);border-radius:9px;background:rgba(4,13,22,.92);color:#c8f7ff;padding:9px 11px;font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.11em;cursor:pointer;backdrop-filter:blur(12px)}
    #${BUTTON_ID}.active,#${BUTTON_ID}:hover{border-color:#6eeaff;background:rgba(22,91,118,.36);color:#fff}
    #${PANEL_ID}{position:fixed;right:18px;top:72px;z-index:2057;width:min(470px,calc(100vw - 30px));max-height:calc(100vh - 145px);overflow:auto;border:1px solid rgba(89,221,255,.25);border-radius:13px;background:linear-gradient(180deg,rgba(4,13,22,.97),rgba(2,7,12,.97));color:#eafaff;box-shadow:0 20px 64px rgba(0,0,0,.46);backdrop-filter:blur(15px);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
    #${PANEL_ID}[hidden]{display:none!important}
    #${PANEL_ID} .head{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:11px 12px;background:rgba(4,13,21,.96);border-bottom:1px solid rgba(97,220,255,.11)}
    #${PANEL_ID} .title{font-size:10px;font-weight:900;letter-spacing:.16em;color:#72eaff}
    #${PANEL_ID} .sub{font-size:8px;color:rgba(205,235,246,.46);margin-top:3px}
    #${PANEL_ID} button{font:inherit}
    #${PANEL_ID} .close{border:0;background:transparent;color:#91b6c3;font-size:20px;cursor:pointer}
    #${PANEL_ID} .body{padding:12px}
    #${PANEL_ID} .safe{border:1px solid rgba(78,235,170,.17);border-radius:8px;padding:8px;color:#86f1c3;background:rgba(31,137,91,.065);font-size:8px;line-height:1.45}
    #${PANEL_ID} .section{margin-top:11px}
    #${PANEL_ID} .sect{display:flex;justify-content:space-between;gap:8px;color:#6de7ff;font-size:8px;font-weight:900;letter-spacing:.13em;margin-bottom:6px}
    #${PANEL_ID} .actions{display:flex;gap:6px;flex-wrap:wrap}
    #${PANEL_ID} .action{border:1px solid rgba(92,219,249,.18);background:rgba(48,153,191,.07);color:#bceef8;border-radius:6px;padding:8px 9px;font-size:8px;cursor:pointer}
    #${PANEL_ID} .action.active,#${PANEL_ID} .action:hover{border-color:rgba(104,230,255,.55);background:rgba(48,153,191,.18);color:#fff}
    #${PANEL_ID} .preview{position:relative;overflow:hidden;border:1px solid rgba(98,219,250,.13);border-radius:8px;background:#010307;aspect-ratio:1.65/1}
    #${PANEL_ID} .preview img{width:100%;height:100%;display:block;object-fit:cover;filter:brightness(1.2) contrast(1.35)}
    #${PANEL_ID} .preview .cross{position:absolute;left:50%;top:50%;width:18px;height:18px;transform:translate(-50%,-50%)}
    #${PANEL_ID} .preview .cross:before,#${PANEL_ID} .preview .cross:after{content:'';position:absolute;background:#6be7ff;box-shadow:0 0 7px rgba(107,231,255,.75)}
    #${PANEL_ID} .preview .cross:before{width:2px;height:18px;left:8px;top:0}
    #${PANEL_ID} .preview .cross:after{height:2px;width:18px;left:0;top:8px}
    #${PANEL_ID} .badge{position:absolute;left:7px;bottom:6px;padding:4px 6px;border-radius:4px;background:rgba(0,0,0,.63);color:#b9edf7;font-size:7px}
    #${PANEL_ID} .error{position:absolute;inset:0;display:none;align-items:center;justify-content:center;text-align:center;padding:20px;color:#e6a98f;font-size:9px;line-height:1.5}
    #${PANEL_ID} .preview.failed .error{display:flex}
    #${PANEL_ID} .preview.failed img{display:none}
    #${PANEL_ID} input[type=range]{width:100%;margin:6px 0}
    #${PANEL_ID} .range{display:flex;justify-content:space-between;color:#6e929f;font-size:7px}
    #${PANEL_ID} .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px}
    #${PANEL_ID} .stat{border:1px solid rgba(100,213,245,.09);border-radius:6px;padding:7px;background:rgba(255,255,255,.015)}
    #${PANEL_ID} .label{font-size:7px;color:#6e94a2;letter-spacing:.1em}
    #${PANEL_ID} .value{font-size:10px;color:#effbff;font-weight:800;margin-top:3px;line-height:1.35}
    #${PANEL_ID} .big{font-size:23px;color:#74eaff}
    #${PANEL_ID} .finder{border:1px solid rgba(100,219,250,.10);border-radius:8px;padding:8px;background:rgba(20,65,84,.12)}
    #${PANEL_ID} .finding{font-size:9px;color:#86dff1;line-height:1.45}
    #${PANEL_ID} .result{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;border-top:1px solid rgba(105,218,248,.08);padding:8px 0}
    #${PANEL_ID} .result:first-child{border-top:0}
    #${PANEL_ID} .result-main{font-size:9px;color:#e6faff}
    #${PANEL_ID} .result-sub{font-size:7px;color:#7598a5;margin-top:3px}
    #${PANEL_ID} .fly{border:1px solid rgba(98,222,255,.2);background:transparent;color:#82eafa;border-radius:5px;padding:6px;font-size:7px;cursor:pointer}
    #${PANEL_ID} .note{margin-top:10px;font:9px/1.45 system-ui,-apple-system,sans-serif;color:#678793}
    @media(max-width:820px){#${BUTTON_ID}{right:12px;bottom:282px}#${PANEL_ID}{right:12px;top:64px;width:calc(100vw - 24px);max-height:calc(100vh - 130px)}}`;
  document.head.appendChild(s);
}

function createUi(togglePanel){
  ensureStyle();
  let button=document.getElementById(BUTTON_ID);
  if(!button){button=document.createElement('button');button.id=BUTTON_ID;button.type='button';button.textContent='☾ NIGHT EARTH';document.body.appendChild(button)}
  let panel=document.getElementById(PANEL_ID);
  if(!panel){panel=document.createElement('aside');panel.id=PANEL_ID;document.body.appendChild(panel)}
  panel.hidden=true;
  panel.innerHTML=`
    <div class="head"><div><div class="title">☾ NIGHT EARTH · DARK SKY v1.1</div><div class="sub">NASA BLACK MARBLE · AUTO SOURCE/DATE FALLBACK · MAP SAFE</div></div><button class="close" data-ne-close>×</button></div>
    <div class="body">
      <div class="safe">✓ MAP SAFE — endrer aldri Google 3D, kartgrunnlag eller Visual Presets.</div>

      <div class="section">
        <div class="sect"><span>LIGHT POLLUTION OVERLAY</span><span data-ne-overlay-state>OFF · 0/70</span></div>
        <div class="actions">
          <button class="action" data-ne-action="overlay">OVERLAY ON</button>
          <button class="action" data-ne-action="refresh">REFRESH VIEW</button>
          <button class="action" data-ne-action="astro">ASTRO + DARK</button>
        </div>
      </div>

      <div class="section">
        <div class="sect"><span>NASA NIGHT VIEW</span><span data-ne-date-label>—</span></div>
        <div class="preview" data-ne-preview-box>
          <img data-ne-preview alt="NASA VIIRS nighttime view">
          <span class="cross"></span>
          <span class="badge" data-ne-date-detail>CURRENT MAP VIEW</span>
          <span class="error" data-ne-error>NASA VIIRS data unavailable.</span>
        </div>
      </div>

      <div class="section">
        <div class="sect"><span>REQUESTED DATA AGE</span><span data-ne-days-label>${DEFAULT_DAYS_AGO} DAYS AGO</span></div>
        <input type="range" min="${MIN_DAYS_AGO}" max="${MAX_DAYS_AGO}" value="${DEFAULT_DAYS_AGO}" step="1" data-ne-days>
        <div class="range"><span>RECENT</span><span>AUTO FALLBACK IF MISSING</span></div>
      </div>

      <div class="section">
        <div class="sect"><span>OVERLAY INTENSITY</span><span data-ne-intensity-label>100%</span></div>
        <input type="range" min="45" max="140" value="100" step="5" data-ne-intensity>
      </div>

      <div class="section">
        <div class="sect"><span>CENTER DARKNESS</span><span>RELATIVE VIIRS INDEX</span></div>
        <div class="grid">
          <div class="stat"><div class="label">DARKNESS</div><div class="value big" data-ne-darkness>—</div></div>
          <div class="stat"><div class="label">CLASS</div><div class="value" data-ne-class>PRESS MEASURE</div></div>
          <div class="stat"><div class="label">VIIRS BRIGHTNESS</div><div class="value" data-ne-brightness>—</div></div>
          <div class="stat"><div class="label">COORDINATES</div><div class="value" data-ne-coords>—</div></div>
        </div>
        <div class="actions" style="margin-top:6px"><button class="action" data-ne-action="measure">MEASURE CENTER</button></div>
      </div>

      <div class="section">
        <div class="sect"><span>DARK-SKY FINDER</span><span>≤ 90 MIN DRIVE</span></div>
        <div class="finder">
          <button class="action" data-ne-action="find-dark">FIND DARKEST ≤ 90 MIN</button>
          <div class="finding" data-ne-finder style="margin-top:7px">Uses VIIRS night-light brightness, then verifies candidates with God's Eye car routing.</div>
        </div>
      </div>

      <div class="note">Actual NASA date is shown above the preview. If the requested date is missing, v1.1 automatically walks backwards until NASA has data. Darkness Index is relative satellite brightness, not Bortle/SQM.</div>
    </div>`;
  button.onclick=togglePanel;
  return {button,panel};
}

export function initNightEarthSafe({viewer,dataManager=null}={}){
  if(!viewer?.scene)throw new Error('Night Earth requires Cesium Viewer');

  const ds=new Cesium.CustomDataSource(DATA_SOURCE_NAME);
  viewer.dataSources.add(ds);

  let panelOpen=false,overlayEnabled=false,daysAgo=DEFAULT_DAYS_AGO,intensity=1;
  let lastImageData=null,lastBounds=null,lastActualDate=null,lastObjectUrl=null;
  let renderedCount=0,finderResults=[],serial=0,cameraTimer=null,destroyed=false;

  const ui=createUi(()=>panelOpen?closePanel():openPanel());

  function renderState(){
    ui.button.classList.toggle('active',panelOpen);
    ui.panel.querySelector('[data-ne-overlay-state]').textContent=
      `${overlayEnabled?'ON':'OFF'} · ${renderedCount}/${GRID_COLS*GRID_ROWS}`;
    const b=ui.panel.querySelector('[data-ne-action="overlay"]');
    b.textContent=overlayEnabled?'OVERLAY OFF':'OVERLAY ON';
    b.classList.toggle('active',overlayEnabled);
    ui.panel.querySelector('[data-ne-days-label]').textContent=`${daysAgo} DAYS AGO`;
    ui.panel.querySelector('[data-ne-intensity-label]').textContent=`${Math.round(intensity*100)}%`;
  }

  function openPanel(){panelOpen=true;ui.panel.hidden=false;renderState();void refreshView()}
  function closePanel(){panelOpen=false;ui.panel.hidden=true;renderState()}
  function clearOverlay(){renderedCount=0;ds.entities.removeAll();viewer.scene.requestRender();renderState()}

  function renderGrid(img,bounds){
    clearOverlay();
    if(!overlayEnabled||!img||!bounds)return;

    for(let row=0;row<GRID_ROWS;row++){
      for(let col=0;col<GRID_COLS;col++){
        const fx=(col+.5)/GRID_COLS,fy=(row+.5)/GRID_ROWS;
        const lon=bounds.west+fx*(bounds.east-bounds.west);
        const lat=bounds.north-fy*(bounds.north-bounds.south);
        const s=sampleImage(img,bounds,lat,lon,4);
        if(!s)continue;

        ds.entities.add({
          position:Cesium.Cartesian3.fromDegrees(lon,lat,1200),
          point:{
            pixelSize:pointSize(s.darkness,intensity),
            color:overlayColor(s.darkness),
            outlineColor:Cesium.Color.WHITE.withAlpha(.20),
            outlineWidth:1,
            disableDepthTestDistance:Number.POSITIVE_INFINITY,
          },
          properties:{darknessIndex:s.darkness,viirsBrightness:s.brightness},
        });
        renderedCount++;
      }
    }
    renderState();
    viewer.scene.requestRender();
  }

  async function refreshView(){
    const my=++serial,bounds=viewRectangle(viewer);
    if(!bounds)return {ok:false,error:'Could not resolve map view'};
    const requested=isoDateDaysAgo(daysAgo);
    const box=ui.panel.querySelector('[data-ne-preview-box]');
    const err=ui.panel.querySelector('[data-ne-error]');
    box.classList.remove('failed');
    err.textContent='NASA VIIRS data unavailable.';

    try{
      const data=await fetchNightImage(bounds,requested,700,430);
      if(my!==serial||destroyed){data.bitmap.close?.();return {ok:false,cancelled:true}}
      const imageData=imageDataFromBitmap(data.bitmap);

      lastImageData=imageData;lastBounds=bounds;lastActualDate=data.actualDate;

      if(lastObjectUrl)URL.revokeObjectURL(lastObjectUrl);
      lastObjectUrl=URL.createObjectURL(data.blob);
      ui.panel.querySelector('[data-ne-preview]').src=lastObjectUrl;

      ui.panel.querySelector('[data-ne-date-label]').textContent=dateLabel(data.actualDate);
      ui.panel.querySelector('[data-ne-date-detail]').textContent=
        `${data.sourceLabel} · ${data.actualDate}`
        + (data.fallbackDays>0 ? ` · FALLBACK ${data.fallbackDays} DAYS` : '');

      if(overlayEnabled)renderGrid(imageData,bounds);
      return {
        ok:true,
        action:'night_earth_refresh',
        requestedDate:requested,
        actualDate:data.actualDate,
        fallbackDays:data.fallbackDays,
        source:data.sourceId,
        sourceLabel:data.sourceLabel
      };
    }catch(error){
      box.classList.add('failed');
      err.textContent=error?.message||String(error);
      ui.panel.querySelector('[data-ne-date-label]').textContent='NO DATA';
      if(overlayEnabled)clearOverlay();
      return {ok:false,action:'night_earth_refresh',error:error?.message||String(error)};
    }
  }

  async function toggleOverlay(){
    overlayEnabled=!overlayEnabled;
    renderState();
    if(!overlayEnabled){clearOverlay();return {ok:true,enabled:false}}
    if(lastImageData&&lastBounds){renderGrid(lastImageData,lastBounds);return {ok:true,enabled:true,renderedCount}}
    await refreshView();
    return {ok:true,enabled:true,renderedCount};
  }

  async function measureCenter(){
    const p=mapCenter(viewer);
    if(!p)return {ok:false,error:'Map center unavailable'};
    const dark=ui.panel.querySelector('[data-ne-darkness]');
    const cls=ui.panel.querySelector('[data-ne-class]');
    const bri=ui.panel.querySelector('[data-ne-brightness]');
    const coo=ui.panel.querySelector('[data-ne-coords]');
    dark.textContent='…';cls.textContent='SAMPLING';bri.textContent='—';coo.textContent=`${p.lat.toFixed(4)}°, ${p.lon.toFixed(4)}°`;

    if(!lastImageData||!lastBounds||p.lon<lastBounds.west||p.lon>lastBounds.east||p.lat<lastBounds.south||p.lat>lastBounds.north){
      await refreshView();
    }
    const s=lastImageData&&lastBounds?sampleImage(lastImageData,lastBounds,p.lat,p.lon,5):null;
    if(!s){dark.textContent='—';cls.textContent='NO VALID SAMPLE';return {ok:false,error:'No valid VIIRS sample'}}

    dark.textContent=`${s.darkness}/100`;cls.textContent=darknessClass(s.darkness);bri.textContent=s.brightness.toFixed(1);
    return {ok:true,action:'night_earth_measure',coordinates:p,darknessIndex:s.darkness,class:darknessClass(s.darkness),actualDate:lastActualDate};
  }

  async function routeCandidate(origin,dest){
    const coords=`${origin.lon.toFixed(6)},${origin.lat.toFixed(6)};${dest.lon.toFixed(6)},${dest.lat.toFixed(6)}`;
    const r=await fetch(`/api/route?profile=car&coords=${encodeURIComponent(coords)}`,{cache:'no-store'});
    if(!r.ok)return null;
    const p=await r.json();
    return p?.ok&&Number.isFinite(Number(p.durationS))?p:null;
  }

  async function placeName(point){
    try{
      const r=await fetch(`/api/regional-brief?lat=${point.lat.toFixed(6)}&lon=${point.lon.toFixed(6)}`,{cache:'no-store'});
      if(!r.ok)return null;
      const d=await r.json(),p=d?.place||{};
      return p.locality||p.region||p.country||null;
    }catch{return null}
  }

  function candidates(origin){
    const out=[];
    for(const km of [18,30,45,60,78,98,118,138]){
      for(let b=0;b<360;b+=30)out.push({...pointAtDistance(origin.lat,origin.lon,b,km),km,b});
    }
    return out;
  }

  async function findDarkWithin90(){
    const box=ui.panel.querySelector('[data-ne-finder]'),origin=mapCenter(viewer);
    if(!origin)return {ok:false,error:'Map center unavailable'};
    const list=candidates(origin),bounds=searchBounds([origin,...list]);

    box.textContent='STEP 1/3 · LOADING NASA VIIRS…';
    let data;
    try{
      data=await fetchNightImage(bounds,isoDateDaysAgo(daysAgo),760,760);
    }catch(error){
      box.textContent=`NASA VIIRS unavailable: ${error?.message||error}`;
      return {ok:false,error:error?.message||String(error)};
    }
    const img=imageDataFromBitmap(data.bitmap);

    box.textContent='STEP 2/3 · RANKING DARK AREAS…';
    const ranked=[];
    for(const c of list){
      const s=sampleImage(img,bounds,c.lat,c.lon,4);
      if(s)ranked.push({...c,...s});
    }
    ranked.sort((a,b)=>(b.darkness-a.darkness)||(a.km-b.km));

    const shortlist=[];
    for(const c of ranked){
      if(shortlist.every(s=>Math.abs(s.b-c.b)>=25||Math.abs(s.km-c.km)>=20))shortlist.push(c);
      if(shortlist.length>=16)break;
    }

    box.textContent='STEP 3/3 · VERIFYING CAR ROUTES ≤ 90 MIN…';
    const reachable=[];
    for(let i=0;i<shortlist.length;i++){
      const c=shortlist[i];
      box.textContent=`STEP 3/3 · ROUTE ${i+1}/${shortlist.length} · FOUND ${reachable.length}`;
      try{
        const route=await routeCandidate(origin,c);
        if(route&&route.durationS<=ROUTE_LIMIT_SECONDS)reachable.push({...c,durationS:route.durationS,distanceM:route.distanceM});
      }catch{}
      if(reachable.length>=4)break;
    }
    reachable.sort((a,b)=>(b.darkness-a.darkness)||(a.durationS-b.durationS));
    finderResults=reachable.slice(0,3);
    await Promise.all(finderResults.map(async r=>{r.place=await placeName(r)}));

    if(!finderResults.length){
      box.textContent='No darker road-reachable candidate confirmed within 90 minutes.';
      return {ok:true,results:[]};
    }

    box.innerHTML=finderResults.map((r,i)=>`
      <div class="result"><div>
        <div class="result-main">#${i+1} · ${esc(r.place||'DARK CANDIDATE')} · ${r.darkness}/100</div>
        <div class="result-sub">${Math.round(r.durationS/60)} min · ${(r.distanceM/1000).toFixed(1)} km · ${r.lat.toFixed(4)}°, ${r.lon.toFixed(4)}°</div>
      </div><button class="fly" data-ne-fly="${i}">FLY</button></div>`).join('');

    return {
      ok:true,
      action:'night_earth_find_dark',
      actualDate:data.actualDate,
      source:data.sourceId,
      sourceLabel:data.sourceLabel,
      results:finderResults
    };
  }

  function fly(i){
    const r=finderResults[i];if(!r)return false;
    viewer.camera.flyTo({destination:Cesium.Cartesian3.fromDegrees(r.lon,r.lat,12000),orientation:{heading:0,pitch:Cesium.Math.toRadians(-58),roll:0},duration:2.2});
    return true;
  }

  function onMoveEnd(){
    if(!overlayEnabled||destroyed)return;
    clearTimeout(cameraTimer);
    cameraTimer=setTimeout(()=>{if(!destroyed&&overlayEnabled)void refreshView()},500);
  }
  viewer.camera.moveEnd.addEventListener(onMoveEnd);

  ui.panel.addEventListener('click',e=>{
    const action=e.target.closest('[data-ne-action]')?.dataset.neAction;
    if(action==='overlay')void toggleOverlay();
    if(action==='refresh')void refreshView();
    if(action==='measure')void measureCenter();
    if(action==='find-dark')void findDarkWithin90();
    if(action==='astro'){try{dataManager?.setEnabled?.('astro-mode',true)}catch{};if(!overlayEnabled)void toggleOverlay()}
    const f=e.target.closest('[data-ne-fly]');if(f)fly(Number(f.dataset.neFly));
    if(e.target.closest('[data-ne-close]'))closePanel();
  });

  ui.panel.querySelector('[data-ne-days]').addEventListener('input',e=>{
    daysAgo=clamp(Math.round(Number(e.target.value)||DEFAULT_DAYS_AGO),MIN_DAYS_AGO,MAX_DAYS_AGO);
    lastImageData=null;lastBounds=null;renderState();if(panelOpen)void refreshView();
  });
  ui.panel.querySelector('[data-ne-intensity]').addEventListener('input',e=>{
    intensity=clamp((Number(e.target.value)||100)/100,.45,1.4);renderState();
    if(overlayEnabled&&lastImageData&&lastBounds)renderGrid(lastImageData,lastBounds);
  });

  renderState();

  return Object.freeze({
    open:openPanel,close:closePanel,refresh:refreshView,toggleOverlay,measureCenter,findDarkWithin90,
    getState(){return{panelOpen,overlayEnabled,daysAgo,intensity,renderedCount,actualDate:lastActualDate,mapSafe:true}},
    destroy(){
      destroyed=true;clearTimeout(cameraTimer);
      viewer.camera.moveEnd.removeEventListener(onMoveEnd);
      clearOverlay();try{viewer.dataSources.remove(ds,true)}catch{}
      if(lastObjectUrl)URL.revokeObjectURL(lastObjectUrl);
      ui.panel.remove();ui.button.remove();document.getElementById(STYLE_ID)?.remove();
    }
  });
}

export default initNightEarthSafe;
