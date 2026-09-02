import { promises as fsp } from 'node:fs';
import path from 'node:path';

const CACHE_FILE = path.join(process.cwd(), '.gev-cache', 'area-intel-v2.json');
const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_ITEMS = 800;
let queue = Promise.resolve();
let lastNominatim = 0;

function cleanText(v,n=600){return String(v||'').replace(/\s+/g,' ').trim().slice(0,n)}
function norm(v){return cleanText(v,200).toLowerCase()}
function uniq(values){return [...new Set(values.filter(Boolean))]}
function numClaim(entity,pid){
  const claims=entity?.claims?.[pid]||[];
  const ranked=[...claims].sort((a,b)=>(a.rank==='preferred'?0:1)-(b.rank==='preferred'?0:1));
  for(const c of ranked){
    const n=Number(c?.mainsnak?.datavalue?.value?.amount);
    if(Number.isFinite(n)) return n;
  }
  return null;
}

async function json(url,opts={}){
  const r=await fetch(url,{...opts,signal:AbortSignal.timeout(12000)});
  if(!r.ok) throw new Error(`HTTP ${r.status}`);
  const t=await r.text();
  if(Buffer.byteLength(t,'utf8')>2*1024*1024) throw new Error('response too large');
  return JSON.parse(t);
}

async function reverseOne(lat,lon,zoom=14){
  const task=queue.then(async()=>{
    const wait=Math.max(0,1125-(Date.now()-lastNominatim));
    if(wait) await new Promise(r=>setTimeout(r,wait));
    lastNominatim=Date.now();
    const q=new URLSearchParams({
      format:'jsonv2',lat:String(lat),lon:String(lon),zoom:String(zoom),
      addressdetails:'1',extratags:'1',namedetails:'1','accept-language':'en'
    });
    return json(`https://nominatim.openstreetmap.org/reverse?${q}`,{
      headers:{'User-Agent':'Solums-Zeestar-Area-Intel/2.0'}
    });
  });
  queue=task.catch(()=>{});
  return task;
}

function placeFromNominatim(x){
  const a=x?.address||{}, ex=x?.extratags||{};
  const locality=a.city||a.town||a.village||a.municipality||a.hamlet||null;
  const district=a.city_district||a.borough||a.suburb||a.neighbourhood||a.quarter||null;
  const region=a.state||a.region||a.county||null;
  return {
    locality,district,region,country:a.country||null,countryCode:String(a.country_code||'').toUpperCase()||null,
    displayName:cleanText(x?.display_name,500),type:x?.type||x?.addresstype||null,
    population:Number(ex.population)||null,wikidata:ex.wikidata||null,wikipedia:ex.wikipedia||null,
  };
}

function areaLabel(p){
  return p?.district||p?.locality||p?.region||p?.country||null;
}

function viewType(samples){
  const places=samples.map(s=>s.place).filter(Boolean);
  const countries=uniq(places.map(p=>p.country));
  const localities=uniq(places.map(p=>p.locality));
  const districts=uniq(places.map(p=>p.district));
  if(countries.length>1) return 'Cross-border / regional view';
  if(localities.length>1) return 'Metropolitan / multi-city view';
  if(districts.length>=2) return 'Borough / neighborhood-scale view';
  if(districts.length===1) return 'Neighborhood / district view';
  if(localities.length===1) return 'City-scale view';
  return 'Regional view';
}

function analyzeViewport(samples){
  const byRole=Object.fromEntries(samples.map(s=>[s.role,s.place]));
  const places=samples.map(s=>s.place).filter(Boolean);
  const center=byRole.center||places[0]||{};
  const districts=uniq(places.map(p=>p.district));
  const localities=uniq(places.map(p=>p.locality));
  const primary=center.district||center.locality||center.region||center.country||null;
  const parent=center.district?center.locality:null;

  const foreground=areaLabel(byRole.foreground);
  const distance=areaLabel(byRole.distance);
  const left=areaLabel(byRole.left);
  const right=areaLabel(byRole.right);

  const clauses=[];
  if(primary) clauses.push(`The view is centered on ${primary}`);
  if(foreground && foreground!==primary) clauses.push(`${foreground} dominates the foreground`);
  if(distance && distance!==primary && distance!==foreground) clauses.push(`${distance} appears farther into the view`);
  if(left && left!==primary) clauses.push(`${left} is visible to the left`);
  if(right && right!==primary) clauses.push(`${right} is visible to the right`);

  return {
    primaryArea:primary,
    parentLocality:parent,
    viewType:viewType(samples),
    foreground,
    distance,
    left,
    right,
    visibleDistricts:districts,
    visibleLocalities:localities,
    summary:clauses.length?clauses.join('. ')+'.':'The visible area could not be resolved at neighborhood detail.',
  };
}

async function countryInfo(code){
  if(!code)return null;
  try{
    const fields='name,capital,population,area,region,subregion,languages,currencies,timezones,demonyms,continents,car';
    const arr=await json(`https://restcountries.com/v3.1/alpha/${encodeURIComponent(code)}?fields=${fields}`);
    const c=Array.isArray(arr)?arr[0]:arr;
    return {
      name:c?.name?.common||null,officialName:c?.name?.official||null,
      capital:Array.isArray(c?.capital)?c.capital[0]:null,population:c?.population||null,
      areaKm2:c?.area||null,region:c?.region||null,subregion:c?.subregion||null,
      continent:Array.isArray(c?.continents)?c.continents[0]:null,
      languages:Object.values(c?.languages||{}),
      currencies:Object.entries(c?.currencies||{}).map(([k,v])=>`${v?.name||k} (${k})`),
      timezones:c?.timezones||[],demonym:c?.demonyms?.eng?.m||c?.demonyms?.eng?.f||null,
      drivingSide:c?.car?.side||null,
    };
  }catch{return null}
}

