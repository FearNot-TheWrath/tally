// Resolve a freeform location (zip, "lat,lon", or city/place) into { lat, lon }.
// Uses Open-Meteo's free geocoding API. Returns null on any failure so the
// caller can fall back to "no location configured".

const ZIP_RE   = /^\s*([0-9]{5})\s*$/;
const LATLON_RE = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/;

export function _classifyInput(s) {
  if (typeof s !== 'string') return { kind: 'empty' };
  const t = s.trim();
  if (!t) return { kind: 'empty' };
  const zip = t.match(ZIP_RE);
  if (zip) return { kind: 'zip', zip: zip[1] };
  const ll = t.match(LATLON_RE);
  if (ll) return { kind: 'latlon', lat: Number(ll[1]), lon: Number(ll[2]) };
  return { kind: 'text', text: t };
}

async function callOpenMeteo(params) {
  const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('count', '1');
  const r = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`geocode ${r.status}`);
  const json = await r.json();
  const hit = json?.results?.[0];
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name || null };
}

export async function geocodeLocation(input) {
  const c = _classifyInput(input);
  if (c.kind === 'empty') return null;
  if (c.kind === 'latlon') return { lat: c.lat, lon: c.lon, name: null };
  // Open-Meteo's geocoding API has a single `name` query; zip codes work
  // fine as a name lookup (they return the matching town).
  try {
    const q = c.kind === 'zip' ? c.zip : c.text;
    return await callOpenMeteo({ name: q, country: 'US' });
  } catch (e) {
    return null;
  }
}
