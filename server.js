const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const helmet = require("helmet");
const { ensureDatabase, getDatabase } = require("./database");

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const cookieName = "evlife_session";
const secureCookie = process.env.COOKIE_SECURE === "true" || process.env.VERCEL === "1";
const allowedOrigins = new Set((process.env.PUBLIC_ORIGIN || "")
  .split(",").map((value) => value.trim()).filter(Boolean).map((value) => new URL(value).origin));

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(express.json({ limit: "256kb" }));
app.use(async (_req, res, next) => {
  try {
    await ensureDatabase();
    next();
  } catch (error) {
    next(error);
  }
});

const defaultWorkspace = () => ({
  profile: null,
  degradation: null,
  weibull: null,
  validation: null,
  simulationComplete: false,
  randomSeed: 42
});

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function readCookie(req, name) {
  const cookies = req.headers.cookie || "";
  const entry = cookies.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`));
  return entry ? entry.slice(name.length + 1) : null;
}

async function issueSession(userId, res) {
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionLifetimeMs;
  await getDatabase().prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)")
    .run(hashToken(token), userId, expiresAt);
  res.cookie(cookieName, token, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "lax",
    path: "/",
    maxAge: sessionLifetimeMs
  });
}

async function readWorkspace(userId) {
  const row = await getDatabase().prepare("SELECT data_json FROM workspaces WHERE user_id = ?").get(userId);
  const saved = row && (typeof row.data_json === "string" ? JSON.parse(row.data_json) : row.data_json);
  return saved ? { ...defaultWorkspace(), ...saved } : defaultWorkspace();
}

async function writeWorkspace(userId, data) {
  await getDatabase().prepare(`
    INSERT INTO workspaces (user_id, data_json, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      data_json = excluded.data_json,
      updated_at = datetime('now')
  `).run(userId, JSON.stringify(data));
}

async function requireAuth(req, res, next) {
  const token = readCookie(req, cookieName);
  if (!token) return res.status(401).json({ error: "Please sign in to continue." });
  let session;
  try {
    session = await getDatabase().prepare(`
    SELECT users.id, users.email, sessions.token_hash
    FROM sessions JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
    `).get(hashToken(token), Date.now());
  } catch (error) {
    return next(error);
  }
  if (!session) {
    res.clearCookie(cookieName, { httpOnly: true, secure: secureCookie, sameSite: "lax", path: "/" });
    return res.status(401).json({ error: "Your session expired. Please sign in again." });
  }
  req.user = { id: session.id, email: session.email };
  req.sessionHash = session.token_hash;
  next();
}

function requireSameOrigin(req, res, next) {
  const origin = req.get("origin");
  let parsedOrigin;
  try {
    parsedOrigin = origin && new URL(origin);
  } catch {
    return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  }
  const requestHost = req.get("x-forwarded-host") || req.get("host");
  const forwardedProtocol = req.get("x-forwarded-proto")?.split(",")[0].trim();
  const requestProtocol = forwardedProtocol || req.protocol;
  const sameRequestOrigin = parsedOrigin && parsedOrigin.host === requestHost && parsedOrigin.protocol === `${requestProtocol}:`;
  if (!parsedOrigin || (!sameRequestOrigin && !allowedOrigins.has(parsedOrigin.origin))) {
    return res.status(403).json({ error: "Cross-origin requests are not allowed." });
  }
  next();
}

function validateWorkspace(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "Workspace must be an object.";
  const number = (value) => typeof value === "number" && Number.isFinite(value);
  const optionalObject = (value) => value === null || (value && typeof value === "object" && !Array.isArray(value));

  if (!optionalObject(data.profile) || !optionalObject(data.degradation) ||
      !optionalObject(data.weibull) || !optionalObject(data.validation)) {
    return "Workspace sections must be objects or null.";
  }
  if (data.profile) {
    const p = data.profile;
    if (!["temperature", "cycles", "fastCharge", "cRate", "velocity", "gradient"].every((key) => number(p[key]))) {
      return "Battery profile contains invalid numbers.";
    }
    if (p.cycles < 0 || !Number.isInteger(p.cycles) || p.fastCharge < 0 || p.fastCharge > 100 ||
        p.cRate < 0 || p.velocity < 0 || Math.abs(p.temperature) > 200 || Math.abs(p.gradient) > 100) {
      return "Battery profile values are outside the allowed range.";
    }
  }
  if (data.degradation) {
    const d = data.degradation;
    if (![d.initialSoh, d.fadeRate, d.cyclesYear, d.cycleHorizon].every(number) ||
        d.initialSoh <= 0 || d.initialSoh > 100 || d.fadeRate <= 0 ||
        d.cyclesYear <= 0 || d.cycleHorizon < 100) {
      return "Degradation settings are invalid.";
    }
  }
  if (data.weibull) {
    const w = data.weibull;
    if (![w.b, w.e, w.t].every(number) || w.b <= 0 || w.e <= 0 || w.t < 0 ||
        typeof w.unit !== "string" || !w.unit.trim() || w.unit.length > 12) {
      return "Weibull settings are invalid.";
    }
  }
  if (data.validation) {
    const v = data.validation;
    if (typeof v.observed !== "string" || typeof v.predicted !== "string" ||
        v.observed.length > 100000 || v.predicted.length > 100000) {
      return "Validation data must be text under 100,000 characters per field.";
    }
  }
  if (data.simulationComplete !== undefined && typeof data.simulationComplete !== "boolean") {
    return "Simulation completion state is invalid.";
  }
  if (!Number.isInteger(data.randomSeed) || data.randomSeed < -2147483648 || data.randomSeed > 2147483647) {
    return "Random seed must be a 32-bit integer.";
  }
  return null;
}

const attempts = new Map();
function rateLimitAuth(req, res, next) {
  const email = req.body && typeof req.body.email === "string" ? req.body.email.trim().toLowerCase().slice(0, 254) : "";
  const key = `${req.ip}:${email}`;
  const now = Date.now();
  const attempt = attempts.get(key);
  if (attempt && now - attempt.startedAt < 15 * 60 * 1000 && attempt.count >= 20) {
    return res.status(429).json({ error: "Too many account attempts. Try again in 15 minutes." });
  }
  if (!attempt || now - attempt.startedAt >= 15 * 60 * 1000) attempts.set(key, { startedAt: now, count: 1 });
  else attempt.count += 1;
  next();
}

function validateCredentials(body) {
  const input = body && typeof body === "object" ? body : {};
  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { error: "Enter a valid email address." };
  }
  if (password.length < 12 || password.length > 256) {
    return { error: "Password must be between 12 and 256 characters." };
  }
  return { email, password };
}

function derivePassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (error, key) => error ? reject(error) : resolve(key));
  });
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/register", requireSameOrigin, rateLimitAuth, async (req, res, next) => {
  try {
    const credentials = validateCredentials(req.body);
    if (credentials.error) return res.status(400).json({ error: credentials.error });
    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await derivePassword(credentials.password, salt);
    let result;
    try {
      result = await getDatabase().prepare(
        "INSERT INTO users (email, password_salt, password_hash) VALUES (?, ?, ?) RETURNING id"
      ).get(credentials.email, salt, passwordHash.toString("hex"));
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE" || error.code === "23505") {
        return res.status(409).json({ error: "An account with this email already exists." });
      }
      throw error;
    }
    const userId = Number(result.id);
    await writeWorkspace(userId, defaultWorkspace());
    await issueSession(userId, res);
    res.status(201).json({ user: { email: credentials.email }, workspace: await readWorkspace(userId) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/login", requireSameOrigin, rateLimitAuth, async (req, res, next) => {
  try {
    const credentials = validateCredentials(req.body);
    if (credentials.error) return res.status(400).json({ error: credentials.error });
    const user = await getDatabase().prepare("SELECT id, email, password_salt, password_hash FROM users WHERE email = ?")
      .get(credentials.email);
    const salt = user ? user.password_salt : "0".repeat(32);
    const expected = user ? Buffer.from(user.password_hash, "hex") : Buffer.alloc(64);
    const actual = await derivePassword(credentials.password, salt);
    if (!user || !crypto.timingSafeEqual(actual, expected)) {
      return res.status(401).json({ error: "Email or password is incorrect." });
    }
    await getDatabase().prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?").run(user.id, Date.now());
    await issueSession(user.id, res);
    res.json({ user: { email: user.email }, workspace: await readWorkspace(user.id) });
  } catch (error) {
    next(error);
  }
});

app.post("/api/auth/logout", requireSameOrigin, requireAuth, async (req, res, next) => {
  try {
    await getDatabase().prepare("DELETE FROM sessions WHERE token_hash = ?").run(req.sessionHash);
    res.clearCookie(cookieName, { httpOnly: true, secure: secureCookie, sameSite: "lax", path: "/" });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});

app.get("/api/me", requireAuth, async (req, res, next) => {
  try {
    res.json({ user: { email: req.user.email }, workspace: await readWorkspace(req.user.id) });
  } catch (error) {
    next(error);
  }
});

app.put("/api/workspace", requireSameOrigin, requireAuth, async (req, res, next) => {
  const error = validateWorkspace(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await writeWorkspace(req.user.id, req.body);
    res.json({ workspace: req.body });
  } catch (error) {
    next(error);
  }
});

app.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/index.html", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
app.get("/app.js", (_req, res) => res.sendFile(path.join(__dirname, "app.js")));
app.get("/styles.css", (_req, res) => res.sendFile(path.join(__dirname, "styles.css")));
app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  const status = error.type === "entity.too.large" ? 413 : error.type === "entity.parse.failed" ? 400 : 500;
  res.status(status).json({
    error: error.type === "entity.too.large" ? "Request body is too large."
      : error.type === "entity.parse.failed" ? "Request body must contain valid JSON."
        : "An unexpected server error occurred."
  });
});

async function cleanupExpiredSessions() {
  await getDatabase().prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  for (const [ip, attempt] of attempts) {
    if (Date.now() - attempt.startedAt >= 15 * 60 * 1000) attempts.delete(ip);
  }
}

app.cleanupExpiredSessions = cleanupExpiredSessions;

if (require.main === module) {
  app.listen(port, () => {
    console.log(`EVLife listening on http://localhost:${port} (${process.env.DATABASE_URL ? "Neon/Postgres" : "SQLite"})`);
  });
}

module.exports = app;
