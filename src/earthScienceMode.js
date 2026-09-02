import * as Cesium from 'cesium';

const PANEL_ID='sz-earth-science-panel';
const BUTTON_ID='sz-earth-science-button';
const STYLE_ID='sz-earth-science-style';
const SOURCE_NAME='Solums Zeestar Earth Science';

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const deg=r=>Cesium.Math.toDegrees(r);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));

function fmt(v,d=0){
  const n=Number(v);
  return Number.isFinite(n)?new Intl.NumberFormat('nb-NO',{maximumFractionDigits:d}).format(n):'—';
}

function pickGround(viewer,pos){
  let p=null;
  try{
    if(viewer.scene.pickPositionSupported){
      const q=viewer.scene.pickPosition(pos);
      if(Cesium.defined(q))p=q;
    }
  }catch{}
  if(!p){
    try{
      const ray=viewer.camera.getPickRay(pos);
      p=ray?viewer.scene.globe?.pick(ray,viewer.scene):null;
    }catch{}
  }
  if(!p){
    try{p=viewer.camera.pickEllipsoid(pos,viewer.scene.globe.ellipsoid)}catch{}
  }
  if(!p)return null;
  const c=Cesium.Cartographic.fromCartesian(p);
  return {lat:deg(c.latitude),lon:deg(c.longitude),heightM:Number(c.height)||0};
}

function center(viewer){
  const c=viewer.scene.canvas;
  return pickGround(viewer,new Cesium.Cartesian2(c.clientWidth/2,c.clientHeight/2));
}

function bounds(viewer){
  const ctr=center(viewer);
  if(!ctr)return null;
  try{
    const r=viewer.camera.computeViewRectangle(viewer.scene.globe.ellipsoid);
    if(r){
      let west=deg(r.west),east=deg(r.east),south=deg(r.south),north=deg(r.north);
      if(east>west&&east-west<150&&north>south){
        const max=18;
        if(east-west>max){west=ctr.lon-max/2;east=ctr.lon+max/2}
        if(north-south>max){south=ctr.lat-max/2;north=ctr.lat+max/2}
        return {west,east,south:clamp(south,-84,84),north:clamp(north,-84,84),center:ctr};
      }
    }
  }catch{}
  const alt=Math.max(1000,Number(viewer.camera.positionCartographic?.height)||10000);
  const span=clamp(alt/140000,.08,18);
  const dx=span/Math.max(.25,Math.cos(Cesium.Math.toRadians(ctr.lat)));
  return {west:ctr.lon-dx,east:ctr.lon+dx,south:ctr.lat-span,north:ctr.lat+span,center:ctr};
}

function lithology(unit){
  const v=unit?.lith||unit?.lithology||unit?.liths;
  if(Array.isArray(v))return v.map(x=>typeof x==='string'?x:(x?.name||x?.lith||'')).filter(Boolean).join(', ');
  return typeof v==='string'?v:(unit?.descrip||unit?.description||null);
}

function age(unit){
  const name=unit?.interval_name||unit?.age||null;
  const t=Number(unit?.t_age),b=Number(unit?.b_age);
  const range=Number.isFinite(t)&&Number.isFinite(b)?`${fmt(b,2)}–${fmt(t,2)} Ma`:null;
  return [name,range].filter(Boolean).join(' · ')||null;
}

