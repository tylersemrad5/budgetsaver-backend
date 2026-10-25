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
const WEB_ORIGIN = "https://budgetsaver-backend.onrender.com";
const REDIRECT_URI = `${WEB_ORIGIN}/plaid/oauth`;

const PLAID_ENV = process.env.PLAID_ENV === "production"
  ? "production" : "sandbox";

// A deliberate safety gate: this alpha cannot enable
// Production linking simply by changing a Render setting.
const SANDBOX_LINKING =
  PLAID_ENV === "sandbox" &&
  process.env.ENABLE_PLAID_LINKING === "true";

for (const key of [
  "DATABASE_URL",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "FIREBASE_PROJECT_ID",
  "ALLOWED_FIREBASE_UID",
  "TOKEN_ENCRYPTION_KEY"
]) {
  if (!process.env[key]) {
    throw new Error(`Missing configuration: ${key}`);
  }
}

if (!/^[0-9a-f]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY)) {
  throw new Error("TOKEN_ENCRYPTION_KEY must be 64 hex characters");
}

const encryptionKey = Buffer.from(
  process.env.TOKEN_ENCRYPTION_KEY, "hex"
);

function encrypt(plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm", encryptionKey, iv
  );
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"), cipher.final()
  ]);
  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    ciphertext.toString("hex")
  ].join(":");
}

function decrypt(value) {
  const parts = String(value).split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted token");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey,
    Buffer.from(parts[1], "hex")
  );
  decipher.setAuthTag(Buffer.from(parts[2], "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], "hex")),
    decipher.final()
  ]).toString("utf8");
}

if (!getApps().length) {
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
}
const firebaseAuth = getAuth();

const plaidClient = new PlaidApi(new Configuration({
  basePath: PLAID_ENV === "production"
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

function error(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function wrapped(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function requiredText(value, max = 150) {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) {
    throw error(400, "Invalid text");
  }
  return result;
}

function money(value, allowZero = true) {
  if (value === undefined || value === null || value === "") {
    throw error(400, "Invalid amount");
  }
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    (!allowZero && number === 0) ||
    number > 1e9
  ) {
    throw error(400, "Invalid amount");
  }
  return Math.round(number * 100) / 100;
}

function signedMoney(value) {
  if (value === undefined || value === null || value === "") {
    throw error(400, "Invalid amount");
  }
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > 1e9) {
    throw error(400, "Invalid amount");
  }
  return Math.round(n * 100) / 100;
}

function dateString(value) {
  if (typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw error(400, "Invalid date");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw error(400, "Invalid date");
  }
  return value;
}

function uuid(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw error(400, "Invalid identifier");
  }
  return value;
}

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const origins = (process.env.ALLOWED_WEB_ORIGINS || "")
  .split(",").map(s => s.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || origins.includes(origin));
  }
}));

