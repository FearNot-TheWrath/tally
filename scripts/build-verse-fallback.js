// scripts/build-verse-fallback.js
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Build-time only. Reads docs/nabre.json (the full NABRE bible, not committed to
// keep the repo light; obtain it separately) and writes the committed runtime
// artifact data/verses-fallback.json. The running app never loads docs/nabre.json.

// Reference list: { book, chapter, start, end?, ref } where `ref` is the display
// string. `book` must match a book name in docs/nabre.json exactly.
const REFS = [
  { book: 'John', chapter: 3, start: 16, ref: 'John 3:16' },
  { book: 'Psalms', chapter: 23, start: 1, end: 1, ref: 'Psalm 23:1', clean: 'The LORD is my shepherd; there is nothing I lack.' },
  { book: 'Psalms', chapter: 46, start: 11, ref: 'Psalm 46:11' },
  { book: 'Psalms', chapter: 118, start: 24, ref: 'Psalm 118:24' },
  { book: 'Psalms', chapter: 27, start: 1, ref: 'Psalm 27:1', clean: 'The LORD is my light and my salvation; whom should I fear? The LORD is my life’s refuge; of whom should I be afraid?' },
  { book: 'Psalms', chapter: 34, start: 9, ref: 'Psalm 34:9' },
  { book: 'Psalms', chapter: 100, start: 5, ref: 'Psalm 100:5' },
  { book: 'Psalms', chapter: 121, start: 2, ref: 'Psalm 121:2' },
  { book: 'Psalms', chapter: 139, start: 14, ref: 'Psalm 139:14' },
  { book: 'Proverbs', chapter: 3, start: 5, end: 6, ref: 'Proverbs 3:5-6' },
  { book: 'Isaiah', chapter: 40, start: 31, ref: 'Isaiah 40:31' },
  { book: 'Isaiah', chapter: 41, start: 10, ref: 'Isaiah 41:10' },
  { book: 'Isaiah', chapter: 43, start: 1, ref: 'Isaiah 43:1', clean: 'But now, thus says the LORD, who created you, Jacob, and formed you, Israel: Do not fear, for I have redeemed you; I have called you by name: you are mine.' },
  { book: 'Jeremiah', chapter: 29, start: 11, ref: 'Jeremiah 29:11' },
  { book: 'Joshua', chapter: 1, start: 9, ref: 'Joshua 1:9' },
  { book: 'Matthew', chapter: 6, start: 33, ref: 'Matthew 6:33' },
  { book: 'Matthew', chapter: 11, start: 28, ref: 'Matthew 11:28', clean: 'Come to me, all you who labor and are burdened, and I will give you rest.' },
  { book: 'Matthew', chapter: 5, start: 16, ref: 'Matthew 5:16' },
  { book: 'Mark', chapter: 12, start: 30, ref: 'Mark 12:30' },
  { book: 'Luke', chapter: 1, start: 37, ref: 'Luke 1:37' },
  { book: 'John', chapter: 14, start: 27, ref: 'John 14:27' },
  { book: 'John', chapter: 8, start: 12, ref: 'John 8:12' },
  { book: 'John', chapter: 15, start: 5, ref: 'John 15:5' },
  { book: 'Romans', chapter: 8, start: 28, ref: 'Romans 8:28', clean: 'We know that all things work for good for those who love God, who are called according to his purpose.' },
  { book: 'Romans', chapter: 12, start: 12, ref: 'Romans 12:12' },
  { book: 'Romans', chapter: 15, start: 13, ref: 'Romans 15:13' },
  { book: '1Corinthians', chapter: 13, start: 4, end: 7, ref: '1 Corinthians 13:4-7' },
  { book: '1Corinthians', chapter: 16, start: 14, ref: '1 Corinthians 16:14' },
  { book: '2Corinthians', chapter: 5, start: 7, ref: '2 Corinthians 5:7' },
  { book: 'Galatians', chapter: 5, start: 22, end: 23, ref: 'Galatians 5:22-23' },
  { book: 'Ephesians', chapter: 2, start: 10, ref: 'Ephesians 2:10' },
  { book: 'Philippians', chapter: 4, start: 6, end: 7, ref: 'Philippians 4:6-7' },
  { book: 'Philippians', chapter: 4, start: 13, ref: 'Philippians 4:13' },
  { book: 'Colossians', chapter: 3, start: 23, ref: 'Colossians 3:23' },
  { book: '1Thessalonians', chapter: 5, start: 16, end: 18, ref: '1 Thessalonians 5:16-18' },
  { book: '2Timothy', chapter: 1, start: 7, ref: '2 Timothy 1:7' },
  { book: 'Hebrews', chapter: 11, start: 1, ref: 'Hebrews 11:1', clean: 'Faith is the realization of what is hoped for and evidence of things not seen.' },
  { book: 'Hebrews', chapter: 13, start: 8, ref: 'Hebrews 13:8' },
  { book: 'James', chapter: 1, start: 5, ref: 'James 1:5' },
  { book: '1Peter', chapter: 5, start: 7, ref: '1 Peter 5:7' },
  { book: '1John', chapter: 4, start: 19, ref: '1 John 4:19' },
  { book: 'Micah', chapter: 6, start: 8, ref: 'Micah 6:8' },
  { book: 'Zephaniah', chapter: 3, start: 17, ref: 'Zephaniah 3:17' },
  { book: 'Lamentations', chapter: 3, start: 22, end: 23, ref: 'Lamentations 3:22-23' },
  { book: 'Deuteronomy', chapter: 31, start: 6, ref: 'Deuteronomy 31:6' },
  { book: 'Sirach', chapter: 2, start: 6, ref: 'Sirach 2:6' },
  { book: 'Wisdom', chapter: 3, start: 1, ref: 'Wisdom 3:1', clean: 'The souls of the righteous are in the hand of God, and no torment shall touch them.' },
  { book: 'Psalms', chapter: 19, start: 15, ref: 'Psalm 19:15' },
  { book: 'Psalms', chapter: 51, start: 12, ref: 'Psalm 51:12' },
  { book: 'Psalms', chapter: 145, start: 9, ref: 'Psalm 145:9' },
];

const bible = JSON.parse(readFileSync(join(ROOT, 'docs/nabre.json'), 'utf8'));
const byBook = new Map(bible.map(b => [b.book, b]));

function verseText(book, chapter, start, end) {
  const b = byBook.get(book);
  if (!b) throw new Error(`Unknown book: ${book}`);
  const ch = b.chapters.find(c => c.chapter === chapter);
  if (!ch) throw new Error(`Missing ${book} ${chapter}`);
  const hi = end || start;
  const parts = [];
  for (let v = start; v <= hi; v++) {
    const row = ch.verses.find(x => x.verse === v);
    if (!row) throw new Error(`Missing ${book} ${chapter}:${v}`);
    parts.push(row.text.trim());
  }
  return parts.join(' ');
}

// Some NABRE verses carry the section heading inline; `clean` overrides those.
const out = REFS.map(r => ({
  verseText: r.clean ?? verseText(r.book, r.chapter, r.start, r.end),
  verseRef: r.ref,
}));
mkdirSync(join(ROOT, 'data'), { recursive: true });
writeFileSync(join(ROOT, 'data/verses-fallback.json'), JSON.stringify(out, null, 2) + '\n');
console.log(`Wrote ${out.length} curated verses to data/verses-fallback.json`);
