const MACRO='https://macrostrat.org/api/v2';
const GEM='https://services3.arcgis.com/zmk8NL9pBXO4ybJQ/arcgis/rest/services/Earthquake_and_Fault_Locations/FeatureServer/1/query';
const GVP='https://webservices.volcano.si.edu/geoserver/GVP-VOTW/ows';
const MRDS='https://energy.usgs.gov/arcgis/rest/services/Hosted/Mineral_Resource_Data_System/FeatureServer/0/query';
const GEBCO='https://wms.gebco.net/mapserv?';
const TIMEOUT=15000;

const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const finite=v=>{const n=Number(v);return Number.isFinite(n)?n:null};
const clean=(v,n=180)=>String(v??'').replace(/\s+/g,' ').trim().slice(0,n);

async function j(url){
  const r=await fetch(url,{signal:AbortSignal.timeout(TIMEOUT),headers:{'User-Agent':'Solums-Zeestar-Earth-Science/1.0'}});
  if(!r.ok)throw new Error(`HTTP ${r.status}`);
  return r.json();
}

function km(a,b){
  const R=6371.0088,p1=a.lat*Math.PI/180,p2=b.lat*Math.PI/180;
  const dp=(b.lat-a.lat)*Math.PI/180,dl=(b.lon-a.lon)*Math.PI/180;
  const h=Math.sin(dp/2)**2+Math.cos(p1)*Math.cos(p2)*Math.sin(dl/2)**2;
  return 2*R*Math.asin(Math.min(1,Math.sqrt(h)));
}

function box(lat,lon,r){
  const dy=r/110.57,dx=r/(111.32*Math.max(.18,Math.cos(lat*Math.PI/180)));
  return {west:clamp(lon-dx,-179.8,179.8),east:clamp(lon+dx,-179.8,179.8),south:clamp(lat-dy,-84,84),north:clamp(lat+dy,-84,84)};
}

async function geology(lat,lon){
  try{
    const q=new URLSearchParams({lat:String(lat),lng:String(lon)});
    const d=await j(`${MACRO}/geologic_units/map?${q}`);
    const rows=d?.success?.data||d?.data||[];
    return {unit:Array.isArray(rows)&&rows.length?rows[0]:null,all:Array.isArray(rows)?rows.slice(0,6):[],source:'Macrostrat'};
  }catch(e){return{unit:null,all:[],source:'Macrostrat',error:e.message}}
}

async function faults(b){
  try{
    const q=new URLSearchParams({f:'geojson',where:'1=1',geometry:`${b.west},${b.south},${b.east},${b.north}`,geometryType:'esriGeometryEnvelope',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'*',returnGeometry:'true',resultRecordCount:'500'});
    const d=await j(`${GEM}?${q}`);
    return {type:'FeatureCollection',features:d?.features||[]};
  }catch(e){return{type:'FeatureCollection',features:[],error:e.message}}
}

async function volcanoes(b){
  try{
    const q=new URLSearchParams({service:'WFS',version:'1.0.0',request:'GetFeature',typeName:'GVP-VOTW:Smithsonian_VOTW_Holocene_Volcanoes',outputFormat:'application/json',maxFeatures:'500',srsName:'EPSG:4326',bbox:`${b.west},${b.south},${b.east},${b.north},EPSG:4326`});
    const d=await j(`${GVP}?${q}`);
    return {type:'FeatureCollection',features:d?.features||[]};
  }catch(e){return{type:'FeatureCollection',features:[],error:e.message}}
}

