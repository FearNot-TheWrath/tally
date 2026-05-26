import Database from 'better-sqlite3';
import { runMigrations } from '../src/db.js';

export function freshDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}