app.use(rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use("/plaid/webhook", express.raw({
  type: "application/json",
  limit: "256kb"
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
      item_id TEXT NOT NULL REFERENCES bs_items(item_id)
        ON DELETE CASCADE,
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
      item_id TEXT NOT NULL REFERENCES bs_items(item_id)
        ON DELETE CASCADE,
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
      checking_reserve NUMERIC(14,2) DEFAULT 200,
      planned_spending NUMERIC(14,2) DEFAULT 0,
      planned_debt NUMERIC(14,2) DEFAULT 0,
      planned_savings NUMERIC(14,2) DEFAULT 0,
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
    ALTER TABLE bs_users ALTER COLUMN apple_subject DROP NOT NULL;
    ALTER TABLE bs_users ADD COLUMN IF NOT EXISTS firebase_uid TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS bs_users_firebase_uid_idx
      ON bs_users(firebase_uid);
  `);

  console.log("BudgetSaver database initialized");
}

async function requireAuth(req, res, next) {
  const match = /^Bearer ([^\s]+)$/i.exec(
    req.get("authorization") || ""
  );
  if (!match) {
    return res.status(401).json({ error: "Authentication required" });
  }

  try {
    const identity = await firebaseAuth.verifyIdToken(match[1]);

    if (identity.uid !== process.env.ALLOWED_FIREBASE_UID) {
      return res.status(403).json({ error: "Account not authorized" });
    }

    const result = await pool.query(`
      INSERT INTO bs_users(id, firebase_uid)
      VALUES($1, $2)
      ON CONFLICT(firebase_uid)
      DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid
      RETURNING id
    `, [crypto.randomUUID(), identity.uid]);

    req.userId = result.rows[0].id;
    req.firebaseUid = identity.uid;
    next();
  } catch (err) {
    if (err.code === "permission-denied") {
      return res.status(403).json({ error: "Access denied" });
    }
    next(error(401, "Invalid authentication"));
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "BudgetSaver",
    version: "2.0-alpha.6",
    plaid_environment: PLAID_ENV,
    plaid_linking_enabled: SANDBOX_LINKING
  });
});

const directory = path.dirname(fileURLToPath(import.meta.url));
const webFile = path.join(directory, "public", "connect-bank.html");

app.get(["/connect-bank", "/plaid/oauth"], (_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self' https:; " +
    "script-src 'self' 'unsafe-inline' https:; " +
    "style-src 'self' 'unsafe-inline'; " +
    "img-src 'self' https: data:; " +
    "connect-src 'self' https:; frame-src https:; " +
    "form-action 'self' https:; " +
    "object-src 'none'; base-uri 'none'"
  );
  res.sendFile(webFile);
});

const api = express.Router();
api.use(requireAuth);

api.get("/auth/me", (req, res) => {
  res.json({
    authenticated: true,
    uid: req.firebaseUid
  });
});

api.get("/plaid/status", (_req, res) => {
  res.json({
    environment: PLAID_ENV,
    linking_enabled: SANDBOX_LINKING,
    production_ready: false,
    mode: SANDBOX_LINKING ? "sandbox" : "disabled"
  });
});

function requireLinking(req, res, next) {
  if (!SANDBOX_LINKING) {
    return res.status(503).json({
      error: "Linking is disabled pending security testing"
    });
  }
  next();
}

api.post("/plaid/web/link-token", requireLinking, wrapped(async (req, res) => {
  const response = await plaidClient.linkTokenCreate({
    client_name: "BudgetSaver",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: req.userId },
    products: ["transactions"],
    redirect_uri: REDIRECT_URI,
    ...(process.env.PLAID_WEBHOOK_URL
      ? { webhook: process.env.PLAID_WEBHOOK_URL }
      : {})
  });

  const sessionId = crypto.randomUUID();
  const plaidExpiration = Date.parse(response.data.expiration);
  const expiration = new Date(
    Math.min(
      Number.isFinite(plaidExpiration)
        ? plaidExpiration
        : Date.now() + 1_200_000,
      Date.now() + 1_200_000
    )
  );

  await pool.query(`
    INSERT INTO bs_web_link_sessions(
      session_id, user_id, link_token_ciphertext, expires_at
    ) VALUES($1,$2,$3,$4)
  `, [
    sessionId,
    req.userId,
    encrypt(response.data.link_token),
    expiration
  ]);

  res.json({
    session_id: sessionId,
    link_token: response.data.link_token,
    expiration: expiration.toISOString()
  });
}));

api.post("/plaid/web/resume", requireLinking, wrapped(async (req, res) => {
  const sessionId = uuid(req.body?.session_id);

  const result = await pool.query(`
    SELECT link_token_ciphertext
    FROM bs_web_link_sessions
    WHERE session_id=$1 AND user_id=$2
      AND consumed_at IS NULL
      AND expires_at>NOW()
  `, [sessionId, req.userId]);

  if (!result.rows.length) {
    throw error(404, "Session expired or unavailable");
  }

  res.json({
    link_token: decrypt(result.rows[0].link_token_ciphertext)
  });
}));

// Disabled native endpoints cannot bypass the browser flow.
api.post("/plaid/link-token", (_req, res) => {
  res.status(503).json({
    error: "Native Plaid linking is disabled"
  });
});

api.post("/plaid/exchange", (_req, res) => {
  res.status(503).json({
    error: "Use the authenticated browser connection"
  });
});

// Sandbox-only connection exchange.
// The client-provided session ID is not sufficient proof
// for Production. Production linking needs stronger
// validation of the actual completed Link session.
api.post("/plaid/web/exchange", requireLinking, wrapped(async (req, res) => {
  const sessionId = uuid(req.body?.session_id);
  const publicToken = req.body?.public_token;

  if (
    typeof publicToken !== "string" ||
    !publicToken.startsWith("public-sandbox-") ||
    publicToken.length > 2048
  ) {
    throw error(400, "Invalid Sandbox public token");
  }

  const claimed = await pool.query(`
    UPDATE bs_web_link_sessions
    SET consumed_at=NOW()
    WHERE session_id=$1
      AND user_id=$2
      AND consumed_at IS NULL
      AND expires_at>NOW()
    RETURNING session_id
  `, [sessionId, req.userId]);

  if (!claimed.rows.length) {
    throw error(409, "Session already used or expired");
  }

  const response = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken
  });

  const { item_id, access_token } = response.data;

  const saved = await pool.query(`
    INSERT INTO bs_items(item_id,user_id,token_encrypted)
    VALUES($1,$2,$3)
    ON CONFLICT(item_id) DO NOTHING
    RETURNING item_id
  `, [
    item_id,
    req.userId,
    encrypt(access_token)
  ]);

  if (!saved.rows.length) {
    await plaidClient.itemRemove({
      access_token
    }).catch(() => {});
    throw error(409, "Item already connected");
  }

  res.json({
    ok: true,
    item_id
  });
}));

async function refreshAccounts(item) {
  const response = await plaidClient.accountsGet({
    access_token: decrypt(item.token_encrypted)
  });

  for (const account of response.data.accounts) {
    await pool.query(`
      INSERT INTO bs_accounts(
        account_id,item_id,user_id,name,type,
        subtype,mask,current_balance,available_balance,updated_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
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
      account.account_id,
      item.item_id,
      item.user_id,
      account.name,
      account.type,
      account.subtype,
      account.mask || null,
      account.balances?.current ?? null,
      account.balances?.available ?? null
    ]);
  }
}

api.get("/accounts", wrapped(async (req, res) => {
  const result = await pool.query(`
    SELECT account_id,item_id,name,type,subtype,mask,
      current_balance,available_balance,updated_at
    FROM bs_accounts
    WHERE user_id=$1
    ORDER BY name
  `, [req.userId]);

  res.json({ accounts: result.rows });
}));

api.post("/accounts/refresh", wrapped(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bs_items WHERE user_id=$1",
    [req.userId]
  );

  for (const item of result.rows) {
    await refreshAccounts(item);
  }

  res.json({ ok: true });
}));

