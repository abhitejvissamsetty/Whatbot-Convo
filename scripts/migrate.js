import { readFile, readdir } from 'node:fs/promises';
import { config } from '../src/config/env.js';
const c = config();
if (!c.mysqlUrl) throw new Error('MYSQL_URL required');
const { createConnection } = await import('mysql2/promise');
const db = await createConnection(c.mysqlUrl);
try {
  const [lock] = await db.query("SELECT GET_LOCK('wa_schema_migration', 30) AS acquired");
  if (lock[0].acquired !== 1) throw new Error('Migration lock unavailable');
  await db.query('CREATE TABLE IF NOT EXISTS wa_migrations (name VARCHAR(190) PRIMARY KEY, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)');
  const dir = new URL('../src/db/migrations/', import.meta.url);
  for (const name of (await readdir(dir)).filter(n => n.endsWith('.sql')).sort()) {
    const [rows] = await db.execute('SELECT name FROM wa_migrations WHERE name = ?', [name]);
    if (rows.length) continue;
    const sql = await readFile(new URL(name, dir), 'utf8');
    for (const statement of sql.split(';').map(s => s.trim()).filter(Boolean)) await db.query(statement);
    await db.execute('INSERT INTO wa_migrations (name) VALUES (?)', [name]);
    process.stdout.write(`Applied ${name}\n`);
  }
} finally { await db.query("SELECT RELEASE_LOCK('wa_schema_migration')"); await db.end(); }
