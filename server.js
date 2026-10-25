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
const WEBHOOK_URL = `${ORIGIN}/plaid/webhook`;

const PLAID_ENV = process.env.PLAID_ENV === "production"
  ? "production" : "sandbox";

const LIVE_ENABLED =
  process.env.ENABLE_LIVE_USAA_LINKING === "true" &&
  PLAID_ENV === "production";

const SANDBOX_ENABLED =
  process.env.ENABLE_PLAID_LINKING === "true" &&
  PLAID_ENV === "sandbox";

const LINKING_ENABLED = LIVE_ENABLED || SANDBOX_ENABLED;

for (const name of [
  "DATABASE_URL",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "FIREBASE_PROJECT_ID",
  "ALLOWED_FIREBASE_UID",
  "TOKEN_ENCRYPTION_KEY"
]) {
  if (!process.env[name]) {
    throw new Error(`Missing configuration: ${name}`);
  }
}

if (!/^[a-f0-9]{64}$/i.test(process.env.TOKEN_ENCRYPTION_KEY)) {
  throw new Error("Invalid TOKEN_ENCRYPTION_KEY");
}

if (LINKING_ENABLED) {
  if (
    process.env.PLAID_WEBHOOK_URL !== WEBHOOK_URL
  ) {
    throw new Error(
      `PLAID_WEBHOOK_URL must equal ${WEBHOOK_URL}`
    );
  }
}

const encryptionKey = Buffer.from(
  process.env.TOKEN_ENCRYPTION_KEY,
  "hex"
);

function encrypt(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    encryptionKey,
    iv
  );

  const encrypted = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final()
  ]);

  return [
    "v1",
    iv.toString("hex"),
    cipher.getAuthTag().toString("hex"),
    encrypted.toString("hex")
  ].join(":");
}

function decrypt(value) {
  const parts = String(value).split(":");

  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Invalid encrypted token");
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

function hashToken(value) {
  return crypto.createHmac("sha256", encryptionKey)
    .update(value)
    .digest("hex");
}

if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID
  });
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function validText(value, max = 150) {
  const result = String(value ?? "").trim();

  if (!result || result.length > max) {
    throw httpError(400, "Invalid text");
  }

  return result;
}

function validMoney(value, allowZero = true) {
  if (value === null || value === undefined || value === "") {
    throw httpError(400, "Invalid amount");
  }

  const amount = Number(value);

  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    (!allowZero && amount === 0) ||
    amount > 1e9
  ) {
    throw httpError(400, "Invalid amount");
  }

  return Math.round(amount * 100) / 100;
}

function signedMoney(value) {
  if (value === null || value === undefined || value === "") {
    throw httpError(400, "Invalid amount");
  }

  const amount = Number(value);

  if (!Number.isFinite(amount) || Math.abs(amount) > 1e9) {
    throw httpError(400, "Invalid amount");
  }

  return Math.round(amount * 100) / 100;
}

function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    throw httpError(400, "Invalid date");
  }

  const date = new Date(`${value}T00:00:00Z`);

  if (
    Number.isNaN(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    throw httpError(400, "Invalid date");
  }

  return value;
}

function validUUID(value) {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw httpError(400, "Invalid identifier");
  }

  return value;
}

// ---------------------------------------------
// Middleware
// ---------------------------------------------

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

const allowedOrigins = (
  process.env.ALLOWED_WEB_ORIGINS || ""
).split(",").map(x => x.trim()).filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    callback(null, !origin || allowedOrigins.includes(origin));
  }
}));

app.use(rateLimit({
  windowMs: 60_000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false
}));

app.use(
  "/plaid/webhook",
  express.raw({
    type: "application/json",
    limit: "256kb"
  })
);

app.use(express.json({ limit: "256kb" }));

// ---------------------------------------------
// Database
// ---------------------------------------------

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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      completed_at TIMESTAMPTZ
    );

    CREATE INDEX IF NOT EXISTS bs_items_user_idx
      ON bs_items(user_id);

    CREATE INDEX IF NOT EXISTS bs_accounts_user_idx
      ON bs_accounts(user_id);

    CREATE INDEX IF NOT EXISTS bs_transactions_user_date_idx
      ON bs_transactions(user_id,date DESC);

    CREATE INDEX IF NOT EXISTS bs_hosted_link_user_idx
      ON bs_hosted_link_sessions(user_id,created_at DESC);
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

// ---------------------------------------------
// Firebase authentication
// ---------------------------------------------