function history(unit){
  if(!unit)return 'Ingen geologisk enhet ble funnet for dette punktet.';
  const text=[unit?.name,unit?.strat_name,unit?.descrip,unit?.description,lithology(unit)].filter(Boolean).join(' ').toLowerCase();
  let process='Denne berggrunnen representerer en del av områdets geologiske utvikling.';
  if(/gneiss|schist|metamorph|amphibol|quartzite|marble|marmor/.test(text))
    process='Bergarten er metamorf og er omdannet av høyt trykk og/eller temperatur etter at den opprinnelige bergarten ble dannet.';
  else if(/granite|granodior|diorite|gabbro|plutonic|intrusive/.test(text))
    process='Bergarten er magmatisk og størknet langsomt fra magma nede i jordskorpen før erosjon senere blottla den.';
  else if(/basalt|rhyolite|andesite|volcan|lava|tuff/.test(text))
    process='Bergarten er vulkansk og ble dannet gjennom utbrudd, lavastrømmer eller avsetning av vulkansk materiale.';
  else if(/sandstone|shale|mudstone|limestone|dolomite|conglomer|sediment/.test(text))
    process='Bergarten er sedimentær og ble avsatt som sediment før den ble komprimert og sementert til fast bergart.';

  const parts=[];
  if(lithology(unit))parts.push(`Kartlagt bergart/litologi: ${lithology(unit)}.`);
  if(age(unit))parts.push(`Kartlagt alder: ${age(unit)}.`);
  parts.push(process);
  const b=Number(unit?.b_age),t=Number(unit?.t_age);
  if(Number.isFinite(b)&&Number.isFinite(t)){
    const m=(b+t)/2;
    if(m>2500)parts.push('Dette er svært gammel prekambrisk skorpe fra en tidlig fase i kontinentenes utvikling.');
    else if(m>541)parts.push('Berggrunnen er prekambrisk og eldre enn fanerozoikum.');
    else if(m>252)parts.push('Alderen plasserer berggrunnen i paleozoikum.');
    else if(m>66)parts.push('Alderen plasserer berggrunnen i mesozoikum.');
    else parts.push('Berggrunnen er geologisk relativt ung og stammer fra kenozoikum.');
  }
  return parts.join(' ');
}

function ensureStyle(){
  document.getElementById(STYLE_ID)?.remove();
  const s=document.createElement('style');
  s.id=STYLE_ID;
  s.textContent=`
#${BUTTON_ID}{position:fixed;right:18px;bottom:316px;z-index:2060;border:1px solid rgba(101,224,255,.34);border-radius:9px;background:rgba(4,13,22,.93);color:#ccf8ff;padding:9px 11px;font:800 10px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.11em;cursor:pointer;backdrop-filter:blur(12px)}
#${BUTTON_ID}.active,#${BUTTON_ID}:hover{border-color:#72ecff;background:rgba(23,93,120,.38);color:white}
#${PANEL_ID}{position:fixed;right:18px;top:72px;z-index:2058;width:min(520px,calc(100vw - 30px));max-height:calc(100vh - 145px);overflow:auto;border:1px solid rgba(91,220,255,.26);border-radius:13px;background:linear-gradient(180deg,rgba(4,13,22,.975),rgba(2,7,12,.975));color:#eafaff;box-shadow:0 20px 64px rgba(0,0,0,.48);backdrop-filter:blur(15px);font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
#${PANEL_ID}[hidden]{display:none!important}
#${PANEL_ID} .head{position:sticky;top:0;z-index:2;display:flex;justify-content:space-between;align-items:center;padding:11px 12px;background:rgba(4,13,21,.96);border-bottom:1px solid rgba(97,220,255,.11)}
#${PANEL_ID} .title{font-size:10px;font-weight:900;letter-spacing:.16em;color:#72eaff}
#${PANEL_ID} .sub{font-size:8px;color:rgba(205,235,246,.46);margin-top:3px}
#${PANEL_ID} button{font:inherit} #${PANEL_ID} .close{border:0;background:transparent;color:#91b6c3;font-size:20px;cursor:pointer}
#${PANEL_ID} .body{padding:12px} #${PANEL_ID} .safe{border:1px solid rgba(78,235,170,.17);border-radius:8px;padding:7px;color:#86f1c3;background:rgba(31,137,91,.06);font-size:8px}
#${PANEL_ID} .section{margin-top:11px} #${PANEL_ID} .sect{display:flex;justify-content:space-between;gap:8px;color:#6de7ff;font-size:8px;font-weight:900;letter-spacing:.13em;margin-bottom:6px}
#${PANEL_ID} .actions{display:flex;gap:6px;flex-wrap:wrap} #${PANEL_ID} .action{border:1px solid rgba(92,219,249,.18);background:rgba(48,153,191,.07);color:#bceef8;border-radius:6px;padding:8px 9px;font-size:8px;cursor:pointer}
#${PANEL_ID} .action.active,#${PANEL_ID} .action:hover{border-color:rgba(104,230,255,.55);background:rgba(48,153,191,.18);color:#fff}
#${PANEL_ID} .grid{display:grid;grid-template-columns:1fr 1fr;gap:6px} #${PANEL_ID} .stat{border:1px solid rgba(100,213,245,.09);border-radius:6px;padding:7px;background:rgba(255,255,255,.015)}
#${PANEL_ID} .label{font-size:7px;color:#6e94a2;letter-spacing:.1em} #${PANEL_ID} .value{font-size:10px;color:#effbff;font-weight:800;margin-top:3px;line-height:1.35}
#${PANEL_ID} .history{font:12px/1.52 system-ui,-apple-system,sans-serif;color:#d7eef4;border-left:2px solid rgba(95,220,255,.27);padding-left:9px}
#${PANEL_ID} .list{display:grid;gap:5px} #${PANEL_ID} .item{border:1px solid rgba(100,213,245,.08);border-radius:6px;padding:7px;background:rgba(255,255,255,.012)}
#${PANEL_ID} .item-main{font-size:9px;color:#eafaff} #${PANEL_ID} .item-sub{font-size:7px;color:#7496a3;margin-top:3px;line-height:1.4}
#${PANEL_ID} .bathy{position:relative;overflow:hidden;border:1px solid rgba(100,213,245,.1);border-radius:8px;background:#02050a;aspect-ratio:1.75/1}
#${PANEL_ID} .bathy img{width:100%;height:100%;object-fit:cover;display:block} #${PANEL_ID} .bathy-label{position:absolute;left:7px;bottom:6px;padding:4px 6px;border-radius:4px;background:rgba(0,0,0,.62);font-size:7px;color:#bfeaf4}
#${PANEL_ID} .status{font-size:8px;color:#81dff1;line-height:1.45} #${PANEL_ID} .note{margin-top:10px;font:9px/1.45 system-ui,-apple-system,sans-serif;color:#678793}
@media(max-width:820px){#${BUTTON_ID}{right:12px;bottom:326px}#${PANEL_ID}{right:12px;top:64px;width:calc(100vw - 24px)}}`;
  document.head.appendChild(s);
}

