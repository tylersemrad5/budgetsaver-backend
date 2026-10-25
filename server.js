
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import pg from "pg";
import plaid from "plaid";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { initializeApp, getApps } from "firebase-admin/app";
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
const REDIRECT_URI = `${ORIGIN}/plaid/oauth`;
const SANDBOX_LINKING = process.env.ENABLE_PLAID_LINKING === "true" &&
  process.env.PLAID_ENV === "sandbox";

for (const key of [
  "DATABASE_URL", "PLAID_CLIENT_ID", "PLAID_SECRET",
  "FIREBASE_PROJECT_ID", "ALLOWED_FIREBASE_UID", "TOKEN_ENCRYPTION_KEY"
]) {
  if (!process.env[key]) throw new Error(`Missing configuration: ${key}`);
}

if (!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY)) {
  throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters");
}

const KEY = Buffer.from(process.env.TOKEN_ENCRYPTION_KEY, "hex");

if (!getApps().length) {
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
}

const auth = getAuth();

const plaidClient = new PlaidApi(new Configuration({
  basePath: process.env.PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
      "Plaid-Version": "2020-09-14"
    }
  }
}));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_CA_CERT
    ? {
        rejectUnauthorized: true,
        ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n")
      }
    : false,
  max: 5,
  connectionTimeoutMillis: 10000
});

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const data = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);
  return [
    "v1", iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    data.toString("hex")
  ].join(":");
}

function decrypt(value) {
  const parts = String(value).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm", KEY, Buffer.from(parts[1], "hex")
  );
  decipher.setAuthTag(Buffer.from(parts[2], "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], "hex")),
    decipher.final()
  ]).toString("utf8");
}

function fail(status, message) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function route(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function textField(value, max = 150) {
  const valueText = String(value ?? "").trim();
  if (!valueText || valueText.length > max) {
    fail(400, "Invalid text field");
  }
  return valueText;
}

function money(value, zero = true) {
  if (value === null || value === undefined || value === "") {
    fail(400, "Invalid amount");
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || (!zero && n === 0) || n > 1e9) {
    fail(400, "Invalid amount");
  }
  return Math.round(n * 100) / 100;
}

function dateField(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T12:00:00Z`))
  ) fail(400, "Invalid date");
  return value;
}

function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  ) fail(400, "Invalid identifier");
  return value;
}

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const allowedOrigins = (process.env.ALLOWED_WEB_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    cb(null, !origin || allowedOrigins.includes(origin));
  }
}));

app.use(rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false
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
      PRIMARY KEY(user_id, month_key, category)
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

    CREATE TABLE IF NOT EXISTS bs_web_link_sessions (
      session_id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      link_token_ciphertext TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      consumed_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS bs_items_user_idx
      ON bs_items(user_id);
    CREATE INDEX IF NOT EXISTS bs_accounts_user_idx
      ON bs_accounts(user_id);
    CREATE INDEX IF NOT EXISTS bs_transactions_user_date_idx
      ON bs_transactions(user_id, date DESC);
    CREATE INDEX IF NOT EXISTS bs_web_link_sessions_user_idx
      ON bs_web_link_sessions(user_id);
  `);

  await pool.query(`
    ALTER TABLE bs_users
      ALTER COLUMN apple_subject DROP NOT NULL;
    ALTER TABLE bs_users
      ADD COLUMN IF NOT EXISTS firebase_uid TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS bs_users_firebase_uid_idx
      ON bs_users(firebase_uid);
  `);

  console.log("BudgetSaver database initialized");
}

async function requireAuth(req, res, next) {
  try {
    const match = /^Bearer ([^\s]+)$/i.exec(req.get("authorization") || "");
    if (!match) return res.status(401).json({ error: "Authentication required" });

    const identity = await auth.verifyIdToken(match[1]);
    if (identity.uid !== process.env.ALLOWED_FIREBASE_UID) {
      return res.status(403).json({ error: "Account not authorized" });
    }

    const result = await pool.query(`
      INSERT INTO bs_users(id, firebase_uid) VALUES($1,$2)
      ON CONFLICT(firebase_uid)
      DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid
      RETURNING id
    `, [crypto.randomUUID(), identity.uid]);

    req.userId = result.rows[0].id;
    req.firebaseUid = identity.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired authentication" });
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "BudgetSaver",
    version: "2.0-alpha.5",
    plaid_linking_enabled: SANDBOX_LINKING
  });
});