async function wikiAndWikidata(place){
  const rawWiki=place?.wikipedia;
  let lang='en',title=null;
  if(rawWiki&&rawWiki.includes(':')){const i=rawWiki.indexOf(':');lang=rawWiki.slice(0,i)||'en';title=rawWiki.slice(i+1)}
  title ||= place?.district || place?.locality || place?.region || place?.country;
  if(!title)return {wikipedia:null,wikidata:null};

  let wiki=null,qid=place?.wikidata||null;
  try{
    const q=new URLSearchParams({action:'query',format:'json',redirects:'1',prop:'extracts|pageprops',exintro:'1',explaintext:'1',titles:title});
    const data=await json(`https://${encodeURIComponent(lang)}.wikipedia.org/w/api.php?${q}`);
    const page=Object.values(data?.query?.pages||{})[0];
    if(page&&!page.missing){
      qid ||= page?.pageprops?.wikibase_item||null;
      wiki={
        title:page.title||title,
        extract:cleanText(page.extract,1900),
        url:`https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(page.title||title).replace(/ /g,'_'))}`
      };
    }
  }catch{}

  let wd=null;
  if(qid&&/^Q\d+$/.test(qid)){
    try{
      const data=await json(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
      const e=data?.entities?.[qid];
      wd={qid,population:numClaim(e,'P1082'),elevationM:numClaim(e,'P2044')};
    }catch{}
  }
  return {wikipedia:wiki,wikidata:wd};
}

function parseSamples(raw,center){
  try{
    const arr=JSON.parse(raw||'[]');
    if(!Array.isArray(arr))throw new Error();
    return arr.slice(0,7).map(x=>({
      role:cleanText(x?.role,30),
      lat:Number(x?.lat),lon:Number(x?.lon)
    })).filter(x=>x.role&&Number.isFinite(x.lat)&&Number.isFinite(x.lon)&&Math.abs(x.lat)<=90&&Math.abs(x.lon)<=180);
  }catch{return [{role:'center',lat:center.lat,lon:center.lon}]}
}

export function areaIntelProxy(){
  const cache=new Map();let loaded=false;
  async function load(){
    if(loaded)return;loaded=true;
    try{
      const d=JSON.parse(await fsp.readFile(CACHE_FILE,'utf8'));
      for(const [k,v] of Object.entries(d||{}))if(v?.at&&v?.payload)cache.set(k,v);
    }catch{}
  }
  async function save(){
    try{
      await fsp.mkdir(path.dirname(CACHE_FILE),{recursive:true});
      const rows=[...cache].sort((a,b)=>b[1].at-a[1].at).slice(0,MAX_ITEMS);
      await fsp.writeFile(CACHE_FILE,JSON.stringify(Object.fromEntries(rows)),'utf8');
    }catch{}
  }
  async function handler(req,res){
    if(req.method!=='GET'){res.writeHead(405,{'Content-Type':'application/json'});res.end('{}');return}
    const u=new URL(req.url||'/','http://localhost');
    const lat=Number(u.searchParams.get('lat')),lon=Number(u.searchParams.get('lon'));
    if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180){
      res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'valid lat/lon required'}));return;
    }

    const samples=parseSamples(u.searchParams.get('samples'),{lat,lon});
    const sampleKey=samples.map(s=>`${s.role}:${s.lat.toFixed(3)},${s.lon.toFixed(3)}`).join('|');
    const key=sampleKey||`${lat.toFixed(3)},${lon.toFixed(3)}`;

    await load();
    const hit=cache.get(key);
    if(hit&&Date.now()-hit.at<TTL_MS){
      res.writeHead(200,{'Content-Type':'application/json','X-Area-Intel':'HIT'});res.end(JSON.stringify(hit.payload));return;
    }

    try{
      const resolved=[];
      for(const s of samples){
        try{
          const rev=await reverseOne(s.lat,s.lon,14);
          resolved.push({...s,place:placeFromNominatim(rev)});
        }catch{
          resolved.push({...s,place:null});
        }
      }

      let centerPlace=resolved.find(s=>s.role==='center')?.place;
      if(!centerPlace){
        centerPlace=placeFromNominatim(await reverseOne(lat,lon,10));
      }

      const viewportAnalysis=analyzeViewport(resolved);
      const [country,ww]=await Promise.all([
        countryInfo(centerPlace?.countryCode),
        wikiAndWikidata(centerPlace),
      ]);

      const payload={
        status:'ready',retrievedAt:new Date().toISOString(),
        place:centerPlace,country,
        cityPopulation:ww.wikidata?.population||centerPlace?.population||null,
        wikipedia:ww.wikipedia,wikidata:ww.wikidata,
        viewportAnalysis,
        viewportSamples:resolved.map(s=>({role:s.role,lat:s.lat,lon:s.lon,place:s.place})),
        sources:['OpenStreetMap/Nominatim','REST Countries',...(ww.wikipedia?['Wikipedia']:[]),...(ww.wikidata?['Wikidata']:[])]
      };

      cache.set(key,{at:Date.now(),payload});void save();
      res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'public,max-age=300','X-Area-Intel':'MISS'});
      res.end(JSON.stringify(payload));
    }catch(e){
      res.writeHead(502,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'Area intelligence unavailable'}));
    }
  }

  return {
    name:'area-intelligence-proxy',
    configureServer(server){server.middlewares.use('/api/area-intel',handler)},
    configurePreviewServer(server){server.middlewares.use('/api/area-intel',handler)},
  };
}

export default areaIntelProxy;
