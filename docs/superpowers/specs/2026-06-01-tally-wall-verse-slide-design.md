# Wall Verse Slide — Design

**Date:** 2026-06-01
**Project:** Tally — Wall Suite
**Status:** Approved, ready for implementation plan

## Summary

Add a new `verse` panel to the Tally wall rotation. The slide shows the day's
Catholic Mass **Gospel Acclamation** as a reverent, glanceable verse, styled in
the St. Patrick liturgy palette (midnight navy, gold, cream; Libre Baskerville +
Inter). When the daily Mass data is unavailable, the slide silently falls back to
a curated NABRE verse so it never breaks. All heavy work happens on the server;
the Raspberry Pi only displays a small JSON, consistent with the wall's core
constraint.

## Goals

- Add a `verse` panel that ties the wall to the actual daily Mass of the day.
- Keep it glanceable: one short verse, never a full multi verse passage.
- Keep the Pi light: no network calls or heavy rendering on the Pi.
- Never show an error state. A missing or stale daily fetch degrades gracefully.
- Match the chosen "Slide A" aesthetic (see Visual section), readable day and
  night with a single fixed palette.

## Non-goals

- Showing the full Gospel reading text. Too long for a glanceable wall slide and
  unreadable at a 20 second dwell.
- Interactivity on the wall (tap to read more). The wall is pure auto rotation.
- Per liturgical tradition selection (no diocesan or other national calendars).
  We use the USCCB readings for the United States Roman Catholic calendar.
- Reconstructing the acclamation from whole NABRE verses. Acclamations use part
  verse citations, so we take the rendered clause from USCCB directly.

## Why the Gospel Acclamation

The day's full Gospel reading is typically many verses (today, June 1, the
Gospel is Mark 12:1-12, the parable of the tenants). That cannot fit a large,
across the room slide, and nobody reads twelve verses in a 20 second dwell. The
**Gospel Acclamation** (the short Alleluia verse the Church pairs with each day)
is always a single pithy line chosen to capture the day. It is always glanceable,
always fits, and still anchors the slide to the day's liturgy. We display the day
name above it and the Gospel citation below it for context.

## Visual design

The approved layout is "Slide A — centered and reverent."

- Background: midnight navy radial gradient
  (`radial-gradient(120% 90% at 50% 16%, #1a2c50 0%, #101e38 55%, #0b1528 100%)`).
- Faint gold inner frame (1px, `rgba(200,162,74,.28)`) plus four 2px gold corner
  ticks (`#C8A24A`).
- **Eyebrow** (top, gold uppercase Inter, `#D8B96E`): the liturgical day name,
  printed verbatim from USCCB (e.g. "Memorial of St. Justin, Martyr"). On plain
  weekdays this reads "Tuesday of the Ninth Week in Ordinary Time"; that is
  accepted.
- **Verse** (hero, Libre Baskerville, cream `#FAF9F6`): the acclamation text,
  `clamp(20px, 3.0vw, 42px)`, line height 1.44.
- **Rule:** 74px by 2px gold bar (`#C8A24A`).
- **Reference** (uppercase Inter, cream): the acclamation source, cleaned for
  display (e.g. "Revelation 1:5").
- **Footer** (faint, centered, uppercase Inter, `#E8E0D4` at ~62% opacity):
  "Today's Gospel · <citation>" (e.g. "Today's Gospel · Mark 12:1-12").

The slide uses this fixed dark palette **regardless** of the wall's day/night
`data-theme`. The whole point is that it reads well both day and night, so it
must not be lightened by the day theme.

### Fallback layout

When the source is curated (see Fallback chain), there is no day name and no
Gospel citation, so the eyebrow and footer are omitted. The slide renders the
verse, the rule, and the reference only. Same palette, gracefully simpler.

Palette reference (extracted from the St. Patrick liturgy deck, branding removed):