const rootDir = path.dirname(fileURLToPath(import.meta.url));
const webPage = path.join(rootDir, "public", "connect-bank.html");

app.get(["/connect-bank", "/plaid/oauth"], (_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' https:; " +
    "script-src 'self' 'unsafe-inline' https:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https: data:; connect-src 'self' https:; " +
    "frame-src https:; form-action 'self' https:; " +
    "object-src 'none'; base-uri 'none'"
  );
  res.sendFile(webPage);
});

const api = express.Router();
api.use(requireAuth);

api.get("/auth/me", (req, res) => {
  res.json({ authenticated: true, uid: req.firebaseUid });
});

function requireSandboxLink(req, res, next) {
  if (!SANDBOX_LINKING) {
    return res.status(503).json({
      error: "Bank linking is disabled. Complete security testing first."
    });
  }
  next();
}

api.post("/plaid/web/link-token", requireSandboxLink, route(async (req, res) => {
  const response = await plaidClient.linkTokenCreate({
    client_name: "BudgetSaver",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: req.userId },
    products: ["transactions"],
    redirect_uri: REDIRECT_URI,
    ...(process.env.PLAID_WEBHOOK_URL
      ? { webhook: process.env.PLAID_WEBHOOK_URL } : {})
  });

  const id = crypto.randomUUID();
  const expiry = new Date(Math.min(
    Date.parse(response.data.expiration) || Date.now() + 1_200_000,
    Date.now() + 1_200_000
  ));

  await pool.query(`
    INSERT INTO bs_web_link_sessions
      (session_id,user_id,link_token_ciphertext,expires_at)
    VALUES($1,$2,$3,$4)
  `, [id, req.userId, encrypt(response.data.link_token), expiry]);

  res.json({
    session_id: id,
    link_token: response.data.link_token,
    expiration: expiry.toISOString()
  });
}));

api.post("/plaid/web/resume", requireSandboxLink, route(async (req, res) => {
  const id = uuid(req.body?.session_id);
  const result = await pool.query(`
    SELECT link_token_ciphertext FROM bs_web_link_sessions
    WHERE session_id=$1 AND user_id=$2
      AND consumed_at IS NULL AND expires_at>NOW()
  `, [id, req.userId]);

  if (!result.rows.length) fail(404, "Link session expired");
  res.json({ link_token: decrypt(result.rows[0].link_token_ciphertext) });
}));

// Native linking and legacy token exchange are disabled in this alpha.
api.post("/plaid/link-token", (_req, res) => {
  res.status(503).json({ error: "Native linking is disabled" });
});
api.post("/plaid/exchange", (_req, res) => {
  res.status(503).json({ error: "Use the session-bound browser exchange" });
});

api.post("/plaid/web/exchange", requireSandboxLink, route(async (req, res) => {
  const id = uuid(req.body?.session_id);
  const publicToken = req.body?.public_token;
  if (typeof publicToken !== "string" ||
      !publicToken.startsWith("public-") ||
      publicToken.length > 2048) fail(400, "Invalid public token");

  // Claim once, atomically.
  const claimed = await pool.query(`
    UPDATE bs_web_link_sessions
    SET consumed_at=NOW()
    WHERE session_id=$1 AND user_id=$2
      AND consumed_at IS NULL AND expires_at>NOW()
    RETURNING session_id
  `, [id, req.userId]);

  if (!claimed.rows.length) fail(409, "Session expired or already used");

  const exchange = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken
  });

  const { item_id, access_token } = exchange.data;
  const saved = await pool.query(`
    INSERT INTO bs_items(item_id,user_id,token_encrypted)
    VALUES($1,$2,$3)
    ON CONFLICT(item_id) DO NOTHING
    RETURNING item_id
  `, [item_id, req.userId, encrypt(access_token)]);

  if (!saved.rows.length) {
    await plaidClient.itemRemove({ access_token }).catch(() => {});
    fail(409, "Bank item already connected");
  }

  res.json({ ok: true, item_id });
}));

