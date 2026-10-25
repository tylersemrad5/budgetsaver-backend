import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import pg from "pg";
import plaid from "plaid";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { jwtVerify, importJWK, decodeProtectedHeader } from "jose";

dotenv.config();

const { Pool } = pg;
const { Configuration, PlaidApi, PlaidEnvironments } = plaid;
const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

const PORT = Number(process.env.PORT || 3000);
const ORIGIN = "https://budgetsaver-backend.onrender.com";
const WEBHOOK = `${ORIGIN}/plaid/webhook`;
const ENV = process.env.PLAID_ENV === "production" ? "production" : "sandbox";
const LIVE = ENV === "production" &&
  process.env.ENABLE_LIVE_USAA_LINKING === "true";
const SANDBOX = ENV === "sandbox" &&
  process.env.ENABLE_PLAID_LINKING === "true";
const LINK_ENABLED = LIVE || SANDBOX;

for (const key of [
  "DATABASE_URL", "PLAID_CLIENT_ID", "PLAID_SECRET",
  "TOKEN_ENCRYPTION_KEY", "FIREBASE_PROJECT_ID", "ALLOWED_FIREBASE_UID"
]) {
  if (!process.env[key]) throw new Error(`Missing ${key}`);
}
if (!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY)) {
  throw new Error("Invalid encryption key length");
}
if (LINK_ENABLED && process.env.PLAID_WEBHOOK_URL !== WEBHOOK) {
  throw new Error("PLAID_WEBHOOK_URL does not match the webhook endpoint");
}

const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_CA_CERT ? {
    rejectUnauthorized: true,
    ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n")
  } : false,
  max: 5,
  connectionTimeoutMillis: 10000
});

if (!getApps().length) {
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID
  });
}
const firebase = getAuth();

const plaidClient = new PlaidApi(new Configuration({
  basePath: ENV === "production"
    ? PlaidEnvironments.production : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
      "Plaid-Version": "2020-09-14"
    }
  }
}));

function enc(value) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([c.update(value, "utf8"), c.final()]);
  return ["v1", iv.toString("hex"), c.getAuthTag().toString("hex"),
    data.toString("hex")].join(":");
}
function dec(value) {
  const p = String(value).split(":");
  if (p.length !== 4 || p[0] !== "v1") throw Error("Invalid ciphertext");
  const c = crypto.createDecipheriv(
    "aes-256-gcm", KEY, Buffer.from(p[1], "hex")
  );
  c.setAuthTag(Buffer.from(p[2], "hex"));
  return Buffer.concat([
    c.update(Buffer.from(p[3], "hex")), c.final()
  ]).toString("utf8");
}
function fingerprint(value) {
  return crypto.createHmac("sha256", KEY).update(value).digest("hex");
}
function bad(status, message) {
  const e = new Error(message);
  e.status = status;
  throw e;
}
const asyncHandler = fn => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

function stringValue(value, max = 150) {
  const s = String(value ?? "").trim();
  if (!s || s.length > max) bad(400, "Invalid text");
  return s;
}
function money(value, positive = false) {
  if (value === null || value === undefined || value === "") {
    bad(400, "Invalid amount");
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9 || (positive && n <= 0)) {
    bad(400, "Invalid amount");
  }
  return Math.round(n * 100) / 100;
}
function date(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    bad(400, "Invalid date");
  }
  const d = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(+d) || d.toISOString().slice(0, 10) !== value) {
    bad(400, "Invalid date");
  }
  return value;
}
function id(value) {
  if (typeof value !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)) {
    bad(400, "Invalid identifier");
  }
  return value;
}

app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  });
  next();
});

