import { readFileSync, existsSync } from 'node:fs';

export function dayOfYear(date) {
  const start = new Date(date.getFullYear(), 0, 0);
  const diff = date - start;
  return Math.floor(diff / 86400000);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { return null; }
}

// Returns the verse object the wall should display. Daily file wins when its
// date equals today; otherwise a curated verse indexed by day of year.
export function resolveVerse({ generatedPath, fallbackPath, todayIso, now = new Date() }) {
  if (existsSync(generatedPath)) {
    const daily = readJson(generatedPath);
    if (daily && daily.date === todayIso && daily.verseText) {
      return daily;
    }
  }
  const list = readJson(fallbackPath) || [];
  if (list.length === 0) return { verseText: '', verseRef: '', source: 'curated' };
  const pick = list[dayOfYear(now) % list.length];
  return { verseText: pick.verseText, verseRef: pick.verseRef, source: 'curated' };
}
