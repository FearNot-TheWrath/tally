import webpush from 'web-push';

const PUBLIC = process.env.VAPID_PUBLIC_KEY;
const PRIVATE = process.env.VAPID_PRIVATE_KEY;
const SUBJECT = process.env.VAPID_SUBJECT;

let configured = false;
if (PUBLIC && PRIVATE && SUBJECT) {
  webpush.setVapidDetails(SUBJECT, PUBLIC, PRIVATE);
  configured = true;
}

export function isPushConfigured() {
  return configured;
}

export function getPublicKey() {
  return PUBLIC || null;
}

export function saveSubscription(db, personId, subscription) {
  const { endpoint, keys } = subscription;
  db.prepare(`
    INSERT INTO push_subscriptions (person_id, endpoint, p256dh, auth)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
      person_id = excluded.person_id,
      p256dh = excluded.p256dh,
      auth = excluded.auth
  `).run(personId, endpoint, keys.p256dh, keys.auth);
}

export function removeSubscription(db, endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

export async function sendToPerson(db, personId, payload) {
  if (!configured) return;
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE person_id = ?').all(personId);
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      );
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
      } else {
        console.error('push send failed:', err.message);
      }
    }
  }
}
