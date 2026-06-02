// USCCB daily Mass readings client.
// Fetches and parses https://bible.usccb.org/bible/readings/MMDDYY.cfm to
// extract the Gospel Acclamation verse for display on the wall screen.

// Normalize a USCCB citation for display: drop "See"/"Cf." prefixes and the
// a/b/c part-verse letters, collapse whitespace. Book names arrive in full.
export function cleanCitation(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().replace(/^(see|cf\.?)\s+/i, '');
  const i = s.indexOf(':');
  if (i >= 0) {
    const head = s.slice(0, i + 1);
    const tail = s.slice(i + 1).replace(/(\d)[a-z]+/gi, '$1');
    s = head + tail;
  }
  return s.replace(/\s+/g, ' ').trim();
}

const ACCLAMATION_LABELS = ['Gospel Acclamation', 'Alleluia', 'Verse Before the Gospel'];

function stripTags(html) {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Find a reading block by its <h3 class="name"> label and return the raw inner
// HTML of its .address and .content-body divs.
function blockByName(html, label) {
  const nameRe = new RegExp(`<h3 class="name">\\s*${label}\\s*</h3>`, 'i');
  const m = nameRe.exec(html);
  if (!m) return null;
  const rest = html.slice(m.index);
  const addr = /<div class="address">([\s\S]*?)<\/div>/i.exec(rest);
  const body = /<div class="content-body">([\s\S]*?)<\/div>\s*<\/div>/i.exec(rest);
  return {
    address: addr ? stripTags(addr[1]) : '',
    bodyHtml: body ? body[1] : '',
  };
}

function firstBlock(html, labels) {
  for (const label of labels) {
    const b = blockByName(html, label);
    if (b) return b;
  }
  return null;
}

// The acclamation verse is the content-body minus the bolded "Alleluia,
// alleluia." (or seasonal) refrains and the standalone "R." response markers.
function cleanAcclamationText(bodyHtml) {
  const noRefrain = bodyHtml.replace(/<strong>[\s\S]*?<\/strong>/gi, ' ');
  return stripTags(noRefrain).replace(/\bR\.\s*/g, '').replace(/\s+/g, ' ').trim();
}

export function parseReadingsHtml(html) {
  const og = /<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i.exec(html);
  const dayName = og ? og[1].replace(/\s*\|\s*USCCB\s*$/i, '').trim() : '';

  const gospel = blockByName(html, 'Gospel');
  const accl = firstBlock(html, ACCLAMATION_LABELS);

  return {
    dayName,
    gospelRef: gospel ? cleanCitation(gospel.address) : '',
    acclamationRef: accl ? cleanCitation(accl.address) : '',
    acclamationText: accl ? cleanAcclamationText(accl.bodyHtml) : '',
  };
}

// Build the USCCB readings URL for the given date (MMDDYY format).
export function usccbUrl(date) {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const yy = String(date.getFullYear()).slice(-2);
  return `https://bible.usccb.org/bible/readings/${mm}${dd}${yy}.cfm`;
}

// Fetch and parse the USCCB readings page for the given date.
export async function fetchDailyReadings(date) {
  const res = await fetch(usccbUrl(date), {
    headers: { 'User-Agent': 'Mozilla/5.0 tally-wall/1.0' },
  });
  if (!res.ok) throw new Error(`USCCB HTTP ${res.status}`);
  const html = await res.text();
  return parseReadingsHtml(html);
}