// The database advisory lock protects a transaction sync
// across multiple server processes using the same Postgres DB.
async function syncItem(item) {
  const client = await pool.connect();
  let locked = false;

  try {
    const lockResult = await client.query(`
      SELECT pg_try_advisory_lock(hashtext($1), hashtext($2)) AS locked
    `, ["budgetsaver-sync", item.item_id]);

    locked = lockResult.rows[0]?.locked === true;

    if (!locked) {
      return {
        skipped: true,
        reason: "already_syncing"
      };
    }

    const itemResult = await client.query(`
      SELECT *
      FROM bs_items
      WHERE item_id=$1 AND user_id=$2
    `, [item.item_id, item.user_id]);

    const latest = itemResult.rows[0];
    if (!latest) {
      throw error(404, "Plaid item not found");
    }

    const accessToken = decrypt(latest.token_encrypted);
    const originalCursor = latest.cursor || null;

    let changes = null;
    let finalCursor = originalCursor;

    for (let attempt = 0; attempt < 3; attempt++) {
      let cursor = originalCursor;
      let hasMore = true;

      const batch = {
        added: [],
        modified: [],
        removed: []
      };

      try {
        while (hasMore) {
          const response = await plaidClient.transactionsSync({
            access_token: accessToken,
            cursor: cursor || undefined,
            count: 500
          });

          batch.added.push(...response.data.added);
          batch.modified.push(...response.data.modified);
          batch.removed.push(...response.data.removed);

          cursor = response.data.next_cursor;
          hasMore = response.data.has_more;
        }

        changes = batch;
        finalCursor = cursor;
        break;
      } catch (err) {
        if (
          err?.response?.data?.error_code ===
            "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
          attempt < 2
        ) {
          continue;
        }
        throw err;
      }
    }

    if (!changes) {
      throw new Error("Unable to complete transaction sync");
    }

    await client.query("BEGIN");

    try {
      for (const tx of [
        ...changes.added,
        ...changes.modified
      ]) {
        await client.query(`
          INSERT INTO bs_transactions(
            transaction_id,account_id,item_id,user_id,
            name,merchant,amount,date,category,pending
          )
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
          tx.transaction_id,
          tx.account_id,
          latest.item_id,
          latest.user_id,
          tx.name || "Unknown",
          tx.merchant_name || null,
          tx.amount,
          tx.date,
          tx.personal_finance_category?.primary || "OTHER",
          tx.pending === true
        ]);
      }

      for (const tx of changes.removed) {
        await client.query(`
          DELETE FROM bs_transactions
          WHERE transaction_id=$1 AND user_id=$2
        `, [tx.transaction_id, latest.user_id]);
      }

      await client.query(`
        UPDATE bs_items
        SET cursor=$1,last_synced_at=NOW(),sync_error=NULL
        WHERE item_id=$2 AND user_id=$3
      `, [finalCursor, latest.item_id, latest.user_id]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    }

    return {
      ok: true,
      added: changes.added.length,
      modified: changes.modified.length,
      removed: changes.removed.length
    };
  } catch (err) {
    try {
      await client.query(`
        UPDATE bs_items
        SET sync_error=$1
        WHERE item_id=$2 AND user_id=$3
      `, [
        String(
          err?.response?.data?.error_code || "SYNC_FAILED"
        ).slice(0, 100),
        item.item_id,
        item.user_id
      ]);
    } catch {
      // Preserve the original sync failure.
    }
    throw err;
  } finally {
    if (locked) {
      try {
        await client.query(`
          SELECT pg_advisory_unlock(hashtext($1), hashtext($2))
        `, ["budgetsaver-sync", item.item_id]);
      } catch (unlockError) {
        console.error("Sync lock release failed", unlockError.name);
        client.release(true);
        return;
      }
    }
    client.release();
  }
}

api.post("/transactions/sync", wrapped(async (req, res) => {
  const result = await pool.query(
    "SELECT * FROM bs_items WHERE user_id=$1",
    [req.userId]
  );

  const results = [];

  for (const item of result.rows) {
    try {
      results.push({
        item_id: item.item_id,
        ...(await syncItem(item))
      });
    } catch {
      results.push({
        item_id: item.item_id,
        ok: false
      });
    }
  }

  res.json({ results });
}));

api.get("/transactions", wrapped(async (req, res) => {
  const plaidResult = await pool.query(`
    SELECT transaction_id AS id,name,merchant,amount,date,
      category,pending,account_id,'plaid' AS source
    FROM bs_transactions
    WHERE user_id=$1
    ORDER BY date DESC
    LIMIT 500
  `, [req.userId]);

  const manualResult = await pool.query(`
    SELECT id,name,NULL AS merchant,amount,date,category,
      FALSE AS pending,NULL AS account_id,'manual' AS source
    FROM bs_manual_transactions
    WHERE user_id=$1
    ORDER BY date DESC
    LIMIT 500
  `, [req.userId]);

  const transactions = [
    ...plaidResult.rows,
    ...manualResult.rows
  ].sort((a, b) => String(b.date).localeCompare(String(a.date)));

  res.json({ transactions });
}));

api.post("/transactions/manual", wrapped(async (req, res) => {
  const id = crypto.randomUUID();

  await pool.query(`
    INSERT INTO bs_manual_transactions(
      id,user_id,name,amount,date,category
    ) VALUES($1,$2,$3,$4,$5,$6)
  `, [
    id,
    req.userId,
    requiredText(req.body?.name),
    signedMoney(req.body?.amount),
    dateString(req.body?.date),
    requiredText(req.body?.category, 80)
  ]);

  res.status(201).json({ id });
}));

api.delete("/transactions/manual/:id", wrapped(async (req, res) => {
  await pool.query(`
    DELETE FROM bs_manual_transactions
    WHERE id=$1 AND user_id=$2
  `, [uuid(req.params.id), req.userId]);

  res.json({ ok: true });
}));

api.get("/budgets", wrapped(async (req, res) => {
  const month = String(req.query.month || "");

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw error(400, "Invalid budget month");
  }

  const result = await pool.query(`
    SELECT category,amount
    FROM bs_budgets
    WHERE user_id=$1 AND month_key=$2
    ORDER BY category
  `, [req.userId, month]);

  res.json({
    month,
    budgets: result.rows
  });
}));

api.put("/budgets", wrapped(async (req, res) => {
  const month = String(req.body?.month || "");
  const budgets = req.body?.budgets;

  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !Array.isArray(budgets) ||
    budgets.length > 100
  ) {
    throw error(400, "Invalid budgets");
  }

  const entries = budgets.map(entry => ({
    category: requiredText(entry.category, 80),
    amount: money(entry.amount)
  }));

  if (
    new Set(entries.map(entry => entry.category)).size !==
    entries.length
  ) {
    throw error(400, "Duplicate budget categories");
  }

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      DELETE FROM bs_budgets
      WHERE user_id=$1 AND month_key=$2
    `, [req.userId, month]);

    for (const entry of entries) {
      await client.query(`
        INSERT INTO bs_budgets(
          user_id,month_key,category,amount
        ) VALUES($1,$2,$3,$4)
      `, [
        req.userId,
        month,
        entry.category,
        entry.amount
      ]);
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true });
}));