| Role | Hex |
|---|---|
| Midnight navy (ground) | `#101E38` (gradient to `#1a2c50` / `#0b1528`) |
| Gold (primary) | `#C8A24A` |
| Gold (light) | `#D8B96E` |
| Cream (primary text) | `#FAF9F6` |
| Sand (secondary text) | `#E8E0D4` |

Fonts: Libre Baskerville (verse), Inter (eyebrow, reference, footer).

## Architecture

Server bakes a small JSON on a schedule; the wall reads it. The Pi never contacts
USCCB. This mirrors the existing `wall-radar` pattern.

### Daily baker: `scripts/wall-verse.js`

A Node script (run by a PM2 cron job) that:

1. Computes the current local date and builds the USCCB URL
   `https://bible.usccb.org/bible/readings/MMDDYY.cfm`.
2. Fetches the page (Node 20 global `fetch`, no browser).
3. Parses out, via a dedicated extractor module (see below): the day name, the
   Gospel Acclamation text (rendered clause, verbatim), the acclamation citation,
   and the Gospel citation.
4. Cleans the citations for display (see Citation cleanup).
5. Writes `public/generated/wall-verse.json` atomically (`.tmp` then
   `os.rename` equivalent via `fs.renameSync`).

On any failure (network, HTTP error, parse failure) the script logs and exits
without overwriting the existing file, so the last good day's data is preserved
until the next successful run.

`public/generated/` is already gitignored (regenerated artifacts).

### Extractor module: `src/lib/wall/usccb-readings.js`

Pure function `parseReadingsHtml(html)` returning
`{ dayName, gospelRef, acclamationText, acclamationRef }`, plus a thin
`fetchDailyReadings(date)` wrapper that fetches then calls the parser. Separating
parse from fetch lets us unit test the parser against a saved HTML fixture with no
network.

### JSON shape

`public/generated/wall-verse.json`:

```json
{
  "date": "2026-06-01",
  "dayName": "Memorial of St. Justin, Martyr",
  "verseText": "Jesus Christ, you are the faithful witness, the firstborn of the dead; you have loved us and freed us from our sins by your Blood.",
  "verseRef": "Revelation 1:5",
  "gospelRef": "Mark 12:1-12",
  "source": "daily",
  "fetchedAt": "2026-06-01T05:10:02.000Z"
}
```

### PM2 cron

A PM2 cron job `wall-verse` runs `scripts/wall-verse.js` at `10 0,6 * * *` (00:10
and 06:00 local). The midnight run picks up the new liturgical day; the 06:00 run
self heals a failed midnight fetch before the household is awake. Configured
`--no-autorestart --interpreter node`, registered with `pm2 save` so it survives
reboots. Same operational pattern as `wall-radar`.

### Route: `GET /api/wall/verse`