const allowed = (process.env.ALLOWED_WEB_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) { cb(null, !origin || allowed.includes(origin)); }
}));
app.use(rateLimit({
  windowMs: 60000, limit: 100,
  standardHeaders: "draft-7", legacyHeaders: false
}));
app.use("/plaid/webhook", express.raw({
  type: "application/json", limit: "256kb"
}));
app.use(express.json({ limit: "256kb" }));

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bs_users (
      id UUID PRIMARY KEY,
      apple_subject TEXT UNIQUE,
      firebase_uid TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE bs_users ALTER COLUMN apple_subject DROP NOT NULL;
    ALTER TABLE bs_users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS bs_users_firebase_idx
      ON bs_users(firebase_uid);

    CREATE TABLE IF NOT EXISTS bs_items (
      item_id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      token_encrypted TEXT NOT NULL,
      institution_name TEXT,
      cursor TEXT,
      last_synced_at TIMESTAMPTZ,
      sync_error TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bs_accounts (
      account_id TEXT PRIMARY KEY,
      item_id TEXT NOT NULL REFERENCES bs_items(item_id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      name TEXT NOT NULL,
      type TEXT,
      subtype TEXT,
      mask TEXT,
      current_balance NUMERIC(14,2),
      available_balance NUMERIC(14,2),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bs_transactions (
      transaction_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      item_id TEXT NOT NULL REFERENCES bs_items(item_id) ON DELETE CASCADE,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      name TEXT NOT NULL,
      merchant TEXT,
      amount NUMERIC(14,2) NOT NULL,
      date DATE NOT NULL,
      category TEXT NOT NULL DEFAULT 'OTHER',
      pending BOOLEAN NOT NULL DEFAULT FALSE,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bs_manual_transactions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      name TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      date DATE NOT NULL,
      category TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bs_budgets (
      user_id UUID NOT NULL REFERENCES bs_users(id),
      month_key TEXT NOT NULL,
      category TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      PRIMARY KEY(user_id,month_key,category)
    );
    CREATE TABLE IF NOT EXISTS bs_goals (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      name TEXT NOT NULL,
      target NUMERIC(14,2) NOT NULL,
      progress NUMERIC(14,2) NOT NULL DEFAULT 0,
      is_debt BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS bs_bills (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      name TEXT NOT NULL,
      amount NUMERIC(14,2) NOT NULL,
      due_date DATE NOT NULL,
      paid BOOLEAN NOT NULL DEFAULT FALSE
    );
    CREATE TABLE IF NOT EXISTS bs_preferences (
      user_id UUID PRIMARY KEY REFERENCES bs_users(id),
      checking_reserve NUMERIC(14,2) NOT NULL DEFAULT 200,
      planned_spending NUMERIC(14,2) NOT NULL DEFAULT 0,
      planned_debt NUMERIC(14,2) NOT NULL DEFAULT 0,
      planned_savings NUMERIC(14,2) NOT NULL DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS bs_hosted_link_sessions (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      link_token_hash TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      item_id TEXT,
      error_code TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    );
    ALTER TABLE bs_hosted_link_sessions
      ADD COLUMN IF NOT EXISTS link_token_ciphertext TEXT;
    ALTER TABLE bs_hosted_link_sessions
      ADD COLUMN IF NOT EXISTS processing_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS bs_hosted_user_idx
      ON bs_hosted_link_sessions(user_id,created_at DESC);
  `);
}

async function requireAuth(req, res, next) {
  const token = /^Bearer (\S+)$/i.exec(req.get("authorization") || "");
  if (!token) return res.status(401).json({ error: "Sign in required" });

  let decoded;
  try {
    // Includes a revoked-token check. Fails closed if Firebase Admin
    // lacks permission to perform it.
    decoded = await firebase.verifyIdToken(token[1], true);
  } catch (err) {
    console.error("Firebase verification unsuccessful:", err.code || err.name);
    return res.status(401).json({ error: "Session verification failed" });
  }
  if (decoded.uid !== process.env.ALLOWED_FIREBASE_UID) {
    return res.status(403).json({ error: "Account not authorized" });
  }

  try {
    const result = await pool.query(`
      INSERT INTO bs_users(id,firebase_uid) VALUES($1,$2)
      ON CONFLICT(firebase_uid)
      DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid
      RETURNING id
    `, [crypto.randomUUID(), decoded.uid]);
    req.userId = result.rows[0].id;
    req.firebaseUid = decoded.uid;
    next();
  } catch (err) { next(err); }
}

app.get("/health", (_req, res) => res.json({
  ok: true,
  service: "BudgetSaver",
  version: "2.0-alpha.7.1",
  plaid_environment: ENV,
  plaid_linking_enabled: LINK_ENABLED,
  hosted_link: true,
  recovery_endpoint: true,
  firebase_revocation_check: true
}));

const baseDir = path.dirname(fileURLToPath(import.meta.url));
app.get(["/connect-bank", "/plaid/oauth"], (_req, res) => {
  res.set("Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https://*.googleapis.com " +
    "https://*.firebaseapp.com https://securetoken.googleapis.com; " +
    "img-src 'self' data:; object-src 'none'; " +
    "base-uri 'none'; frame-ancestors 'none'");
  res.sendFile(path.join(baseDir, "public", "connect-bank.html"));
});

const api = express.Router();
api.use(requireAuth);

api.get("/auth/me", (req, res) => res.json({
  authenticated: true, uid: req.firebaseUid
}));
api.get("/plaid/status", (_req, res) => res.json({
  environment: ENV,
  linking_enabled: LINK_ENABLED,
  hosted_link: true,
  mode: LINK_ENABLED ? ENV : "disabled"
}));
function requireLink(req, res, next) {
  if (!LINK_ENABLED) {
    return res.status(503).json({
      error: "Bank linking is not enabled"
    });
  }
  next();
}

api.post("/plaid/hosted/start", requireLink, asyncHandler(async (req, res) => {
  const response = await plaidClient.linkTokenCreate({
    client_name: "BudgetSaver",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: req.userId },
    products: ["transactions"],
    webhook: WEBHOOK,
    hosted_link: {
      url_lifetime_seconds: 900,
      completion_redirect_uri: `${ORIGIN}/connect-bank`
    }
  });
  const { link_token, hosted_link_url } = response.data;
  if (!link_token || !hosted_link_url) {
    throw Error("Plaid Hosted Link is unavailable");
  }
  const url = new URL(hosted_link_url);
  if (url.protocol !== "https:" || url.hostname !== "secure.plaid.com") {
    throw Error("Unexpected Plaid URL");
  }
  const sessionId = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_hosted_link_sessions(
      id,user_id,link_token_hash,link_token_ciphertext,
      status,expires_at
    ) VALUES($1,$2,$3,$4,'pending',NOW()+INTERVAL '30 minutes')
  `, [sessionId, req.userId, fingerprint(link_token), enc(link_token)]);
  res.json({ session_id: sessionId, hosted_link_url });
}));

api.get("/plaid/hosted/latest", asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT id,status,created_at,completed_at
    FROM bs_hosted_link_sessions
    WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1
  `, [req.userId]);
  res.json({ session: result.rows[0] || null });
}));

api.get("/plaid/hosted/status", asyncHandler(async (req, res) => {
  const result = await pool.query(`
    SELECT status,item_id,error_code,completed_at,expires_at
    FROM bs_hosted_link_sessions WHERE id=$1 AND user_id=$2
  `, [id(req.query.session_id), req.userId]);
  if (!result.rows.length) bad(404, "Session not found");
  res.json({ session: result.rows[0] });
}));

// Legacy browser public-token exchange remains disabled.
for (const endpoint of [
  "/plaid/web/link-token", "/plaid/web/resume", "/plaid/web/exchange",
  "/plaid/link-token", "/plaid/exchange"
]) {
  api.post(endpoint, (_req, res) =>
    res.status(410).json({ error: "Use Hosted Link" }));
}

/*
 * A single database claim prevents two workers from exchanging
 * a token at the same time. On a failed exchange, mark the session
 * for inspection or recovery; never publish tokens in logs.
 */
async function finishSession(linkToken, publicToken) {
  if (!LINK_ENABLED) return { skipped: true };
  if (typeof linkToken !== "string" || !/^public-/.test(publicToken)) {
    throw Error("Invalid Hosted Link completion");
  }

  const claimed = await pool.query(`
    UPDATE bs_hosted_link_sessions
    SET status='processing',processing_at=NOW(),error_code=NULL
    WHERE link_token_hash=$1
      AND (
        status='pending' OR
        (status='error' AND item_id IS NULL)
      )
    RETURNING id,user_id
  `, [fingerprint(linkToken)]);

  if (!claimed.rows.length) return { skipped: true };

  const session = claimed.rows[0];
  let accessToken = null;
  let committed = false;

  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });
    accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const inserted = await client.query(`
        INSERT INTO bs_items(item_id,user_id,token_encrypted)
        VALUES($1,$2,$3)
        ON CONFLICT(item_id) DO NOTHING
        RETURNING item_id
      `, [itemId, session.user_id, enc(accessToken)]);

      if (!inserted.rows.length) {
        throw Error("Plaid Item already exists");
      }

      await client.query(`
        UPDATE bs_hosted_link_sessions
        SET status='complete',item_id=$1,completed_at=NOW(),
            error_code=NULL
        WHERE id=$2
      `, [itemId, session.id]);

      await client.query("COMMIT");
      committed = true;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    return { complete: true };
  } catch (err) {
    if (accessToken && !committed) {
      // If storage failed, revoke any exchanged access token.
      await plaidClient.itemRemove({ access_token: accessToken })
        .catch(() => {});
    }
    await pool.query(`
      UPDATE bs_hosted_link_sessions
      SET status='error',error_code='COMPLETION_FAILED',
          completed_at=NOW()
      WHERE id=$1 AND status='processing'
    `, [session.id]);
    throw err;
  }
}

function publicTokenFromLinkGet(data) {
  const sessions = Array.isArray(data.link_sessions)
    ? data.link_sessions : [];
  for (const session of sessions) {
    const results = session.results?.item_add_results;
    if (Array.isArray(results)) {
      const tokens = results
        .map(x => x.public_token)
        .filter(x => typeof x === "string");
      if (tokens.length === 1) return tokens[0];
    }
  }
  return null;
}

// Recovery requires an authenticated session owner.
// Never accept a public token from the browser.
api.post("/plaid/hosted/recover", requireLink,
  asyncHandler(async (req, res) => {
    const sessionId = id(req.body?.session_id);
    const found = await pool.query(`
      SELECT * FROM bs_hosted_link_sessions
      WHERE id=$1 AND user_id=$2
    `, [sessionId, req.userId]);
    const session = found.rows[0];
    if (!session) bad(404, "Connection not found");
    if (session.status === "complete") {
      return res.json({ status: "complete" });
    }
    if (!session.link_token_ciphertext) {
      return res.json({
        status: "unavailable",
        message: "This older connection cannot be recovered"
      });
    }
    const linkToken = dec(session.link_token_ciphertext);
    const response = await plaidClient.linkTokenGet({
      link_token: linkToken
    });
    const publicToken = publicTokenFromLinkGet(response.data);
    if (!publicToken) {
      return res.json({
        status: "pending",
        message: "No completed bank authorization found"
      });
    }

    await finishSession(linkToken, publicToken);
    const latest = await pool.query(`
      SELECT status FROM bs_hosted_link_sessions WHERE id=$1
    `, [sessionId]);
    res.json({ status: latest.rows[0]?.status || "unknown" });
  })
);

async function refreshAccounts(item) {
  const result = await plaidClient.accountsGet({
    access_token: dec(item.token_encrypted)
  });
  for (const a of result.data.accounts) {
    await pool.query(`
      INSERT INTO bs_accounts(
        account_id,item_id,user_id,name,type,subtype,mask,
        current_balance,available_balance,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT(account_id) DO UPDATE SET
        name=EXCLUDED.name,type=EXCLUDED.type,
        subtype=EXCLUDED.subtype,mask=EXCLUDED.mask,
        current_balance=EXCLUDED.current_balance,
        available_balance=EXCLUDED.available_balance,updated_at=NOW()
      WHERE bs_accounts.user_id=EXCLUDED.user_id
    `, [a.account_id,item.item_id,item.user_id,a.name,
      a.type,a.subtype,a.mask || null,a.balances?.current ?? null,
      a.balances?.available ?? null]);
  }
}

api.get("/accounts", asyncHandler(async (req, res) => {
  const r = await pool.query(`
    SELECT account_id,item_id,name,type,subtype,mask,
      current_balance,available_balance,updated_at
    FROM bs_accounts WHERE user_id=$1 ORDER BY name
  `, [req.userId]);
  res.json({ accounts: r.rows });
}));
api.post("/accounts/refresh", asyncHandler(async (req, res) => {
  const r = await pool.query("SELECT * FROM bs_items WHERE user_id=$1",
    [req.userId]);
  for (const item of r.rows) await refreshAccounts(item);
  res.json({ ok: true });
}));

async function syncItem(item) {
  const client = await pool.connect();
  let locked = false;
  let broken = false;
  try {
    const lock = await client.query(`
      SELECT pg_try_advisory_lock(hashtext($1),hashtext($2)) AS locked
    `, ["bs-sync", item.item_id]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { skipped: true };

    const result = await client.query(`
      SELECT * FROM bs_items WHERE item_id=$1 AND user_id=$2
    `, [item.item_id,item.user_id]);
    const latest = result.rows[0];
    if (!latest) return { skipped: true };

    const accessToken = dec(latest.token_encrypted);
    let changes, cursor;
    for (let attempt = 0; attempt < 3; attempt++) {
      cursor = latest.cursor || undefined;
      const batch = { added: [], modified: [], removed: [] };
      try {
        let more = true;
        while (more) {
          const r = await plaidClient.transactionsSync({
            access_token: accessToken,cursor,count:500
          });
          batch.added.push(...r.data.added);
          batch.modified.push(...r.data.modified);
          batch.removed.push(...r.data.removed);
          cursor = r.data.next_cursor;
          more = r.data.has_more;
        }
        changes = batch;
        break;
      } catch (err) {
        if (err?.response?.data?.error_code ===
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
            attempt < 2) continue;
        throw err;
      }
    }
    if (!changes) throw Error("Sync failed");

    await client.query("BEGIN");
    try {
      for (const tx of [...changes.added,...changes.modified]) {
        await client.query(`
          INSERT INTO bs_transactions(
            transaction_id,account_id,item_id,user_id,name,
            merchant,amount,date,category,pending
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(transaction_id) DO UPDATE SET
            name=EXCLUDED.name,merchant=EXCLUDED.merchant,
            amount=EXCLUDED.amount,date=EXCLUDED.date,
            category=EXCLUDED.category,pending=EXCLUDED.pending,
            updated_at=NOW()
          WHERE bs_transactions.user_id=EXCLUDED.user_id
        `, [tx.transaction_id,tx.account_id,latest.item_id,
          latest.user_id,tx.name || "Unknown",tx.merchant_name || null,
          tx.amount,tx.date,
          tx.personal_finance_category?.primary || "OTHER",
          tx.pending === true]);
      }
      for (const tx of changes.removed) {
        await client.query(`
          DELETE FROM bs_transactions
          WHERE transaction_id=$1 AND user_id=$2
        `, [tx.transaction_id,latest.user_id]);
      }
      await client.query(`
        UPDATE bs_items
        SET cursor=$1,last_synced_at=NOW(),sync_error=NULL
        WHERE item_id=$2 AND user_id=$3
      `, [cursor,latest.item_id,latest.user_id]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }
    return { ok: true,added:changes.added.length,
      modified:changes.modified.length,removed:changes.removed.length };
  } catch (err) {
    await client.query(`
      UPDATE bs_items SET sync_error=$1 WHERE item_id=$2 AND user_id=$3
    `, [String(err?.response?.data?.error_code || "SYNC_FAILED").slice(0,100),
      item.item_id,item.user_id]).catch(() => { broken = true; });
    throw err;
  } finally {
    if (locked) {
      await client.query(`
        SELECT pg_advisory_unlock(hashtext($1),hashtext($2))
      `, ["bs-sync",item.item_id]).catch(() => { broken = true; });
    }
    client.release(broken);
  }
}

api.post("/transactions/sync", asyncHandler(async (req, res) => {
  const r = await pool.query("SELECT * FROM bs_items WHERE user_id=$1",
    [req.userId]);
  const results = [];
  for (const item of r.rows) {
    try {
      results.push({ item_id:item.item_id,...await syncItem(item) });
    } catch {
      results.push({ item_id:item.item_id,ok:false });
    }
  }
  res.json({ results });
}));

api.get("/transactions", asyncHandler(async (req, res) => {
  const p = await pool.query(`
    SELECT transaction_id AS id,name,merchant,amount,date,category,
      pending,account_id,'plaid' AS source
    FROM bs_transactions WHERE user_id=$1 ORDER BY date DESC LIMIT 500
  `,[req.userId]);
  const m = await pool.query(`
    SELECT id,name,NULL AS merchant,amount,date,category,
      FALSE AS pending,NULL AS account_id,'manual' AS source
    FROM bs_manual_transactions
    WHERE user_id=$1 ORDER BY date DESC LIMIT 500
  `,[req.userId]);
  res.json({ transactions:[...p.rows,...m.rows]
    .sort((a,b) => String(b.date).localeCompare(String(a.date))) });
}));

api.post("/transactions/manual", asyncHandler(async (req,res) => {
  const transactionId = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_manual_transactions(id,user_id,name,amount,date,category)
    VALUES($1,$2,$3,$4,$5,$6)
  `,[transactionId,req.userId,stringValue(req.body.name),
    money(req.body.amount),date(req.body.date),
    stringValue(req.body.category,80)]);
  res.status(201).json({ id:transactionId });
}));
api.delete("/transactions/manual/:id", asyncHandler(async (req,res) => {
  await pool.query(`
    DELETE FROM bs_manual_transactions WHERE id=$1 AND user_id=$2
  `,[id(req.params.id),req.userId]);
  res.json({ ok:true });
}));

api.get("/budgets", asyncHandler(async (req,res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) bad(400,"Invalid month");
  const r = await pool.query(`
    SELECT category,amount FROM bs_budgets
    WHERE user_id=$1 AND month_key=$2 ORDER BY category
  `,[req.userId,month]);
  res.json({ month,budgets:r.rows });
}));
api.put("/budgets", asyncHandler(async (req,res) => {
  const month = String(req.body.month || "");
  const input = req.body.budgets;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      !Array.isArray(input) || input.length > 100) bad(400,"Invalid budgets");
  const rows = input.map(x => ({
    category:stringValue(x.category,80),amount:money(x.amount,true)
  }));
  if (new Set(rows.map(x => x.category)).size !== rows.length) {
    bad(400,"Duplicate categories");
  }
  if (rows.some(x => x.amount < 0)) bad(400,"Invalid budget amount");
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM bs_budgets WHERE user_id=$1 AND month_key=$2",
      [req.userId,month]);
    for (const x of rows) {
      await c.query(`
        INSERT INTO bs_budgets(user_id,month_key,category,amount)
        VALUES($1,$2,$3,$4)
      `,[req.userId,month,x.category,x.amount]);
    }
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");throw err;
  } finally { c.release(); }
  res.json({ ok:true });
}));

