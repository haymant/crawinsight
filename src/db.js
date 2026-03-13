const { Pool } = require('pg');
const { drizzle } = require('drizzle-orm/node-postgres');

// similar to book/lib/db.ts
const connectionString = process.env.DATABASE_URL;

// If no connection string is provided, assume we should not connect to a DB and
// fall back to file-based persistence. This makes the service easier to run in
// unit tests and local development without requiring Postgres.
let db = null;
if (connectionString) {
  const isLocalConnection =
    connectionString.includes('localhost') ||
    connectionString.includes('127.0.0.1');

  const pool = new Pool({
    connectionString,
    ssl: isLocalConnection ? undefined : { rejectUnauthorized: false },
  });

  db = drizzle(pool);
}

module.exports = { db };