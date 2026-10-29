export const collections = ['customers', 'conversations', 'messages', 'carts', 'flows', 'orders', 'events', 'jobs', 'outbox', 'handoffs', 'operators', 'sessions', 'usage', 'settings', 'audit', 'mock_orders', 'mock_messages'];
const clone = value => value === undefined ? undefined : structuredClone(value);

class MemoryTx {
  constructor(data) { this.data = data; }
  async get(table, id) { return clone(this.data[table]?.get(String(id))); }
  async list(table) { return [...this.data[table].values()].map(clone); }
  async set(table, id, value) { this.data[table].set(String(id), clone({ ...value, id: String(id) })); }
  async delete(table, id) { this.data[table].delete(String(id)); }
}
export class MemoryStore {
  constructor() { this.data = Object.fromEntries(collections.map(c => [c, new Map()])); this.tail = Promise.resolve(); }
  async transaction(fn) {
    const previous = this.tail;
    let unlock;
    this.tail = new Promise(resolve => { unlock = resolve; });
    await previous;
    try {
      const snapshot = structuredClone(this.data);
      const result = await fn(new MemoryTx(snapshot));
      this.data = snapshot;
      return result;
    } finally { unlock(); }
  }
  async close() {}
}
class MysqlTx {
  constructor(connection) { this.connection = connection; }
  table(name) { if (!collections.includes(name)) throw new Error('Unknown collection'); return `wa_${name}`; }
  async get(table, id) {
    const [rows] = await this.connection.execute(`SELECT data FROM ${this.table(table)} WHERE id = ?`, [String(id)]);
    return rows.length ? (typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data) : undefined;
  }
  async list(table) {
    const [rows] = await this.connection.execute(`SELECT data FROM ${this.table(table)}`);
    return rows.map(row => typeof row.data === 'string' ? JSON.parse(row.data) : row.data);
  }
  async set(table, id, value) {
    const name = this.table(table);
    const payload = JSON.stringify({ ...value, id: String(id) });
    const [existing] = await this.connection.execute(`SELECT id FROM ${name} WHERE id = ?`, [String(id)]);
    // Do not upsert on secondary unique-key conflicts: that could overwrite another order.
    if (existing.length) await this.connection.execute(`UPDATE ${name} SET data = ? WHERE id = ?`, [payload, String(id)]);
    else await this.connection.execute(`INSERT INTO ${name} (id, data) VALUES (?, ?)`, [String(id), payload]);
  }
  async delete(table, id) { await this.connection.execute(`DELETE FROM ${this.table(table)} WHERE id = ?`, [String(id)]); }
}
export class MysqlStore {
  constructor(pool) { this.pool = pool; }
  async transaction(fn) {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      // Single-store MVP: serialize domain mutations across API and worker processes.
      // Replace with per-aggregate locks/indexed repository queries before scaling.
      const [mutex] = await connection.query('SELECT id FROM wa_mutex WHERE id = 1 FOR UPDATE');
      if (mutex.length !== 1) throw new Error('Database transaction mutex is missing; run migrations');
      const result = await fn(new MysqlTx(connection));
      await connection.commit();
      return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async close() { await this.pool.end(); }
}
export async function createStore(config) {
  if (config.storeDriver === 'memory') {
    if (config.requirePersistence) throw new Error('Persistent storage required; configure MySQL');
    return new MemoryStore();
  }
  if (config.storeDriver !== 'mysql' || !config.mysqlUrl) throw new Error('MySQL storage must be explicitly configured');
  const mysql = await import('mysql2/promise');
  const pool = mysql.createPool(config.mysqlUrl);
  try {
    const [mutex] = await pool.query('SELECT id FROM wa_mutex WHERE id = 1');
    if (mutex.length !== 1) throw new Error('Database transaction mutex is missing; run migrations');
    for (const name of collections) await pool.query(`SELECT id FROM wa_${name} LIMIT 0`);
    return new MysqlStore(pool);
  } catch (error) { await pool.end(); throw error; }
}
