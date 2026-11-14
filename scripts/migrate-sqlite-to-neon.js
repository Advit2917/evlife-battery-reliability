const path = require("node:path");
const Database = require("better-sqlite3");
const { Pool } = require("pg");
const { schema } = require("../database");

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error("Set DATABASE_URL to your Neon pooled connection string before running this migration.");
  }

  const sqlitePath = path.resolve(process.env.DATABASE_PATH || path.join(__dirname, "..", "data", "evlife.sqlite"));
  const sqlite = new Database(sqlitePath, { readonly: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();

  try {
    await client.query(schema.replace("id INTEGER PRIMARY KEY", "id BIGSERIAL PRIMARY KEY"));
    await client.query("BEGIN");

    const users = sqlite.prepare("SELECT id, email, password_salt, password_hash, created_at FROM users ORDER BY id").all();
    const idMap = new Map();
    for (const user of users) {
      const result = await client.query(`
        INSERT INTO users (id, email, password_salt, password_hash, created_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
        RETURNING id
      `, [user.id, user.email, user.password_salt, user.password_hash, user.created_at]);
      idMap.set(user.id, result.rows[0].id);
    }

    const sessions = sqlite.prepare("SELECT token_hash, user_id, expires_at FROM sessions").all();
    for (const session of sessions) {
      const userId = idMap.get(session.user_id);
      if (userId) {
        await client.query(`
          INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)
          ON CONFLICT (token_hash) DO NOTHING
        `, [session.token_hash, userId, session.expires_at]);
      }
    }

    const workspaces = sqlite.prepare("SELECT user_id, data_json, updated_at FROM workspaces").all();
    for (const workspace of workspaces) {
      const userId = idMap.get(workspace.user_id);
      if (userId) {
        await client.query(`
          INSERT INTO workspaces (user_id, data_json, updated_at) VALUES ($1, $2, $3)
          ON CONFLICT (user_id) DO NOTHING
        `, [userId, workspace.data_json, workspace.updated_at]);
      }
    }

    if (users.length) {
      await client.query(
        "SELECT setval(pg_get_serial_sequence('users', 'id'), GREATEST((SELECT COALESCE(MAX(id), 1) FROM users), 1), true)"
      );
    }
    await client.query("COMMIT");
    console.log(`Migrated ${users.length} accounts, ${sessions.length} sessions, and ${workspaces.length} workspaces to Neon.`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    sqlite.close();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