async function minerals(b){
  try{
    const q=new URLSearchParams({f:'json',where:'1=1',geometry:`${b.west},${b.south},${b.east},${b.north}`,geometryType:'esriGeometryEnvelope',inSR:'4326',outSR:'4326',spatialRel:'esriSpatialRelIntersects',outFields:'*',returnGeometry:'true',resultRecordCount:'500'});
    const d=await j(`${MRDS}?${q}`);
    return {type:'FeatureCollection',features:(d?.features||[]).map(x=>({type:'Feature',geometry:x.geometry?{type:'Point',coordinates:[Number(x.geometry.x),Number(x.geometry.y)]}:null,properties:x.attributes||{}})).filter(x=>Array.isArray(x.geometry?.coordinates)&&x.geometry.coordinates.every(Number.isFinite))};
  }catch(e){return{type:'FeatureCollection',features:[],error:e.message}}
}

async function place(lat,lon){
  try{
    const q=new URLSearchParams({format:'jsonv2',lat:String(lat),lon:String(lon),zoom:'10',addressdetails:'1','accept-language':'en'});
    const d=await j(`https://nominatim.openstreetmap.org/reverse?${q}`);
    const a=d?.address||{};
    return {locality:a.city||a.town||a.village||a.municipality||null,region:a.state||a.region||a.county||null,country:a.country||null};
  }catch{return{}}
}

async function elevation(lat,lon){
  const d=.04;
  const q=new URLSearchParams({service:'WMS',version:'1.1.1',request:'GetFeatureInfo',layers:'gebco_latest_2',query_layers:'gebco_latest_2',styles:'',srs:'EPSG:4326',bbox:`${lon-d},${lat-d},${lon+d},${lat+d}`,width:'101',height:'101',x:'50',y:'50',info_format:'text/plain'});
  try{
    const r=await fetch(`${GEBCO}${q}`,{signal:AbortSignal.timeout(TIMEOUT),headers:{'User-Agent':'Solums-Zeestar-Earth-Science/1.0'}});
    if(!r.ok)return null;
    const t=await r.text();
    const m=[...t.matchAll(/(?:value|elevation|depth)[^-\d]*(-?\d+(?:\.\d+)?)/ig)];
    if(m.length)return Number(m[0][1]);
    const all=[...t.matchAll(/-?\d+(?:\.\d+)?/g)].map(x=>Number(x[0])).filter(Number.isFinite);
    return all.length?all.at(-1):null;
  }catch{return null}
}

function faultCenter(f){
  const g=f?.geometry;
  const lines=g?.type==='MultiLineString'?g.coordinates:g?.type==='LineString'?[g.coordinates]:[];
  const pts=lines.flat().filter(c=>Array.isArray(c)&&c.length>=2);
  if(!pts.length)return null;
  const lon=pts.reduce((s,c)=>s+Number(c[0]),0)/pts.length;
  const lat=pts.reduce((s,c)=>s+Number(c[1]),0)/pts.length;
  return {lat,lon};
}

function vname(p){return p?.VolcanoName||p?.Volcano_Name||p?.volcano_name||p?.name||'Volcano'}
function mname(p){return p?.site_name||p?.SITE_NAME||p?.name||p?.NAME||p?.dep_name||'Mineral occurrence'}
function commodity(p){
  return [...new Set(['commod1','commod2','commod3','COMMOD1','COMMOD2','COMMOD3','commodity','COMMODITY'].map(k=>clean(p?.[k])).filter(Boolean))].join(', ');
}

