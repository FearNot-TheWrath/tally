// scripts/wall-verse.js
import { writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { fetchDailyReadings } from '../src/lib/wall/usccb-readings.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'public', 'generated');
const OUT = join(OUT_DIR, 'wall-verse.json');

function isoLocalDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

async function main() {
  const now = new Date();
  const parsed = await fetchDailyReadings(now);
  if (!parsed.acclamationText) {
    throw new Error('no acclamation text parsed (markup change?)');
  }
  const record = {
    date: isoLocalDate(now),
    dayName: parsed.dayName,
    verseText: parsed.acclamationText,
    verseRef: parsed.acclamationRef,
    gospelRef: parsed.gospelRef,
    source: 'daily',
    fetchedAt: now.toISOString(),
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n');
  renameSync(tmp, OUT);
  console.log(`[wall-verse] wrote ${record.date}: ${record.verseRef}`);
}

main().catch(err => {
  console.error('[wall-verse] failed, keeping last good file:', err.message);
  process.exit(1);
});