async function refreshAccounts(item) {
  const response = await plaidClient.accountsGet({
    access_token: decrypt(item.token_encrypted)
  });

  for (const a of response.data.accounts) {
    await pool.query(`
      INSERT INTO bs_accounts(
        account_id,item_id,user_id,name,type,subtype,mask,
        current_balance,available_balance,updated_at
      ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT(account_id) DO UPDATE SET
        name=EXCLUDED.name,
        type=EXCLUDED.type,
        subtype=EXCLUDED.subtype,
        mask=EXCLUDED.mask,
        current_balance=EXCLUDED.current_balance,
        available_balance=EXCLUDED.available_balance,
        updated_at=NOW()
      WHERE bs_accounts.user_id=EXCLUDED.user_id
    `, [
      a.account_id, item.item_id, item.user_id,
      a.name, a.type, a.subtype, a.mask || null,
      a.balances?.current ?? null,
      a.balances?.available ?? null
    ]);
  }
}

api.get("/accounts", route(async (req, res) => {
  const result = await pool.query(`
    SELECT account_id,item_id,name,type,subtype,mask,
      current_balance,available_balance,updated_at
    FROM bs_accounts WHERE user_id=$1 ORDER BY name
  `, [req.userId]);
  res.json({ accounts: result.rows });
}));

api.post("/accounts/refresh", route(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bs_items WHERE user_id=$1", [req.userId]
  );
  for (const item of result.rows) await refreshAccounts(item);
  res.json({ ok: true });
}));

// One process-local sync guard. Multi-instance locking remains to be tested.
const syncingItems = new Set();

async function syncItem(item) {
  if (syncingItems.has(item.item_id)) {
    return { skipped: true, reason: "already_syncing" };
  }
  syncingItems.add(item.item_id);
  try {
    const accessToken = decrypt(item.token_encrypted);
    const initialCursor = item.cursor || null;
    let batch, finalCursor;

    for (let attempt = 0; attempt < 3; attempt++) {
      let cursor = initialCursor;
      let more = true;
      const next = { added: [], modified: [], removed: [] };

      try {
        while (more) {
          const response = await plaidClient.transactionsSync({
            access_token: accessToken,
            cursor: cursor || undefined,
            count: 500
          });
          next.added.push(...response.data.added);
          next.modified.push(...response.data.modified);
          next.removed.push(...response.data.removed);
          cursor = response.data.next_cursor;
          more = response.data.has_more;
        }
        batch = next;
        finalCursor = cursor;
        break;
      } catch (error) {
        if (error?.response?.data?.error_code ===
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
            attempt < 2) continue;
        throw error;
      }
    }

    if (!batch) throw new Error("Unable to sync transactions");
    const client = await pool.connect();

    try {
      await client.query("BEGIN");
      for (const t of [...batch.added, ...batch.modified]) {
        await client.query(`
          INSERT INTO bs_transactions(
            transaction_id,account_id,item_id,user_id,
            name,merchant,amount,date,category,pending
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(transaction_id) DO UPDATE SET
            name=EXCLUDED.name,
            merchant=EXCLUDED.merchant,
            amount=EXCLUDED.amount,
            date=EXCLUDED.date,
            category=EXCLUDED.category,
            pending=EXCLUDED.pending,
            updated_at=NOW()
          WHERE bs_transactions.user_id=EXCLUDED.user_id
        `, [
          t.transaction_id, t.account_id, item.item_id, item.user_id,
          t.name || "Unknown", t.merchant_name || null, t.amount,
          t.date, t.personal_finance_category?.primary || "OTHER",
          t.pending === true
        ]);
      }

      for (const t of batch.removed) {
        await client.query(`
          DELETE FROM bs_transactions
          WHERE transaction_id=$1 AND user_id=$2
        `, [t.transaction_id, item.user_id]);
      }

      await client.query(`
        UPDATE bs_items SET cursor=$1,last_synced_at=NOW(),sync_error=NULL
        WHERE item_id=$2 AND user_id=$3
      `, [finalCursor, item.item_id, item.user_id]);

      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      ok: true,
      added: batch.added.length,
      modified: batch.modified.length,
      removed: batch.removed.length
    };
  } catch (error) {
    await pool.query(`
      UPDATE bs_items SET sync_error=$1
      WHERE item_id=$2 AND user_id=$3
    `, [
      String(error?.response?.data?.error_code || "SYNC_FAILED").slice(0, 100),
      item.item_id, item.user_id
    ]);
    throw error;
  } finally {
    syncingItems.delete(item.item_id);
  }
}

