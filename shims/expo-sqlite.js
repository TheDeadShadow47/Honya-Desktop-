// Desktop adapter for the subset of the expo-sqlite async API that db/database.js uses.
// Backed by Node's built-in node:sqlite, so there is no native module to rebuild for Electron.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const norm = (params = []) =>
  params.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));

export async function openDatabaseAsync(name) {
  const dir = globalThis.__HONYA_DATA_DIR__ ?? process.env.HONYA_DATA_DIR;
  if (!dir) throw new Error('Honya data directory is not configured');
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(path.join(dir, name));
  return {
    async execAsync(sql) {
      db.exec(sql);
    },
    async runAsync(sql, params) {
      const r = db.prepare(sql).run(...norm(params));
      return { changes: Number(r.changes), lastInsertRowId: Number(r.lastInsertRowid) };
    },
    async getAllAsync(sql, params) {
      return db.prepare(sql).all(...norm(params)).map((r) => ({ ...r }));
    },
    async getFirstAsync(sql, params) {
      const r = db.prepare(sql).get(...norm(params));
      return r ? { ...r } : null;
    },
    async withTransactionAsync(fn) {
      db.exec('BEGIN');
      try {
        await fn();
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async closeAsync() {
      db.close();
    },
  };
}