async function requireAuth(req, res, next) {
  const authorization = req.get("authorization") || "";
  const match = /^Bearer ([^\s]+)$/i.exec(authorization);

  if (!match) {
    return res.status(401).json({
      error: "Authentication required"
    });
  }

  let decoded;

  try {
    decoded = await firebaseAuth.verifyIdToken(
      match[1]
    );
  } catch {
    return res.status(401).json({
      error: "Invalid or expired authentication"
    });
  }

  if (decoded.uid !== process.env.ALLOWED_FIREBASE_UID) {
    return res.status(403).json({
      error: "Account not authorized"
    });
  }

  try {
    const result = await pool.query(`
      INSERT INTO bs_users(id,firebase_uid)
      VALUES($1,$2)
      ON CONFLICT(firebase_uid)
      DO UPDATE SET firebase_uid=EXCLUDED.firebase_uid
      RETURNING id
    `, [
      crypto.randomUUID(),
      decoded.uid
    ]);

    req.userId = result.rows[0].id;
    req.firebaseUid = decoded.uid;
    next();
  } catch (err) {
    next(err);
  }
}

// ---------------------------------------------
// Health and web page
// ---------------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "BudgetSaver",
    version: "2.0-alpha.7",
    plaid_environment: PLAID_ENV,
    plaid_linking_enabled: LINKING_ENABLED,
    hosted_link: true
  });
});

const directory = path.dirname(fileURLToPath(import.meta.url));
const webPage = path.join(
  directory,
  "public",
  "connect-bank.html"
);

app.get(["/connect-bank", "/plaid/oauth"], (_req, res) => {
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.gstatic.com; " +
    "style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self' https://*.googleapis.com " +
    "https://*.firebaseapp.com https://securetoken.googleapis.com; " +
    "img-src 'self' data:; " +
    "object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'"
  );
  res.sendFile(webPage);
});

// ---------------------------------------------
// Protected API
// ---------------------------------------------

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
    linking_enabled: LINKING_ENABLED,
    hosted_link: true,
    mode: !LINKING_ENABLED
      ? "disabled"
      : PLAID_ENV
  });
});

function requireLinking(req, res, next) {
  if (!LINKING_ENABLED) {
    return res.status(503).json({
      error: "Bank linking has not been enabled yet"
    });
  }
  next();
}

// ---------------------------------------------
// Start Plaid Hosted Link
// ---------------------------------------------

api.post(
  "/plaid/hosted/start",
  requireLinking,
  asyncRoute(async (req, res) => {
    const response = await plaidClient.linkTokenCreate({
      client_name: "BudgetSaver",
      language: "en",
      country_codes: ["US"],
      user: {
        client_user_id: req.userId
      },
      products: ["transactions"],
      webhook: WEBHOOK_URL,
      hosted_link: {
        url_lifetime_seconds: 900,
        completion_redirect_uri: `${ORIGIN}/connect-bank`
      }
    });

    const linkToken = response.data.link_token;
    const hostedURL = response.data.hosted_link_url;

    if (
      typeof linkToken !== "string" ||
      typeof hostedURL !== "string"
    ) {
      throw new Error("Plaid did not return Hosted Link");
    }

    const url = new URL(hostedURL);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "secure.plaid.com"
    ) {
      throw new Error("Unexpected Plaid Hosted Link URL");
    }

    const sessionId = crypto.randomUUID();

    await pool.query(`
      INSERT INTO bs_hosted_link_sessions(
        id,user_id,link_token_hash,status,expires_at
      )
      VALUES($1,$2,$3,'pending',NOW()+INTERVAL '30 minutes')
    `, [
      sessionId,
      req.userId,
      hashToken(linkToken)
    ]);

    res.json({
      session_id: sessionId,
      hosted_link_url: hostedURL
    });
  })
);

// ---------------------------------------------
// Poll current Hosted Link status
// ---------------------------------------------

api.get(
  "/plaid/hosted/status",
  asyncRoute(async (req, res) => {
    const sessionId = validUUID(req.query.session_id);

    const result = await pool.query(`
      SELECT
        status,item_id,error_code,completed_at
      FROM bs_hosted_link_sessions
      WHERE id=$1 AND user_id=$2
    `, [sessionId, req.userId]);

    if (!result.rows.length) {
      throw httpError(404, "Connection session not found");
    }

    res.json({
      session: result.rows[0]
    });
  })
);

api.get(
  "/plaid/hosted/latest",
  asyncRoute(async (req, res) => {
    const result = await pool.query(`
      SELECT id,status,created_at,completed_at
      FROM bs_hosted_link_sessions
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT 1
    `, [req.userId]);

    res.json({
      session: result.rows[0] || null
    });
  })
);

