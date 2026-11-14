const path = require("node:path");

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS workspaces (
    user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    data_json JSONB NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);
`;

const sqliteSchema = schema
  .replace("BIGINT", "INTEGER")
  .replace("JSONB", "TEXT")
  .replaceAll("TIMESTAMP", "TEXT")
  .replaceAll("CURRENT_TIMESTAMP", "(datetime('now'))");

let initialized;
let db;
let postgres = false;

function convertPlaceholders(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function createPostgresDatabase() {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: Number(process.env.DATABASE_POOL_SIZE || 5),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 10000
  });
  return {
    async initialize() {
      const postgresSchema = schema.replace("id INTEGER PRIMARY KEY", "id BIGSERIAL PRIMARY KEY");
      await pool.query(postgresSchema);
    },
    prepare(sql) {
      const query = convertPlaceholders(sql.replaceAll("datetime('now')", "CURRENT_TIMESTAMP"));
      return {
        async get(...values) {
          const result = await pool.query(query, values);
          return result.rows[0];
        },
        async run(...values) {
          const result = await pool.query(query, values);
          return {
            lastInsertRowid: result.rows[0]?.id,
            changes: result.rowCount
          };
        }
      };
    },
    async close() {
      await pool.end();
    }
  };
}

function createSqliteDatabase() {
  const Database = require("better-sqlite3");
  const databasePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "data", "evlife.sqlite"));
  const sqlite = new Database(databasePath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  return {
    initialize() {
      sqlite.exec(sqliteSchema);
    },
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      return {
        get: (...values) => statement.get(...values),
        run: (...values) => statement.run(...values)
      };
    },
    close() {
      sqlite.close();
    }
  };
}

function getDatabase() {
  if (!db) {
    if (process.env.VERCEL && !process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL is required on Vercel. Add the Neon pooled connection string to the project environment variables.");
    }
    postgres = Boolean(process.env.DATABASE_URL);
    db = postgres ? createPostgresDatabase() : createSqliteDatabase();
  }
  return db;
}

function ensureDatabase() {
  if (!initialized) {
    const database = getDatabase();
    initialized = Promise.resolve(database.initialize()).catch((error) => {
      initialized = undefined;
      throw error;
    });
  }
  return initialized;
}

function isPostgres() {
  return postgres;
}

module.exports = { ensureDatabase, getDatabase, isPostgres, schema };