api.get("/bills", wrapped(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_bills
    WHERE user_id=$1 ORDER BY due_date
  `, [req.userId]);

  res.json({ bills: result.rows });
}));

api.post("/bills", wrapped(async (req, res) => {
  const id = crypto.randomUUID();

  await pool.query(`
    INSERT INTO bs_bills(
      id,user_id,name,amount,due_date
    ) VALUES($1,$2,$3,$4,$5)
  `, [
    id,
    req.userId,
    requiredText(req.body?.name),
    money(req.body?.amount, false),
    dateString(req.body?.due_date)
  ]);

  res.status(201).json({ id });
}));

api.patch("/bills/:id", wrapped(async (req, res) => {
  if (typeof req.body?.paid !== "boolean") {
    throw error(400, "Invalid paid status");
  }

  await pool.query(`
    UPDATE bs_bills SET paid=$1
    WHERE id=$2 AND user_id=$3
  `, [
    req.body.paid,
    uuid(req.params.id),
    req.userId
  ]);

  res.json({ ok: true });
}));

api.get("/goals", wrapped(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_goals
    WHERE user_id=$1 ORDER BY name
  `, [req.userId]);

  res.json({ goals: result.rows });
}));

api.post("/goals", wrapped(async (req, res) => {
  const id = crypto.randomUUID();

  await pool.query(`
    INSERT INTO bs_goals(
      id,user_id,name,target,progress,is_debt
    ) VALUES($1,$2,$3,$4,$5,$6)
  `, [
    id,
    req.userId,
    requiredText(req.body?.name),
    money(req.body?.target, false),
    money(req.body?.progress ?? 0),
    req.body?.is_debt === true
  ]);

  res.status(201).json({ id });
}));

