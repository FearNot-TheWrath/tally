export function today() {
  const d = new Date();
  return toIso(d);
}

export function toIso(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function fromIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function weekStart(iso) {
  const d = fromIso(iso);
  const day = d.getDay(); // 0 Sun .. 6 Sat
  const offset = day === 0 ? -6 : 1 - day; // back to Monday
  d.setDate(d.getDate() + offset);
  return toIso(d);
}

export function isToday(iso) {
  return iso === today();
}

export function isOverdue(iso) {
  return iso < today();
}

export function dayOfWeek(iso) {
  return fromIso(iso).getDay();
}