api.get("/bills", asyncHandler(async (req,res) => {
  const r = await pool.query("SELECT * FROM bs_bills WHERE user_id=$1 ORDER BY due_date",
    [req.userId]);
  res.json({ bills:r.rows });
}));
api.post("/bills", asyncHandler(async (req,res) => {
  const billId = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_bills(id,user_id,name,amount,due_date) VALUES($1,$2,$3,$4,$5)
  `,[billId,req.userId,stringValue(req.body.name),
    money(req.body.amount,true),date(req.body.due_date)]);
  res.status(201).json({ id:billId });
}));
api.patch("/bills/:id", asyncHandler(async (req,res) => {
  if (typeof req.body.paid !== "boolean") bad(400,"Invalid paid status");
  await pool.query("UPDATE bs_bills SET paid=$1 WHERE id=$2 AND user_id=$3",
    [req.body.paid,id(req.params.id),req.userId]);
  res.json({ ok:true });
}));
api.get("/goals", asyncHandler(async (req,res) => {
  const r = await pool.query("SELECT * FROM bs_goals WHERE user_id=$1 ORDER BY name",
    [req.userId]);
  res.json({ goals:r.rows });
}));
api.post("/goals", asyncHandler(async (req,res) => {
  const goalId = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_goals(id,user_id,name,target,progress,is_debt)
    VALUES($1,$2,$3,$4,$5,$6)
  `,[goalId,req.userId,stringValue(req.body.name),
    money(req.body.target,true),money(req.body.progress ?? 0),
    req.body.is_debt === true]);
  res.status(201).json({ id:goalId });
}));