api.get("/preferences", wrapped(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_preferences
    WHERE user_id=$1
  `, [req.userId]);

  res.json({
    preferences: result.rows[0] || {
      checking_reserve: "200.00",
      planned_spending: "0.00",
      planned_debt: "0.00",
      planned_savings: "0.00"
    }
  });
}));

api.put("/preferences", wrapped(async (req, res) => {
  await pool.query(`
    INSERT INTO bs_preferences(
      user_id,checking_reserve,planned_spending,
      planned_debt,planned_savings
    ) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id) DO UPDATE SET
      checking_reserve=EXCLUDED.checking_reserve,
      planned_spending=EXCLUDED.planned_spending,
      planned_debt=EXCLUDED.planned_debt,
      planned_savings=EXCLUDED.planned_savings,
      updated_at=NOW()
  `, [
    req.userId,
    money(req.body?.checking_reserve),
    money(req.body?.planned_spending),
    money(req.body?.planned_debt),
    money(req.body?.planned_savings)
  ]);

  res.json({ ok: true });
}));

api.get("/sync-health", wrapped(async (req, res) => {
  const result = await pool.query(`
    SELECT item_id,institution_name,last_synced_at,sync_error
    FROM bs_items WHERE user_id=$1
  `, [req.userId]);

  res.json({
    items: result.rows.map(item => ({
      ...item,
      status: item.sync_error
        ? "error"
        : item.last_synced_at
        ? "synced"
        : "not_yet_synced"
    }))
  });
}));

api.post("/plaid/disconnect", wrapped(async (req, res) => {
  const itemId = requiredText(req.body?.item_id, 200);

  const result = await pool.query(`
    SELECT * FROM bs_items
    WHERE item_id=$1 AND user_id=$2
  `, [itemId, req.userId]);

  const item = result.rows[0];

  if (!item) {
    throw error(404, "Bank connection not found");
  }

  await plaidClient.itemRemove({
    access_token: decrypt(item.token_encrypted)
  });

  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    await client.query(`
      DELETE FROM bs_transactions
      WHERE item_id=$1 AND user_id=$2
    `, [itemId, req.userId]);

    await client.query(`
      DELETE FROM bs_items
      WHERE item_id=$1 AND user_id=$2
    `, [itemId, req.userId]);

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  res.json({ ok: true });
}));

app.use("/api", api);

app.post("/plaid/webhook", wrapped(async (req, res) => {
  const signed = req.get("plaid-verification");

  if (!signed || !Buffer.isBuffer(req.body)) {
    throw error(401, "Invalid webhook");
  }

  const header = decodeProtectedHeader(signed);

  if (header.alg !== "ES256" || typeof header.kid !== "string") {
    throw error(401, "Invalid webhook signature");
  }

  const response = await plaidClient.webhookVerificationKeyGet({
    key_id: header.kid
  });

  const jwk = response.data.key;

  if (
    jwk.kid !== header.kid ||
    jwk.alg !== "ES256"
  ) {
    throw error(401, "Invalid verification key");
  }

  const key = await importJWK(jwk, "ES256");

  const { payload } = await jwtVerify(signed, key, {
    algorithms: ["ES256"],
    maxTokenAge: "5 min",
    clockTolerance: "30s"
  });

  if (
    typeof payload.request_body_sha256 !== "string" ||
    !/^[0-9a-f]{64}$/i.test(payload.request_body_sha256)
  ) {
    throw error(401, "Invalid webhook body hash");
  }

  const actualHash = crypto
    .createHash("sha256")
    .update(req.body)
    .digest();

  const expectedHash = Buffer.from(
    payload.request_body_sha256, "hex"
  );

  if (!crypto.timingSafeEqual(actualHash, expectedHash)) {
    throw error(401, "Webhook body mismatch");
  }

  const body = JSON.parse(req.body.toString("utf8"));

  if (
    body.webhook_type === "TRANSACTIONS" &&
    body.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
    typeof body.item_id === "string"
  ) {
    const result = await pool.query(
      "SELECT * FROM bs_items WHERE item_id=$1",
      [body.item_id]
    );

    if (result.rows[0]) {
      await syncItem(result.rows[0]);
    }
  }

  res.json({ received: true });
}));

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, _next) => {
  const status = Number.isInteger(err.status)
    ? err.status : 500;

  if (status >= 500) {
    console.error("BudgetSaver request failed", {
      path: req.path,
      type: err.name
    });
  }

  res.status(status).json({
    error: status >= 500
      ? "Internal server error"
      : err.message
  });
});

async function start() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`BudgetSaver Alpha 0.6 running on ${PORT}`);
    console.log(`Plaid environment: ${PLAID_ENV}`);
    console.log(`Sandbox linking enabled: ${SANDBOX_LINKING}`);
  });
}

start().catch(err => {
  console.error("Backend startup failed", err.message);
  process.exit(1);
});