// Disable old browser and native token exchange paths.
// Hosted Link completion is handled by verified webhooks.
for (const endpoint of [
  "/plaid/web/link-token",
  "/plaid/web/resume",
  "/plaid/web/exchange",
  "/plaid/link-token",
  "/plaid/exchange"
]) {
  api.post(endpoint, (_req, res) => {
    res.status(410).json({
      error: "Use Plaid Hosted Link"
    });
  });
}

// ---------------------------------------------
// Account refresh
// ---------------------------------------------

async function refreshAccounts(item) {
  const response = await plaidClient.accountsGet({
    access_token: decrypt(item.token_encrypted)
  });

  for (const account of response.data.accounts) {
    await pool.query(`
      INSERT INTO bs_accounts(
        account_id,item_id,user_id,name,type,
        subtype,mask,current_balance,
        available_balance,updated_at
      )
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT(account_id)
      DO UPDATE SET
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

api.get("/accounts", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT account_id,item_id,name,type,subtype,mask,
      current_balance,available_balance,updated_at
    FROM bs_accounts
    WHERE user_id=$1
    ORDER BY name
  `, [req.userId]);

  res.json({ accounts: result.rows });
}));

api.post(
  "/accounts/refresh",
  asyncRoute(async (req, res) => {
    const result = await pool.query(
      "SELECT * FROM bs_items WHERE user_id=$1",
      [req.userId]
    );

    for (const item of result.rows) {
      await refreshAccounts(item);
    }

    res.json({ ok: true });
  })
);

// ---------------------------------------------
// Transaction sync, cross-process locking
// ---------------------------------------------

async function syncItem(item) {
  const client = await pool.connect();
  let locked = false;
  let mustDestroyClient = false;

  try {
    const result = await client.query(`
      SELECT pg_try_advisory_lock(
        hashtext($1),hashtext($2)
      ) AS locked
    `, ["budgetsaver-sync", item.item_id]);

    locked = result.rows[0]?.locked === true;

    if (!locked) {
      return {
        skipped: true,
        reason: "already_syncing"
      };
    }

    const latestResult = await client.query(`
      SELECT * FROM bs_items
      WHERE item_id=$1 AND user_id=$2
    `, [item.item_id, item.user_id]);

    const latest = latestResult.rows[0];

    if (!latest) {
      throw httpError(404, "Bank item not found");
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
      throw new Error("Transaction sync failed");
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
      `, [
        finalCursor,
        latest.item_id,
        latest.user_id
      ]);

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
        UPDATE bs_items SET sync_error=$1
        WHERE item_id=$2 AND user_id=$3
      `, [
        String(
          err?.response?.data?.error_code ||
          "SYNC_FAILED"
        ).slice(0, 100),
        item.item_id,
        item.user_id
      ]);
    } catch {
      mustDestroyClient = true;
    }

    throw err;
  } finally {
    if (locked) {
      try {
        await client.query(`
          SELECT pg_advisory_unlock(
            hashtext($1),hashtext($2)
          )
        `, ["budgetsaver-sync", item.item_id]);
      } catch {
        mustDestroyClient = true;
      }
    }

    client.release(mustDestroyClient);
  }
}

api.post(
  "/transactions/sync",
  asyncRoute(async (req, res) => {
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
  })
);

api.get(
  "/transactions",
  asyncRoute(async (req, res) => {
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
    ].sort((a, b) =>
      String(b.date).localeCompare(String(a.date))
    );

    res.json({ transactions });
  })
);

// ---------------------------------------------
// Manual transactions
// ---------------------------------------------

api.post(
  "/transactions/manual",
  asyncRoute(async (req, res) => {
    const id = crypto.randomUUID();

    await pool.query(`
      INSERT INTO bs_manual_transactions(
        id,user_id,name,amount,date,category
      )
      VALUES($1,$2,$3,$4,$5,$6)
    `, [
      id,
      req.userId,
      validText(req.body?.name),
      signedMoney(req.body?.amount),
      validDate(req.body?.date),
      validText(req.body?.category, 80)
    ]);

    res.status(201).json({ id });
  })
);

api.delete(
  "/transactions/manual/:id",
  asyncRoute(async (req, res) => {
    await pool.query(`
      DELETE FROM bs_manual_transactions
      WHERE id=$1 AND user_id=$2
    `, [
      validUUID(req.params.id),
      req.userId
    ]);

    res.json({ ok: true });
  })
);

// ---------------------------------------------
// Budgets
// ---------------------------------------------

api.get(
  "/budgets",
  asyncRoute(async (req, res) => {
    const month = String(req.query.month || "");

    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw httpError(400, "Invalid budget month");
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
  })
);