New handler in `src/routes/wall.js`. Resolves what the panel displays via the
fallback chain and returns the verse object. The panel calls this once per
rotation slot (consistent with the other panels' fetch on each slot).

## Fallback chain

`GET /api/wall/verse` resolves in order:

1. If `public/generated/wall-verse.json` exists and its `date` equals today's
   local date, return it (`source: "daily"`).
2. Otherwise, return a curated verse:
   `verses-fallback.json[dayOfYear % verses.length]`, shaped as
   `{ verseText, verseRef, source: "curated" }` with no `dayName` and no
   `gospelRef`.

The client renders the daily layout when `dayName`/`gospelRef` are present and the
fallback layout otherwise. A stale or missing daily file therefore degrades
silently to a curated verse. No error state reaches the wall.

## Curated fallback set

A one time build script reads `docs/nabre.json` and writes
`data/verses-fallback.json`: roughly 100 well known, uplifting, self contained
NABRE verses (each `{ verseText, verseRef }`), rotated by day of year. The
candidate list is generated for the user to prune before baking. `docs/nabre.json`
remains the build time source and is **not** loaded at runtime (the full 6.8 MB
bible is never shipped to or parsed by the running app).

## Citation cleanup

USCCB uses book abbreviations and part verse letters, e.g. `Rev 1:5ab`,
`Mk 12:1-12`, `2 Pt 1:2-7`. A small static abbreviation map (USCCB abbreviation to
display book name) plus stripping of trailing `a`/`b`/`c` part verse letters
produces clean display references:

- `Rev 1:5ab` becomes `Revelation 1:5`
- `Mk 12:1-12` becomes `Mark 12:1-12`

The acclamation **text** is taken verbatim from USCCB's rendered clause, never
reconstructed from whole NABRE verses (whole verse reconstruction produces
sentence fragments for part verse citations).

## Wall wiring (`public/js/pages/wall.js`)

- Add `verse` to the `KNOWN` panel set in `loadConfig()` and to the
  `wall_enabled_panels` default (`chores,weather,verse`).
- Add `renderVerse()`: fetches `/api/wall/verse`, builds the Slide A markup,
  shows the daily or fallback layout based on the presence of `dayName`.
- Add a `verse` branch in `renderPanel()`.
- The verse panel's CSS is self contained dark and does not respond to the wall's
  `data-theme`. Sleep mode (22:00 to 06:00) is handled by the existing rotation,
  no panel specific work needed.
- Dwell: new setting `wall_verse_dwell_sec`, default 20 seconds. A verse wants a
  beat longer than the 15 second weather glance.

## Fonts (offline safe)

Self host Libre Baskerville and Inter as woff2 in `public/vendor/fonts/` with
`@font-face` rules in `public/css/wall-suite.css`, rather than loading from a
Google CDN. The wall runs off the LAN and must render correctly even when the
internet is down. Verse panel styles live in `wall-suite.css` alongside the other
panels.

## Settings keys added

| key | default | notes |
|---|---|---|
| `wall_enabled_panels` | `chores,weather,verse` | add `verse` to the comma list |
| `wall_verse_dwell_sec` | `20` | int, clamped 5..600 |

## Testing

- **Citation cleanup** unit tests: abbreviation expansion and part verse letter
  stripping across a table of real USCCB citations.
- **Fallback selection** unit test: `dayOfYear % length` indexing is stable and
  in range.
- **Freshness logic** unit test: `date === today` returns the daily object;
  otherwise returns a curated object with no `dayName`/`gospelRef`.
- **Parser** test: `parseReadingsHtml` runs against a saved USCCB HTML fixture
  (no network) and extracts the four fields. This catches parser regressions if
  USCCB changes their markup.

## Risks and mitigations

- **USCCB HTML parsing is fragile.** If they change markup, the parser may fail.
  Mitigation: the fallback chain fully absorbs a failed or stale fetch (curated
  verse shows instead), and the fixture test flags the regression. The baker never
  overwrites the last good file on failure.
- **Copyright.** NABRE and USCCB content are copyrighted. This is a private family
  kiosk for personal devotional display, which the user has accepted.
- **Acclamation occasionally drawn from outside the Gospel.** The acclamation is
  sometimes taken from elsewhere in Scripture rather than the day's Gospel passage.
  Accepted: the Gospel citation in the footer still ties the slide to the day's
  Gospel reading.

## Files

```
scripts/wall-verse.js                 NEW  daily baker -> public/generated/wall-verse.json (PM2 cron 'wall-verse')
src/lib/wall/usccb-readings.js        NEW  parseReadingsHtml + fetchDailyReadings
src/routes/wall.js                    EDIT add GET /api/wall/verse (fallback chain)
data/verses-fallback.json             NEW  curated NABRE verses (built once from docs/nabre.json)
scripts/build-verse-fallback.js       NEW  one time builder for the curated set
public/js/pages/wall.js               EDIT KNOWN set, renderVerse(), renderPanel() branch, dwell
public/css/wall-suite.css             EDIT verse panel styles + @font-face
public/vendor/fonts/                  NEW  self hosted Libre Baskerville + Inter woff2
test/...                              NEW  citation cleanup, fallback selection, freshness, parser fixture
```
