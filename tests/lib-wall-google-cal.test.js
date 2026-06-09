import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  exchangeAuthCode,
  refreshAccessToken,
  fetchCalendarList,
  fetchCalendarEvents,
  InvalidGrantError,
  _resetTokenCache,
} from '../src/lib/wall/google-cal.js';

function mockFetchWith(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = original; };
}

test('exchangeAuthCode happy path', async () => {
  const restore = mockFetchWith(async (url, opts) => {
    assert.match(String(url), /oauth2\.googleapis\.com\/token/);
    assert.equal(opts.method, 'POST');
    assert.match(opts.body.toString(), /grant_type=authorization_code/);
    return { ok: true, status: 200, json: async () => ({
      access_token: 'AT', refresh_token: 'RT', expires_in: 3599,
    }) };
  });
  try {
    const r = await exchangeAuthCode('code-abc', 'https://example.com/cb');
    assert.equal(r.access_token, 'AT');
    assert.equal(r.refresh_token, 'RT');
  } finally { restore(); }
});

test('exchangeAuthCode error throws', async () => {
  const restore = mockFetchWith(async () => ({ ok: false, status: 400, text: async () => '{"error":"bad"}' }));
  try {
    await assert.rejects(() => exchangeAuthCode('bad', 'https://example.com/cb'));
  } finally { restore(); }
});

test('refreshAccessToken success', async () => {
  _resetTokenCache();
  const restore = mockFetchWith(async () => ({ ok: true, status: 200, json: async () => ({
    access_token: 'AT2', expires_in: 3600,
  }) }));
  try {
    const r = await refreshAccessToken('RT');
    assert.equal(r.access_token, 'AT2');
  } finally { restore(); }
});

test('refreshAccessToken invalid_grant throws InvalidGrantError', async () => {
  _resetTokenCache();
  const restore = mockFetchWith(async () => ({ ok: false, status: 400, text: async () => '{"error":"invalid_grant"}' }));
  try {
    await assert.rejects(() => refreshAccessToken('expired'), InvalidGrantError);
  } finally { restore(); }
});

test('refreshAccessToken cache hit returns cached without refetch', async () => {
  _resetTokenCache();
  let calls = 0;
  const restore = mockFetchWith(async () => { calls++; return { ok: true, status: 200, json: async () => ({ access_token: 'CACHED', expires_in: 3600 }) }; });
  try {
    await refreshAccessToken('RT');
    await refreshAccessToken('RT');
    assert.equal(calls, 1);
  } finally { restore(); }
});

test('fetchCalendarList returns simplified items', async () => {
  const restore = mockFetchWith(async (url) => {
    assert.match(String(url), /calendarList/);
    return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'a', summary: 'Family',  backgroundColor: '#FF0000', primary: true,  accessRole: 'owner' },
      { id: 'b', summary: 'Parish',  backgroundColor: '#00FF00', primary: false, accessRole: 'reader' },
    ] }) };
  });
  try {
    const list = await fetchCalendarList('AT');
    assert.equal(list.length, 2);
    assert.equal(list[0].id, 'a');
    assert.equal(list[0].primary, true);
    assert.equal(list[1].backgroundColor, '#00FF00');
  } finally { restore(); }
});

test('fetchCalendarEvents filters cancelled and returns normalized shape', async () => {
  const restore = mockFetchWith(async (url) => {
    assert.match(String(url), /calendars\/cal-1\/events/);
    return { ok: true, status: 200, json: async () => ({ items: [
      { id: 'e1', status: 'confirmed', summary: 'Soccer practice', location: 'Park', start: { dateTime: '2026-06-08T18:00:00-05:00' }, end: { dateTime: '2026-06-08T19:00:00-05:00' } },
      { id: 'e2', status: 'cancelled', summary: 'Cancelled meeting', start: { dateTime: '2026-06-08T20:00:00-05:00' }, end: { dateTime: '2026-06-08T21:00:00-05:00' } },
      { id: 'e3', status: 'confirmed', summary: 'Birthday', start: { date: '2026-06-08' }, end: { date: '2026-06-09' } },
    ] }) };
  });
  try {
    const events = await fetchCalendarEvents('AT', 'cal-1', '2026-06-08T00:00:00-05:00', '2026-06-09T23:59:59-05:00');
    assert.equal(events.length, 2);
    assert.equal(events[0].summary, 'Soccer practice');
    assert.equal(events[1].summary, 'Birthday');
    assert.equal(events[1].isAllDay, true);
    assert.equal(events[0].isAllDay, false);
  } finally { restore(); }
});