function createUi(toggle){
  ensureStyle();
  let button=document.getElementById(BUTTON_ID);
  if(!button){button=document.createElement('button');button.id=BUTTON_ID;button.type='button';button.textContent='⛰ EARTH SCIENCE';document.body.appendChild(button)}
  let panel=document.getElementById(PANEL_ID);
  if(!panel){panel=document.createElement('aside');panel.id=PANEL_ID;document.body.appendChild(panel)}
  panel.hidden=true;
  panel.innerHTML=`
<div class="head"><div><div class="title">⛰ EARTH SCIENCE MODE</div><div class="sub">GEOLOGY · FAULTS · VOLCANOES · MINERALS · BATHYMETRY</div></div><button class="close" data-es-close>×</button></div>
<div class="body">
<div class="safe">✓ MAP SAFE — Google 3D og Visual Presets endres aldri.</div>
<div class="section"><div class="sect"><span>ANALYZE</span><span data-es-pick-state>CENTER MODE</span></div><div class="actions"><button class="action" data-es-action="center">ANALYZE CENTER</button><button class="action" data-es-action="pick">PICK POINT</button><button class="action" data-es-action="refresh">REFRESH LAYERS</button></div><div class="status" data-es-status style="margin-top:7px">Klikk ANALYZE CENTER, eller aktiver PICK POINT og klikk på et fjell/område.</div></div>
<div class="section"><div class="sect"><span>EARTH LAYERS</span><span>OWN ENTITIES ONLY</span></div><div class="actions"><button class="action" data-es-toggle="faults">FAULTS OFF</button><button class="action" data-es-toggle="volcanoes">VOLCANOES OFF</button><button class="action" data-es-toggle="minerals">MINERALS OFF</button></div></div>
<div class="section"><div class="sect"><span>SELECTED POINT</span><span data-es-place>—</span></div><div class="grid">
<div class="stat"><div class="label">COORDINATES</div><div class="value" data-es-coords>—</div></div>
<div class="stat"><div class="label">ELEVATION / DEPTH</div><div class="value" data-es-elevation>—</div></div>
<div class="stat"><div class="label">GEOLOGIC UNIT</div><div class="value" data-es-unit>—</div></div>
<div class="stat"><div class="label">AGE</div><div class="value" data-es-age>—</div></div>
<div class="stat"><div class="label">LITHOLOGY / ROCK</div><div class="value" data-es-lith>—</div></div>
<div class="stat"><div class="label">MAP SOURCE</div><div class="value" data-es-source>—</div></div>
</div></div>
<div class="section"><div class="sect"><span>GEOLOGICAL HISTORY</span><span>INTERPRETATION</span></div><div class="history" data-es-history>Velg et punkt for geologisk historie.</div></div>
<div class="section"><div class="sect"><span>NEARBY TECTONICS</span><span data-es-tectonics-count>—</span></div><div class="list" data-es-tectonics></div></div>
<div class="section"><div class="sect"><span>NEARBY VOLCANOES</span><span data-es-volcano-count>—</span></div><div class="list" data-es-volcanoes></div></div>
<div class="section"><div class="sect"><span>MINERAL OCCURRENCES</span><span data-es-mineral-count>—</span></div><div class="list" data-es-minerals></div></div>
<div class="section"><div class="sect"><span>GEBCO 2026 · BATHYMETRY</span><span>SUB-ICE TOPOGRAPHY</span></div><div class="bathy"><img data-es-bathy alt="GEBCO bathymetry"><span class="bathy-label">CURRENT MAP AREA · SAFE PREVIEW</span></div></div>
<div class="note">Geologic units: Macrostrat. Active faults: GEM GAF-DB. Volcanoes: Smithsonian GVP. Minerals: USGS MRDS. Bathymetry/elevation: GEBCO.</div>
</div>`;
  button.onclick=toggle;
  return {button,panel};
}