api.get("/preferences", asyncHandler(async (req,res) => {
  const r = await pool.query("SELECT * FROM bs_preferences WHERE user_id=$1",
    [req.userId]);
  res.json({ preferences:r.rows[0] || {
    checking_reserve:200,planned_spending:0,planned_debt:0,planned_savings:0
  }});
}));
api.put("/preferences", asyncHandler(async (req,res) => {
  const fields = ["checking_reserve","planned_spending",
    "planned_debt","planned_savings"];
  const values = fields.map(k => money(req.body[k]));
  if (values.some(v => v < 0)) bad(400,"Invalid preference");
  await pool.query(`
    INSERT INTO bs_preferences(
      user_id,checking_reserve,planned_spending,planned_debt,planned_savings
    ) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE SET
      checking_reserve=EXCLUDED.checking_reserve,
      planned_spending=EXCLUDED.planned_spending,
      planned_debt=EXCLUDED.planned_debt,
      planned_savings=EXCLUDED.planned_savings,
      updated_at=NOW()
  `,[req.userId,...values]);
  res.json({ ok:true });
}));
api.get("/sync-health", asyncHandler(async (req,res) => {
  const r = await pool.query(`
    SELECT item_id,institution_name,last_synced_at,sync_error
    FROM bs_items WHERE user_id=$1
  `,[req.userId]);
  res.json({ items:r.rows.map(x => ({
    ...x,status:x.sync_error?"error":x.last_synced_at?"synced":"not_yet_synced"
  })) });
}));
api.post("/plaid/disconnect", asyncHandler(async (req,res) => {
  const itemId = stringValue(req.body.item_id,200);
  const r = await pool.query(
    "SELECT * FROM bs_items WHERE item_id=$1 AND user_id=$2",
    [itemId,req.userId]);
  if (!r.rows.length) bad(404,"Connection not found");
  await plaidClient.itemRemove({ access_token:dec(r.rows[0].token_encrypted) });
  const c = await pool.connect();
  try {
    await c.query("BEGIN");
    await c.query("DELETE FROM bs_transactions WHERE item_id=$1 AND user_id=$2",
      [itemId,req.userId]);
    await c.query("DELETE FROM bs_items WHERE item_id=$1 AND user_id=$2",
      [itemId,req.userId]);
    await c.query("COMMIT");
  } catch(err) { await c.query("ROLLBACK");throw err; }
  finally { c.release(); }
  res.json({ ok:true });
}));
app.use("/api",api);

