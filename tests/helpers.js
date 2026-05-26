import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';
import { buildApp } from '../src/app.js';

export function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

export function freshApp(db) {
  return buildApp({ db: db || freshDb(), sessionSecret: 'test-secret' });
}