api.post("/transactions/sync", route(async (req, res) => {
  const items = await pool.query(
    "SELECT * FROM bs_items WHERE user_id=$1", [req.userId]
  );
  const results = [];
  for (const item of items.rows) {
    try {
      results.push({ item_id: item.item_id, ...await syncItem(item) });
    } catch {
      results.push({ item_id: item.item_id, ok: false });
    }
  }
  res.json({ results });
}));

api.get("/transactions", route(async (req, res) => {
  const plaidResult = await pool.query(`
    SELECT transaction_id AS id,name,merchant,amount,date,
      category,pending,account_id,'plaid' AS source
    FROM bs_transactions WHERE user_id=$1 ORDER BY date DESC LIMIT 500
  `, [req.userId]);

  const manualResult = await pool.query(`
    SELECT id,name,NULL AS merchant,amount,date,category,
      FALSE AS pending,NULL AS account_id,'manual' AS source
    FROM bs_manual_transactions
    WHERE user_id=$1 ORDER BY date DESC LIMIT 500
  `, [req.userId]);

  const transactions = [...plaidResult.rows, ...manualResult.rows]
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  res.json({ transactions });
}));

api.post("/transactions/manual", route(async (req, res) => {
  const amount = Number(req.body?.amount);
  if (!Number.isFinite(amount) || Math.abs(amount) > 1e9) {
    fail(400, "Invalid amount");
  }
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_manual_transactions
      (id,user_id,name,amount,date,category)
    VALUES($1,$2,$3,$4,$5,$6)
  `, [
    id, req.userId, textField(req.body?.name), amount,
    dateField(req.body?.date), textField(req.body?.category, 80)
  ]);
  res.status(201).json({ id });
}));

api.delete("/transactions/manual/:id", route(async (req, res) => {
  await pool.query(`
    DELETE FROM bs_manual_transactions WHERE id=$1 AND user_id=$2
  `, [uuid(req.params.id), req.userId]);
  res.json({ ok: true });
}));

api.get("/budgets", route(async (req, res) => {
  const month = String(req.query.month || "");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    fail(400, "Invalid budget month");
  }
  const result = await pool.query(`
    SELECT category,amount FROM bs_budgets
    WHERE user_id=$1 AND month_key=$2 ORDER BY category
  `, [req.userId, month]);
  res.json({ month, budgets: result.rows });
}));

api.put("/budgets", route(async (req, res) => {
  const month = String(req.body?.month || "");
  const budgets = req.body?.budgets;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      !Array.isArray(budgets) || budgets.length > 100) {
    fail(400, "Invalid budgets");
  }
  const entries = budgets.map(b => ({
    category: textField(b.category, 80),
    amount: money(b.amount)
  }));
  if (new Set(entries.map(e => e.category)).size !== entries.length) {
    fail(400, "Duplicate budget categories");
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      "DELETE FROM bs_budgets WHERE user_id=$1 AND month_key=$2",
      [req.userId, month]
    );
    for (const e of entries) {
      await client.query(`
        INSERT INTO bs_budgets(user_id,month_key,category,amount)
        VALUES($1,$2,$3,$4)
      `, [req.userId, month, e.category, e.amount]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}));

api.get("/bills", route(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bs_bills WHERE user_id=$1 ORDER BY due_date",
    [req.userId]
  );
  res.json({ bills: result.rows });
}));

api.post("/bills", route(async (req, res) => {
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_bills(id,user_id,name,amount,due_date)
    VALUES($1,$2,$3,$4,$5)
  `, [
    id, req.userId, textField(req.body?.name),
    money(req.body?.amount, false), dateField(req.body?.due_date)
  ]);
  res.status(201).json({ id });
}));

api.patch("/bills/:id", route(async (req, res) => {
  if (typeof req.body?.paid !== "boolean") fail(400, "Invalid paid status");
  await pool.query(`
    UPDATE bs_bills SET paid=$1 WHERE id=$2 AND user_id=$3
  `, [req.body.paid, uuid(req.params.id), req.userId]);
  res.json({ ok: true });
}));

api.get("/goals", route(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bs_goals WHERE user_id=$1 ORDER BY name",
    [req.userId]
  );
  res.json({ goals: result.rows });
}));

api.post("/goals", route(async (req, res) => {
  const id = crypto.randomUUID();
  await pool.query(`
    INSERT INTO bs_goals(id,user_id,name,target,progress,is_debt)
    VALUES($1,$2,$3,$4,$5,$6)
  `, [
    id, req.userId, textField(req.body?.name),
    money(req.body?.target, false), money(req.body?.progress ?? 0),
    req.body?.is_debt === true
  ]);
  res.status(201).json({ id });
}));