async function verifyWebhook(req) {
  const signed = req.get("plaid-verification");
  if (!signed || !Buffer.isBuffer(req.body)) bad(401,"Invalid webhook");
  const header = decodeProtectedHeader(signed);
  if (header.alg !== "ES256" || typeof header.kid !== "string") {
    bad(401,"Invalid signature");
  }
  const r = await plaidClient.webhookVerificationKeyGet({ key_id:header.kid });
  const jwk = r.data.key;
  if (jwk.kid !== header.kid || jwk.alg !== "ES256") {
    bad(401,"Invalid verification key");
  }
  const key = await importJWK(jwk,"ES256");
  const { payload } = await jwtVerify(signed,key,{
    algorithms:["ES256"],maxTokenAge:"5 min",clockTolerance:"30s"
  });
  if (typeof payload.request_body_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(payload.request_body_sha256)) {
    bad(401,"Invalid hash");
  }
  const actual = crypto.createHash("sha256").update(req.body).digest();
  const expected = Buffer.from(payload.request_body_sha256,"hex");
  if (!crypto.timingSafeEqual(actual,expected)) bad(401,"Body mismatch");
  return JSON.parse(req.body.toString("utf8"));
}

app.post("/plaid/webhook",asyncHandler(async (req,res) => {
  const body = await verifyWebhook(req);
  if (body.webhook_type === "LINK" &&
      body.webhook_code === "SESSION_FINISHED" &&
      body.status === "success" &&
      body.environment === ENV &&
      Array.isArray(body.public_tokens) &&
      body.public_tokens.length === 1) {
    await finishSession(body.link_token,body.public_tokens[0]);
  }
  if (body.webhook_type === "TRANSACTIONS" &&
      body.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
      typeof body.item_id === "string") {
    const r = await pool.query("SELECT * FROM bs_items WHERE item_id=$1",
      [body.item_id]);
    if (r.rows[0]) await syncItem(r.rows[0]);
  }
  res.json({ received:true });
}));

app.use((_req,res) => res.status(404).json({ error:"Not found" }));
app.use((err,req,res,_next) => {
  const status = Number.isInteger(err.status) ? err.status : 500;
  if (status >= 500) {
    console.error("BudgetSaver error",req.path,err.name);
  }
  res.status(status).json({
    error:status >= 500 ? "Internal server error" : err.message
  });
});

initializeDatabase().then(() => {
  app.listen(PORT,"0.0.0.0",() => {
    console.log("BudgetSaver Alpha 0.7.1 listening on",PORT);
  });
}).catch(err => {
  console.error("Startup failed",err.message);
  process.exit(1);
});
