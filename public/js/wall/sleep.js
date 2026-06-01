// Sleep-window calculation. All inputs are HH:MM strings in local 24-hour time.
//
// Start is inclusive; end is exclusive. A window where start == end is
// treated as "no sleep at all" (handy for "disable sleep mode" config).
// Midnight-wrapping windows (start > end, e.g. 22:00..06:00) are supported.

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

export function isInSleepWindow(now, start, end) {
  const n = toMinutes(now);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  if (s < e) return n >= s && n < e;
  // wrap: [s..24:00) U [00:00..e)
  return n >= s || n < e;
}