api.put(
  "/budgets",
  asyncRoute(async (req, res) => {
    const month = String(req.body?.month || "");
    const budgets = req.body?.budgets;

    if (
      !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
      !Array.isArray(budgets) ||
      budgets.length > 100
    ) {
      throw httpError(400, "Invalid budgets");
    }

    const entries = budgets.map(item => ({
      category: validText(item.category, 80),
      amount: validMoney(item.amount)
    }));

    if (
      new Set(entries.map(x => x.category)).size !==
      entries.length
    ) {
      throw httpError(400, "Duplicate categories");
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
          )
          VALUES($1,$2,$3,$4)
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
  })
);

// ---------------------------------------------
// Bills and goals
// ---------------------------------------------

api.get("/bills", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_bills
    WHERE user_id=$1 ORDER BY due_date
  `, [req.userId]);

  res.json({ bills: result.rows });
}));

api.post("/bills", asyncRoute(async (req, res) => {
  const id = crypto.randomUUID();

  await pool.query(`
    INSERT INTO bs_bills(
      id,user_id,name,amount,due_date
    )
    VALUES($1,$2,$3,$4,$5)
  `, [
    id,
    req.userId,
    validText(req.body?.name),
    validMoney(req.body?.amount, false),
    validDate(req.body?.due_date)
  ]);

  res.status(201).json({ id });
}));

api.patch("/bills/:id", asyncRoute(async (req, res) => {
  if (typeof req.body?.paid !== "boolean") {
    throw httpError(400, "Invalid paid status");
  }

  await pool.query(`
    UPDATE bs_bills
    SET paid=$1
    WHERE id=$2 AND user_id=$3
  `, [
    req.body.paid,
    validUUID(req.params.id),
    req.userId
  ]);

  res.json({ ok: true });
}));

api.get("/goals", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_goals
    WHERE user_id=$1 ORDER BY name
  `, [req.userId]);

  res.json({ goals: result.rows });
}));

api.post("/goals", asyncRoute(async (req, res) => {
  const id = crypto.randomUUID();

  await pool.query(`
    INSERT INTO bs_goals(
      id,user_id,name,target,progress,is_debt
    )
    VALUES($1,$2,$3,$4,$5,$6)
  `, [
    id,
    req.userId,
    validText(req.body?.name),
    validMoney(req.body?.target, false),
    validMoney(req.body?.progress ?? 0),
    req.body?.is_debt === true
  ]);

  res.status(201).json({ id });
}));

// ---------------------------------------------
// Preferences and sync health
// ---------------------------------------------

