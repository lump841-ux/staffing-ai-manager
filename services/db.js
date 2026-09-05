// Dual-adapter DB layer: real Postgres in production (DATABASE_URL set),
// an in-memory pg-mem instance for local runs / smoke tests otherwise.
// This lets your son (or anyone) run the whole app with `npm start` and
// zero database setup — same pattern used across the other apps this
// session (RentPayEZ, etc.).
const fs = require('fs');
const path = require('path');

let pool;
let usingMemory = false;

function loadSchema() {
  return fs.readFileSync(path.join(__dirname, '..', 'database', 'schema.sql'), 'utf8');
}

function splitStatements(sql) {
  return sql
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function applySchema(client) {
  const statements = splitStatements(loadSchema());
  for (const stmt of statements) {
    await client.query(stmt);
  }
}

async function init() {
  const useMemory = process.env.PG_TEST_ADAPTER === 'pgmem' || !process.env.DATABASE_URL;

  if (useMemory) {
    usingMemory = true;
    const { newDb } = require('pg-mem');
    const mem = newDb({ autoCreateForeignKeyIndices: true });
    mem.public.registerFunction({
      name: 'now',
      returns: 'timestamp',
      implementation: () => new Date(),
    });
    const adapter = mem.adapters.createPg();
    pool = new adapter.Pool();
    const client = await pool.connect();
    await applySchema(client);
    client.release();
    return;
  }

  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const client = await pool.connect();
  await applySchema(client);
  client.release();
}

function query(text, params) {
  if (!pool) throw new Error('DB not initialized — call db.init() first');
  return pool.query(text, params);
}

module.exports = { init, query, isUsingMemory: () => usingMemory };