export function initEarthScienceMode({viewer}={}){
  if(!viewer?.scene)throw new Error('Earth Science requires Cesium Viewer');
  const ds=new Cesium.CustomDataSource(SOURCE_NAME);
  viewer.dataSources.add(ds);

  let panelOpen=false,pickMode=false;
  let layerState={faults:false,volcanoes:false,minerals:false};
  let lastLayers=null,currentPoint=null;

  const ui=createUi(()=>panelOpen?close():open());
  const handler=new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);

  function open(){panelOpen=true;ui.panel.hidden=false;ui.button.classList.add('active');renderButtons();renderPick();refreshBathy()}
  function close(){panelOpen=false;pickMode=false;ui.panel.hidden=true;ui.button.classList.remove('active');renderPick()}
  function status(t){ui.panel.querySelector('[data-es-status]').textContent=t}

  function typeOf(e){try{return e.properties?.esType?.getValue?.()}catch{return null}}
  function clearType(type){for(const e of [...ds.entities.values])if(typeOf(e)===type)ds.entities.remove(e)}

  function renderButtons(){
    ui.panel.querySelectorAll('[data-es-toggle]').forEach(b=>{
      const k=b.dataset.esToggle,on=layerState[k];
      b.textContent=`${k.toUpperCase()} ${on?'ON':'OFF'}`;b.classList.toggle('active',on);
    });
  }
  function renderPick(){
    const b=ui.panel.querySelector('[data-es-action="pick"]');
    b.textContent=pickMode?'CLICK MAP…':'PICK POINT';b.classList.toggle('active',pickMode);
    ui.panel.querySelector('[data-es-pick-state]').textContent=pickMode?'PICK ACTIVE':'CENTER MODE';
  }

  function renderFaults(features=[]){
    clearType('fault'); if(!layerState.faults)return;
    for(const f of features.slice(0,180)){
      const g=f.geometry,p=f.properties||{};
      const parts=g?.type==='MultiLineString'?g.coordinates:g?.type==='LineString'?[g.coordinates]:[];
      for(const line of parts){
        const a=(line||[]).flatMap(c=>[Number(c[0]),Number(c[1])]);
        if(a.length<4||a.some(x=>!Number.isFinite(x)))continue;
        ds.entities.add({polyline:{positions:Cesium.Cartesian3.fromDegreesArray(a),width:2.2,material:Cesium.Color.fromCssColorString('#ff5f52').withAlpha(.9),clampToGround:true},properties:{esType:'fault',name:p.name||p.fault_name||'Active fault'}});
      }
    }
  }
  function renderVolcanoes(features=[]){
    clearType('volcano'); if(!layerState.volcanoes)return;
    for(const f of features.slice(0,180)){
      const c=f.geometry?.coordinates,p=f.properties||{};
      if(!Array.isArray(c))continue;
      ds.entities.add({position:Cesium.Cartesian3.fromDegrees(Number(c[0]),Number(c[1]),2200),point:{pixelSize:10,color:Cesium.Color.fromCssColorString('#ff7547'),outlineColor:Cesium.Color.WHITE,outlineWidth:1,disableDepthTestDistance:Number.POSITIVE_INFINITY},label:{text:String(p.VolcanoName||p.Volcano_Name||p.name||''),font:'10px ui-monospace',fillColor:Cesium.Color.WHITE,showBackground:true,backgroundColor:Cesium.Color.BLACK.withAlpha(.62),pixelOffset:new Cesium.Cartesian2(0,-14),distanceDisplayCondition:new Cesium.DistanceDisplayCondition(0,900000),disableDepthTestDistance:Number.POSITIVE_INFINITY},properties:{esType:'volcano'}});
    }
  }
  function renderMinerals(features=[]){
    clearType('mineral'); if(!layerState.minerals)return;
    for(const f of features.slice(0,240)){
      const c=f.geometry?.coordinates;if(!Array.isArray(c))continue;
      ds.entities.add({position:Cesium.Cartesian3.fromDegrees(Number(c[0]),Number(c[1]),900),point:{pixelSize:6,color:Cesium.Color.fromCssColorString('#f2c84b'),outlineColor:Cesium.Color.BLACK,outlineWidth:1,disableDepthTestDistance:Number.POSITIVE_INFINITY},properties:{esType:'mineral'}});
    }
  }
  function renderLayers(){renderFaults(lastLayers?.faults?.features||[]);renderVolcanoes(lastLayers?.volcanoes?.features||[]);renderMinerals(lastLayers?.minerals?.features||[]);viewer.scene.requestRender()}

  async function refreshLayers(){
    const b=bounds(viewer);if(!b)return;
    status('Loading Earth Science layers…');
    const q=new URLSearchParams({west:b.west,south:b.south,east:b.east,north:b.north});
    try{
      const r=await fetch(`/api/earth-science/layers?${q}`,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);
      lastLayers=await r.json();renderLayers();
      status(`Layers ready · faults ${lastLayers.faults?.features?.length||0} · volcanoes ${lastLayers.volcanoes?.features?.length||0} · minerals ${lastLayers.minerals?.features?.length||0}`);
    }catch(e){status(`Layer load failed: ${e.message}`)}
  }

  function refreshBathy(){
    const b=bounds(viewer);if(!b)return;
    const q=new URLSearchParams({west:b.west,south:b.south,east:b.east,north:b.north,width:800,height:450});
    ui.panel.querySelector('[data-es-bathy]').src=`/api/earth-science/bathymetry?${q}`;
  }

  function listHtml(items,kind){
    if(!items?.length)return '<div class="item"><div class="item-main">None returned.</div></div>';
    return items.slice(0,6).map(x=>`<div class="item"><div class="item-main">${esc(x.name||kind)}</div><div class="item-sub">${esc(x.detail||'')}${Number.isFinite(x.distanceKm)?` · ${fmt(x.distanceKm,1)} km`:''}</div></div>`).join('');
  }

  function renderPoint(data){
    const p=data.point||currentPoint||{},u=data.geology?.unit,pl=data.place||{},z=Number(data.elevationM);
    ui.panel.querySelector('[data-es-place]').textContent=pl.locality||pl.region||pl.country||'—';
    ui.panel.querySelector('[data-es-coords]').textContent=Number.isFinite(p.lat)?`${p.lat.toFixed(5)}°, ${p.lon.toFixed(5)}°`:'—';
    ui.panel.querySelector('[data-es-elevation]').textContent=Number.isFinite(z)?(z<0?`${fmt(Math.abs(z))} m below sea level`:`${fmt(z)} m elevation`):'—';
    ui.panel.querySelector('[data-es-unit]').textContent=u?.strat_name||u?.name||u?.descrip||'—';
    ui.panel.querySelector('[data-es-age]').textContent=age(u)||'—';
    ui.panel.querySelector('[data-es-lith]').textContent=lithology(u)||'—';
    ui.panel.querySelector('[data-es-source]').textContent=u?.source||u?.ref?.authors||'Macrostrat';
    ui.panel.querySelector('[data-es-history]').textContent=history(u);
    ui.panel.querySelector('[data-es-tectonics-count]').textContent=`${data.nearbyFaults?.length||0} NEARBY`;
    ui.panel.querySelector('[data-es-tectonics]').innerHTML=listHtml(data.nearbyFaults,'Active fault');
    ui.panel.querySelector('[data-es-volcano-count]').textContent=`${data.nearbyVolcanoes?.length||0} NEARBY`;
    ui.panel.querySelector('[data-es-volcanoes]').innerHTML=listHtml(data.nearbyVolcanoes,'Volcano');
    ui.panel.querySelector('[data-es-mineral-count]').textContent=`${data.nearbyMinerals?.length||0} NEARBY`;
    ui.panel.querySelector('[data-es-minerals]').innerHTML=listHtml(data.nearbyMinerals,'Mineral occurrence');
  }

  async function analyzePoint(p){
    if(!p)return;
    currentPoint=p;status('Analyzing geology, faults, volcanoes, minerals and elevation…');
    clearType('selected');
    ds.entities.add({position:Cesium.Cartesian3.fromDegrees(p.lon,p.lat,1500),point:{pixelSize:11,color:Cesium.Color.CYAN,outlineColor:Cesium.Color.WHITE,outlineWidth:2,disableDepthTestDistance:Number.POSITIVE_INFINITY},properties:{esType:'selected'}});
    const q=new URLSearchParams({lat:p.lat.toFixed(6),lon:p.lon.toFixed(6)});
    try{
      const r=await fetch(`/api/earth-science/point?${q}`,{cache:'no-store'});if(!r.ok)throw new Error(`HTTP ${r.status}`);
      const d=await r.json();renderPoint(d);status('Earth Science analysis ready.');return d;
    }catch(e){status(`Analysis failed: ${e.message}`)}
  }

  handler.setInputAction(c=>{
    if(!pickMode)return;
    const p=pickGround(viewer,c.position);
    if(p){pickMode=false;renderPick();void analyzePoint(p)}
  },Cesium.ScreenSpaceEventType.LEFT_CLICK);

  ui.panel.addEventListener('click',e=>{
    const a=e.target.closest('[data-es-action]')?.dataset.esAction;
    if(a==='center')void analyzePoint(center(viewer));
    if(a==='pick'){pickMode=!pickMode;renderPick();status(pickMode?'Klikk på fjellet/området i kartet.':'Pick mode cancelled.')}
    if(a==='refresh'){void refreshLayers();refreshBathy()}
    const t=e.target.closest('[data-es-toggle]')?.dataset.esToggle;
    if(t){layerState[t]=!layerState[t];renderButtons();if(lastLayers)renderLayers();else void refreshLayers()}
    if(e.target.closest('[data-es-close]'))close();
  });

  renderButtons();renderPick();
  return Object.freeze({open,close,analyzeCenter(){return analyzePoint(center(viewer))},analyzePoint,refreshLayers,getState(){return{panelOpen,pickMode,layerState:{...layerState},currentPoint,mapSafe:true}},destroy(){handler.destroy();ds.entities.removeAll();try{viewer.dataSources.remove(ds,true)}catch{}ui.panel.remove();ui.button.remove();document.getElementById(STYLE_ID)?.remove()}});
}
export default initEarthScienceMode;
