import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocodeLocation, _classifyInput } from '../src/lib/wall/geocode.js';

test('_classifyInput recognizes zip codes', () => {
  assert.equal(_classifyInput('78634').kind, 'zip');
  assert.equal(_classifyInput(' 90210 ').kind, 'zip');
  assert.notEqual(_classifyInput('786').kind, 'zip');
});

test('_classifyInput recognizes lat,lon pairs', () => {
  const a = _classifyInput('30.5083, -97.5469');
  assert.equal(a.kind, 'latlon');
  assert.equal(a.lat, 30.5083);
  assert.equal(a.lon, -97.5469);
});

test('_classifyInput falls back to free-text', () => {
  assert.equal(_classifyInput('Hutto, TX').kind, 'text');
});

test('geocodeLocation: lat,lon path skips the API and returns parsed values', async () => {
  const r = await geocodeLocation('30.5083, -97.5469');
  assert.equal(r.lat, 30.5083);
  assert.equal(r.lon, -97.5469);
});

test('geocodeLocation: zip path calls Open-Meteo geocoding (mocked fetch)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /postal_code=78634/);
    return { ok: true, status: 200, json: async () => ({
      results: [{ latitude: 30.5083, longitude: -97.5469, name: 'Hutto' }],
    }) };
  };
  try {
    const r = await geocodeLocation('78634');
    assert.equal(r.lat, 30.5083);
    assert.equal(r.lon, -97.5469);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: city path calls Open-Meteo geocoding (mocked fetch)', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.match(String(url), /name=/);
    return { ok: true, status: 200, json: async () => ({
      results: [{ latitude: 35.0, longitude: -106.6, name: 'Albuquerque' }],
    }) };
  };
  try {
    const r = await geocodeLocation('Albuquerque, NM');
    assert.equal(r.lat, 35.0);
    assert.equal(r.lon, -106.6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: no results returns null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({}) });
  try {
    const r = await geocodeLocation('Atlantis');
    assert.equal(r, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: fetch error returns null', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network down'); };
  try {
    const r = await geocodeLocation('78634');
    assert.equal(r, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('geocodeLocation: empty input returns null without calling fetch', async () => {
  let called = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; };
  try {
    const r = await geocodeLocation('');
    assert.equal(r, null);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
