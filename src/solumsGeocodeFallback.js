/**
 * Solums Skynet Spysat — global geocoding fallback.
 * Returns a Google-Geocoding-compatible result for the existing searchAndFlyTo camera logic.
 */

const DIRECT_ALIASES = Object.freeze([
  {
    aliases: ['oslo','oslo norway','oslo norge','capital of norway','the capital of norway','hovedstaden i norge','norges hovedstad'],
    result: {
      formatted_address: 'Oslo, Norway',
      geometry: {
        location: { lat: 59.9139, lng: 10.7522 },
        viewport: {
          southwest: { lat: 59.809, lng: 10.490 },
          northeast: { lat: 60.000, lng: 10.950 },
        },
      },
      types: ['locality','political'],
    },
  },
  {
    aliases: ['tonsberg','tønsberg','tønsberg norway','tønsberg norge'],
    result: {
      formatted_address: 'Tønsberg, Norway',
      geometry: {
        location: { lat: 59.2675, lng: 10.4076 },
        viewport: {
          southwest: { lat: 59.215, lng: 10.300 },
          northeast: { lat: 59.335, lng: 10.530 },
        },
      },
      types: ['locality','political'],
    },
  },
]);

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function mapTypes(row) {
  const category = normalize(row?.category || row?.class);
  const type = normalize(row?.type);
  const addressType = normalize(row?.addresstype);

  if (type === 'country' || addressType === 'country') return ['country','political'];
  if (['state','province','region'].includes(type) || ['state','province','region'].includes(addressType)) {
    return ['administrative_area_level_1','political'];
  }
  if (['county','district'].includes(type) || ['county','district'].includes(addressType)) {
    return ['administrative_area_level_2','political'];
  }
  if (['city','town','village','municipality','hamlet'].includes(type)
      || ['city','town','village','municipality','hamlet'].includes(addressType)) {
    return ['locality','political'];
  }
  if (['suburb','neighbourhood','neighborhood','quarter','borough'].includes(type)
      || ['suburb','neighbourhood','neighborhood','quarter','borough'].includes(addressType)) {
    return ['sublocality','political'];
  }
  if (category === 'highway' || ['road','street','pedestrian'].includes(type)) return ['route'];
  if (category === 'natural' || ['peak','volcano','bay','strait','sea','desert','mountain_range'].includes(type)) {
    return ['natural_feature'];
  }
  if (type === 'aerodrome' || type === 'airport') return ['airport','point_of_interest'];
  if (category === 'leisure' || type === 'park' || type === 'garden') return ['park','point_of_interest'];
  if (['tourism','historic','building','amenity','man_made','shop','office'].includes(category)) {
    return ['point_of_interest','establishment'];
  }
  return ['point_of_interest'];
}

function viewportFromBoundingBox(row) {
  const box = row?.boundingbox;
  if (!Array.isArray(box) || box.length < 4) return null;
  const south = Number(box[0]);
  const north = Number(box[1]);
  const west = Number(box[2]);
  const east = Number(box[3]);
  if (![south,north,west,east].every(Number.isFinite) || south >= north) return null;
  return {
    southwest: { lat: south, lng: west },
    northeast: { lat: north, lng: east },
  };
}

function toGoogleLike(row, query) {
  const lat = Number(row?.lat);
  const lng = Number(row?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const viewport = viewportFromBoundingBox(row);
  return {
    formatted_address: String(row?.displayName || row?.display_name || row?.name || query).slice(0, 600),
    geometry: {
      location: { lat, lng },
      ...(viewport ? { viewport } : {}),
    },
    types: mapTypes(row),
    _solumsSource: 'OpenStreetMap/Nominatim',
  };
}

export async function fallbackGeocodeResult(query, { signal } = {}) {
  const raw = String(query || '').trim();
  if (!raw) return null;

  const normalized = normalize(raw);
  const direct = DIRECT_ALIASES.find((entry) =>
    entry.aliases.some((alias) => normalize(alias) === normalized)
  );
  if (direct) return { ...structuredClone(direct.result), _solumsSource: 'Solums direct location' };

  try {
    const response = await fetch(`/api/solums-geocode?q=${encodeURIComponent(raw)}`, {
      cache: 'no-store',
      signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return null;
    const payload = await response.json();
    for (const row of Array.isArray(payload?.results) ? payload.results : []) {
      const result = toGoogleLike(row, raw);
      if (result) return result;
    }
  } catch (error) {
    if (error?.name !== 'AbortError') {
      console.warn('[SolumsAI] World geocoder unavailable:', error?.message || error);
    }
  }
  return null;
}

export default fallbackGeocodeResult;