api.get("/preferences", asyncRoute(async (req, res) => {
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

api.put("/preferences", asyncRoute(async (req, res) => {
  await pool.query(`
    INSERT INTO bs_preferences(
      user_id,checking_reserve,
      planned_spending,planned_debt,planned_savings
    )
    VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(user_id)
    DO UPDATE SET
      checking_reserve=EXCLUDED.checking_reserve,
      planned_spending=EXCLUDED.planned_spending,
      planned_debt=EXCLUDED.planned_debt,
      planned_savings=EXCLUDED.planned_savings,
      updated_at=NOW()
  `, [
    req.userId,
    validMoney(req.body?.checking_reserve),
    validMoney(req.body?.planned_spending),
    validMoney(req.body?.planned_debt),
    validMoney(req.body?.planned_savings)
  ]);

  res.json({ ok: true });
}));

api.get("/sync-health", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      item_id,institution_name,
      last_synced_at,sync_error
    FROM bs_items
    WHERE user_id=$1
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

api.post(
  "/plaid/disconnect",
  asyncRoute(async (req, res) => {
    const itemId = validText(req.body?.item_id, 200);

    const result = await pool.query(`
      SELECT *
      FROM bs_items
      WHERE item_id=$1 AND user_id=$2
    `, [itemId, req.userId]);

    const item = result.rows[0];

    if (!item) {
      throw httpError(404, "Bank not found");
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
  })
);

app.use("/api", api);

// ---------------------------------------------
// Plaid webhook verification
// ---------------------------------------------

async function verifyPlaidWebhook(req) {
  const signedJWT = req.get("plaid-verification");

  if (!signedJWT || !Buffer.isBuffer(req.body)) {
    throw httpError(401, "Invalid webhook");
  }

  const header = decodeProtectedHeader(signedJWT);

  if (
    header.alg !== "ES256" ||
    typeof header.kid !== "string"
  ) {
    throw httpError(401, "Invalid signature header");
  }

  const response = await plaidClient.webhookVerificationKeyGet({
    key_id: header.kid
  });

  const jwk = response.data.key;

  if (
    jwk.kid !== header.kid ||
    jwk.alg !== "ES256"
  ) {
    throw httpError(401, "Invalid verification key");
  }

  const key = await importJWK(jwk, "ES256");

  const { payload } = await jwtVerify(
    signedJWT,
    key,
    {
      algorithms: ["ES256"],
      maxTokenAge: "5 min",
      clockTolerance: "30s"
    }
  );

  if (
    typeof payload.request_body_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(payload.request_body_sha256)
  ) {
    throw httpError(401, "Invalid webhook hash");
  }

  const actual = crypto
    .createHash("sha256")
    .update(req.body)
    .digest();

  const expected = Buffer.from(
    payload.request_body_sha256,
    "hex"
  );

  if (!crypto.timingSafeEqual(actual, expected)) {
    throw httpError(401, "Webhook body mismatch");
  }

  return JSON.parse(req.body.toString("utf8"));
}

// ---------------------------------------------
// Complete Hosted Link from Plaid's verified
// SESSION_FINISHED webhook, not browser input.
// ---------------------------------------------

async function completeHostedLink(body) {
  if (!LINKING_ENABLED) return;

  if (
    body.environment !== PLAID_ENV ||
    typeof body.link_token !== "string" ||
    body.link_token.length > 500
  ) {
    throw httpError(400, "Invalid Link completion");
  }

  const publicTokens = body.public_tokens;

  if (
    body.status !== "success" ||
    !Array.isArray(publicTokens) ||
    publicTokens.length !== 1
  ) {
    return;
  }

  const publicToken = publicTokens[0];

  if (
    typeof publicToken !== "string" ||
    publicToken.length > 2048
  ) {
    throw httpError(400, "Invalid public token");
  }

  const linkHash = hashToken(body.link_token);

  const claimed = await pool.query(`
    UPDATE bs_hosted_link_sessions
    SET status='processing'
    WHERE link_token_hash=$1
      AND status='pending'
      AND expires_at>NOW()
    RETURNING id,user_id
  `, [linkHash]);

  if (!claimed.rows.length) {
    // Duplicate, expired, or unknown webhook.
    return;
  }

  const session = claimed.rows[0];

  let accessToken = null;

  try {
    const response = await plaidClient.itemPublicTokenExchange({
      public_token: publicToken
    });

    const itemId = response.data.item_id;
    accessToken = response.data.access_token;

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const result = await client.query(`
        INSERT INTO bs_items(
          item_id,user_id,token_encrypted
        )
        VALUES($1,$2,$3)
        ON CONFLICT(item_id) DO NOTHING
        RETURNING item_id
      `, [
        itemId,
        session.user_id,
        encrypt(accessToken)
      ]);

      if (!result.rows.length) {
        throw new Error("Plaid item already connected");
      }

      await client.query(`
        UPDATE bs_hosted_link_sessions
        SET status='complete',
            item_id=$1,
            completed_at=NOW(),
            error_code=NULL
        WHERE id=$2
      `, [itemId, session.id]);

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    // If exchange succeeded but storage failed, revoke
    // the newly acquired token instead of leaving it loose.
    if (accessToken) {
      await plaidClient.itemRemove({
        access_token: accessToken
      }).catch(() => {});
    }

    await pool.query(`
      UPDATE bs_hosted_link_sessions
      SET status='error',
          error_code='LINK_COMPLETION_FAILED',
          completed_at=NOW()
      WHERE id=$1
    `, [session.id]);

    throw err;
  }
}

// ---------------------------------------------
// Webhook endpoint
// ---------------------------------------------

app.post(
  "/plaid/webhook",
  asyncRoute(async (req, res) => {
    const body = await verifyPlaidWebhook(req);

    if (
      body.webhook_type === "LINK" &&
      body.webhook_code === "SESSION_FINISHED"
    ) {
      await completeHostedLink(body);
    }

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
  })
);

// ---------------------------------------------
// Error handling
// ---------------------------------------------

app.use((_req, res) => {
  res.status(404).json({
    error: "Not found"
  });
});

app.use((err, req, res, _next) => {
  const status = Number.isInteger(err.status)
    ? err.status
    : 500;

  if (status >= 500) {
    console.error("BudgetSaver error", {
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

// ---------------------------------------------
// Startup
// ---------------------------------------------

async function start() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`BudgetSaver Alpha 0.7 running on ${PORT}`);
    console.log(`Plaid environment: ${PLAID_ENV}`);
    console.log(`Hosted Link enabled: ${LINKING_ENABLED}`);
  });
}

start().catch(err => {
  console.error("Backend startup failed:", err.message);
  process.exit(1);
});