api.get("/preferences", route(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bs_preferences WHERE user_id=$1", [req.userId]
  );
  res.json({
    preferences: result.rows[0] || {
      checking_reserve: "200.00",
      planned_spending: "0.00",
      planned_debt: "0.00",
      planned_savings: "0.00"
    }
  });
}));

api.put("/preferences", route(async (req, res) => {
  const values = [
    money(req.body?.checking_reserve),
    money(req.body?.planned_spending),
    money(req.body?.planned_debt),
    money(req.body?.planned_savings)
  ];
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
  `, [req.userId, ...values]);
  res.json({ ok: true });
}));

api.get("/sync-health", route(async (req, res) => {
  const result = await pool.query(`
    SELECT item_id,institution_name,last_synced_at,sync_error
    FROM bs_items WHERE user_id=$1
  `, [req.userId]);
  res.json({
    items: result.rows.map(i => ({
      ...i,
      status: i.sync_error ? "error" :
        i.last_synced_at ? "synced" : "not_yet_synced"
    }))
  });
}));

api.post("/plaid/disconnect", route(async (req, res) => {
  const itemId = textField(req.body?.item_id, 200);
  const found = await pool.query(`
    SELECT * FROM bs_items WHERE item_id=$1 AND user_id=$2
  `, [itemId, req.userId]);
  if (!found.rows.length) fail(404, "Bank connection not found");
  const item = found.rows[0];

  await plaidClient.itemRemove({
    access_token: decrypt(item.token_encrypted)
  });

  await pool.query(
    "DELETE FROM bs_transactions WHERE item_id=$1 AND user_id=$2",
    [itemId, req.userId]
  );
  await pool.query(
    "DELETE FROM bs_items WHERE item_id=$1 AND user_id=$2",
    [itemId, req.userId]
  );
  res.json({ ok: true });
}));

app.use("/api", api);

app.post("/plaid/webhook", route(async (req, res) => {
  const signed = req.get("plaid-verification");
  if (!signed || !Buffer.isBuffer(req.body)) {
    fail(401, "Invalid webhook");
  }
  const header = decodeProtectedHeader(signed);
  if (header.alg !== "ES256" || typeof header.kid !== "string") {
    fail(401, "Invalid signature header");
  }

  const response = await plaidClient.webhookVerificationKeyGet({
    key_id: header.kid
  });
  const jwk = response.data.key;
  if (jwk.kid !== header.kid || jwk.alg !== "ES256") {
    fail(401, "Invalid verification key");
  }

  const verificationKey = await importJWK(jwk, "ES256");
  const { payload } = await jwtVerify(signed, verificationKey, {
    algorithms: ["ES256"],
    maxTokenAge: "5 min",
    clockTolerance: "30s"
  });

  const sha = crypto.createHash("sha256").update(req.body).digest();
  if (typeof payload.request_body_sha256 !== "string" ||
      !/^[a-f0-9]{64}$/i.test(payload.request_body_sha256)) {
    fail(401, "Invalid webhook body hash");
  }
  const expected = Buffer.from(payload.request_body_sha256, "hex");
  if (!crypto.timingSafeEqual(sha, expected)) {
    fail(401, "Webhook body mismatch");
  }

  const body = JSON.parse(req.body.toString("utf8"));
  if (
    body.webhook_type === "TRANSACTIONS" &&
    body.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
    typeof body.item_id === "string"
  ) {
    const result = await pool.query(
      "SELECT * FROM bs_items WHERE item_id=$1", [body.item_id]
    );
    if (result.rows[0]) await syncItem(result.rows[0]);
  }
  res.json({ received: true });
}));

app.use((_req, res) => res.status(404).json({ error: "Not found" }));

app.use((error, req, res, _next) => {
  const status = Number.isInteger(error.status) ? error.status : 500;
  if (status >= 500) {
    console.error("Server operation failed", {
      path: req.path, type: error.name
    });
  }
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : error.message
  });
});

async function start() {
  await initializeDatabase();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`BudgetSaver 2.0 Alpha 0.5 running on port ${PORT}`);
    console.log(`Sandbox linking enabled: ${SANDBOX_LINKING}`);
  });
}

start().catch(error => {
  console.error("Backend startup failed:", error.message);
  process.exit(1);
});