export function earthScienceProxy(){
  async function pointHandler(req,res){
    const u=new URL(req.url||'/','http://localhost');
    const lat=finite(u.searchParams.get('lat')),lon=finite(u.searchParams.get('lon'));
    if(lat==null||lon==null||Math.abs(lat)>90||Math.abs(lon)>180){
      res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'valid lat/lon required'}));return;
    }

    const p={lat,lon};
    const [geo,fs,vs,ms,z,pl]=await Promise.all([
      geology(lat,lon),faults(box(lat,lon,220)),volcanoes(box(lat,lon,600)),minerals(box(lat,lon,120)),elevation(lat,lon),place(lat,lon)
    ]);

    const nearbyFaults=(fs.features||[]).map(f=>{
      const c=faultCenter(f),a=f.properties||{};
      return c?{name:a.name||a.fault_name||a.Name||'Active fault',detail:clean(a.slip_type||a.kinematics||''),distanceKm:km(p,c)}:null;
    }).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,8);

    const nearbyVolcanoes=(vs.features||[]).map(f=>{
      const c=f.geometry?.coordinates,a=f.properties||{};
      return Array.isArray(c)?{name:vname(a),detail:clean(a.Country||a.country||''),distanceKm:km(p,{lon:Number(c[0]),lat:Number(c[1])})}:null;
    }).filter(Boolean).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,8);

    const nearbyMinerals=(ms.features||[]).map(f=>{
      const c=f.geometry?.coordinates,a=f.properties||{};
      return {name:mname(a),detail:commodity(a),distanceKm:km(p,{lon:Number(c[0]),lat:Number(c[1])})};
    }).sort((a,b)=>a.distanceKm-b.distanceKm).slice(0,10);

    const out={status:'ready',point:p,place:pl,elevationM:z,geology:geo,nearbyFaults,nearbyVolcanoes,nearbyMinerals,sources:['Macrostrat','GEM Global Active Faults','Smithsonian GVP','USGS MRDS','GEBCO 2026']};
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public,max-age=300'});
    res.end(JSON.stringify(out));
  }

  async function layersHandler(req,res){
    const u=new URL(req.url||'/','http://localhost');
    const west=finite(u.searchParams.get('west')),south=finite(u.searchParams.get('south')),east=finite(u.searchParams.get('east')),north=finite(u.searchParams.get('north'));
    if(west==null||south==null||east==null||north==null||west>=east||south>=north||east-west>25||north-south>25){
      res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'valid compact bbox required'}));return;
    }
    const b={west,south,east,north};
    const [f,v,m]=await Promise.all([faults(b),volcanoes(b),minerals(b)]);
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public,max-age=300'});
    res.end(JSON.stringify({faults:f,volcanoes:v,minerals:m}));
  }

  async function bathyHandler(req,res){
    const u=new URL(req.url||'/','http://localhost');
    const west=finite(u.searchParams.get('west')),south=finite(u.searchParams.get('south')),east=finite(u.searchParams.get('east')),north=finite(u.searchParams.get('north'));
    const width=clamp(Math.round(finite(u.searchParams.get('width'))||800),200,1200),height=clamp(Math.round(finite(u.searchParams.get('height'))||450),120,900);
    if(west==null||south==null||east==null||north==null||west>=east||south>=north){res.writeHead(400);res.end();return}
    const q=new URLSearchParams({service:'WMS',version:'1.3.0',request:'GetMap',layers:'gebco_latest_sub_ice_topo',crs:'EPSG:4326',format:'image/jpeg',width:String(width),height:String(height),bbox:`${south},${west},${north},${east}`});
    try{
      const r=await fetch(`${GEBCO}${q}`,{signal:AbortSignal.timeout(TIMEOUT),headers:{'User-Agent':'Solums-Zeestar-Earth-Science/1.0'}});
      if(!r.ok)throw new Error();
      const body=Buffer.from(await r.arrayBuffer());
      res.writeHead(200,{'Content-Type':r.headers.get('content-type')||'image/jpeg','Cache-Control':'public,max-age=1800'});res.end(body);
    }catch{res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'GEBCO unavailable'}))}
  }

  return{
    name:'solums-earth-science-proxy',
    configureServer(s){s.middlewares.use('/api/earth-science/point',pointHandler);s.middlewares.use('/api/earth-science/layers',layersHandler);s.middlewares.use('/api/earth-science/bathymetry',bathyHandler)},
    configurePreviewServer(s){s.middlewares.use('/api/earth-science/point',pointHandler);s.middlewares.use('/api/earth-science/layers',layersHandler);s.middlewares.use('/api/earth-science/bathymetry',bathyHandler)}
  };
}
export default earthScienceProxy;
