
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import pg from "pg";
import plaid from "plaid";
import crypto from "node:crypto";
import {
  SignJWT,
  jwtVerify,
  createRemoteJWKSet,
  importJWK,
  decodeProtectedHeader
} from "jose";

dotenv.config();

const { Pool } = pg;
const { Configuration, PlaidApi, PlaidEnvironments } = plaid;

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

// ---------------------------------------
// Configuration
// ---------------------------------------

const PORT = Number(process.env.PORT || 3000);

const required = [
  "DATABASE_URL",
  "PLAID_CLIENT_ID",
  "PLAID_SECRET",
  "APPLE_BUNDLE_ID",
  "SESSION_SECRET",
  "TOKEN_ENCRYPTION_KEY"
];

for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Missing required configuration: ${key}`);
  }
}

const SESSION_SECRET = new TextEncoder().encode(
  process.env.SESSION_SECRET
);

if (SESSION_SECRET.length < 32) {
  throw new Error("SESSION_SECRET must be at least 32 bytes");
}

const ENCRYPTION_KEY = Buffer.from(
  process.env.TOKEN_ENCRYPTION_KEY,
  "hex"
);

if (ENCRYPTION_KEY.length !== 32) {
  throw new Error(
    "TOKEN_ENCRYPTION_KEY must be 32 bytes encoded as 64 hex characters"
  );
}

const plaidEnvironment =
  process.env.PLAID_ENV === "production"
    ? PlaidEnvironments.production
    : PlaidEnvironments.sandbox;

const plaidClient = new PlaidApi(
  new Configuration({
    basePath: plaidEnvironment,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
        "PLAID-SECRET": process.env.PLAID_SECRET,
        "Plaid-Version": "2020-09-14"
      }
    }
  })
);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Render private-network connections can use unencrypted
  // transport within its private network. For external DBs,
  // configure verified TLS using a trusted CA.
  ssl: process.env.DATABASE_CA_CERT
    ? {
        rejectUnauthorized: true,
        ca: process.env.DATABASE_CA_CERT.replace(/\\n/g, "\n")
      }
    : false,
  max: 5,
  connectionTimeoutMillis: 10000
});

// ---------------------------------------
// Middleware
// ---------------------------------------

app.use((req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});

const allowedOrigins = (
  process.env.ALLOWED_WEB_ORIGINS || ""
)
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);

app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error("Origin not permitted"));
  }
}));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 100,
  standardHeaders: "draft-7",
  legacyHeaders: false
});

app.use(limiter);

// Plaid needs the exact raw request body for verification.
app.use(
  "/plaid/webhook",
  express.raw({ type: "application/json", limit: "256kb" })
);

app.use(express.json({ limit: "256kb" }));

// ---------------------------------------
// Error handling helpers
// ---------------------------------------

function asyncRoute(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validAmount(value, allowZero = true) {
  const n = Number(value);
  if (
    !Number.isFinite(n) ||
    n < 0 ||
    (!allowZero && n === 0) ||
    n > 1000000000
  ) {
    throw httpError(400, "Invalid amount");
  }
  return Math.round(n * 100) / 100;
}

function validDate(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(`${value}T12:00:00Z`))
  ) {
    throw httpError(400, "Invalid date");
  }
  return value;
}

function validText(value, max = 150) {
  const result = String(value ?? "").trim();
  if (!result || result.length > max) {
    throw httpError(400, "Invalid text field");
  }
  return result;
}

// ---------------------------------------
// Encryption
// ---------------------------------------

function encryptToken(value) {
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv(
    "aes-256-gcm",
    ENCRYPTION_KEY,
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

function decryptToken(value) {
  const parts = String(value).split(":");

  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new Error("Unsupported encrypted token format");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    ENCRYPTION_KEY,
    Buffer.from(parts[1], "hex")
  );

  decipher.setAuthTag(Buffer.from(parts[2], "hex"));

  return Buffer.concat([
    decipher.update(Buffer.from(parts[3], "hex")),
    decipher.final()
  ]).toString("utf8");
}

// ---------------------------------------
// Database initialization
// ---------------------------------------

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bs_users (
      id UUID PRIMARY KEY,
      apple_subject TEXT NOT NULL UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bs_items (
      item_id TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES bs_users(id),
      token_encrypted TEXT NOT NULL,
      institution_name TEXT,
      cursor TEXT,
      last_synced_at TIMESTAMPTZ,
      sync_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS bs_items_user_idx
      ON bs_items(user_id);

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

    CREATE INDEX IF NOT EXISTS bs_accounts_user_idx
      ON bs_accounts(user_id);

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

    CREATE INDEX IF NOT EXISTS bs_transactions_user_date_idx
      ON bs_transactions(user_id, date DESC);

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
  `);

  console.log("BudgetSaver 2.0 database initialized");
}

// ---------------------------------------
// Apple authentication
// ---------------------------------------

const appleKeys = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

async function issueSession(userId) {
  return new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer("budgetsaver-backend")
    .setAudience("budgetsaver-ios")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SESSION_SECRET);
}

async function requireAuth(req, res, next) {
  try {
    const authorization = req.get("authorization") || "";

    if (!authorization.startsWith("Bearer ")) {
      throw httpError(401, "Authentication required");
    }

    const token = authorization.slice(7);

    const verified = await jwtVerify(token, SESSION_SECRET, {
      issuer: "budgetsaver-backend",
      audience: "budgetsaver-ios",
      algorithms: ["HS256"]
    });

    req.userId = verified.payload.sub;

    if (
      typeof req.userId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(req.userId)
    ) {
      throw httpError(401, "Invalid session");
    }

    next();
  } catch {
    next(httpError(401, "Invalid or expired session"));
  }
}

app.post("/auth/apple", asyncRoute(async (req, res) => {
  const identityToken = req.body?.identity_token;

  if (typeof identityToken !== "string") {
    throw httpError(400, "Missing Apple identity token");
  }

  const { payload } = await jwtVerify(identityToken, appleKeys, {
    issuer: "https://appleid.apple.com",
    audience: process.env.APPLE_BUNDLE_ID,
    algorithms: ["RS256"]
  });

  if (typeof payload.sub !== "string") {
    throw httpError(401, "Invalid Apple identity");
  }

  // The native app must use a valid Apple authorization
  // flow. A fresh, challenge-bound authentication design
  // is required before public launch.
  const result = await pool.query(`
    INSERT INTO bs_users (id, apple_subject)
    VALUES ($1, $2)
    ON CONFLICT (apple_subject)
    DO UPDATE SET apple_subject = EXCLUDED.apple_subject
    RETURNING id
  `, [crypto.randomUUID(), payload.sub]);

  const userId = result.rows[0].id;

  res.json({
    token: await issueSession(userId),
    expires_in: 3600
  });
}));

// ---------------------------------------
// Health
// ---------------------------------------

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "BudgetSaver",
    version: "2.0-alpha.2"
  });
});

// Everything below requires authentication,
// except the independently verified webhook.
const api = express.Router();
api.use(requireAuth);

// ---------------------------------------
// Plaid Link
// ---------------------------------------

api.post("/plaid/link-token", asyncRoute(async (req, res) => {
  const response = await plaidClient.linkTokenCreate({
    client_name: "BudgetSaver",
    language: "en",
    country_codes: ["US"],
    user: { client_user_id: req.userId },
    products: ["transactions"],
    ...(process.env.PLAID_WEBHOOK_URL
      ? { webhook: process.env.PLAID_WEBHOOK_URL }
      : {})
  });

  res.json({
    link_token: response.data.link_token,
    expiration: response.data.expiration
  });
}));

api.post("/plaid/exchange", asyncRoute(async (req, res) => {
  const publicToken = req.body?.public_token;

  if (typeof publicToken !== "string") {
    throw httpError(400, "Missing public token");
  }

  const response = await plaidClient.itemPublicTokenExchange({
    public_token: publicToken
  });

  const { item_id, access_token } = response.data;

  const encrypted = encryptToken(access_token);

  await pool.query(`
    INSERT INTO bs_items (
      item_id, user_id, token_encrypted
    )
    VALUES ($1,$2,$3)
    ON CONFLICT (item_id)
    DO NOTHING
  `, [item_id, req.userId, encrypted]);

  const item = await pool.query(`
    SELECT user_id FROM bs_items WHERE item_id=$1
  `, [item_id]);

  if (item.rows[0]?.user_id !== req.userId) {
    throw httpError(403, "Bank item belongs to another user");
  }

  res.json({
    ok: true,
    item_id
  });
}));

// ---------------------------------------
// Account refresh
// ---------------------------------------

async function refreshAccounts(item) {
  const accessToken = decryptToken(item.token_encrypted);

  const response = await plaidClient.accountsGet({
    access_token: accessToken
  });

  for (const account of response.data.accounts) {
    await pool.query(`
      INSERT INTO bs_accounts (
        account_id, item_id, user_id,
        name, type, subtype, mask,
        current_balance, available_balance,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
      ON CONFLICT (account_id)
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
    SELECT
      account_id, item_id, name, type, subtype, mask,
      current_balance, available_balance, updated_at
    FROM bs_accounts
    WHERE user_id=$1
    ORDER BY name
  `, [req.userId]);

  res.json({ accounts: result.rows });
}));

api.post("/accounts/refresh", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_items WHERE user_id=$1
  `, [req.userId]);

  for (const item of result.rows) {
    await refreshAccounts(item);
  }

  res.json({ ok: true });
}));

// ---------------------------------------
// Transaction synchronization
// ---------------------------------------

const syncingItems = new Set();

async function syncItem(item) {
  if (syncingItems.has(item.item_id)) {
    return { skipped: true, reason: "already_syncing" };
  }

  syncingItems.add(item.item_id);

  try {
    const token = decryptToken(item.token_encrypted);
    const originalCursor = item.cursor || null;

    let changes;
    let finalCursor;

    for (let attempt = 0; attempt < 3; attempt++) {
      let cursor = originalCursor;
      let hasMore = true;
      const batch = { added: [], modified: [], removed: [] };

      try {
        while (hasMore) {
          const response = await plaidClient.transactionsSync({
            access_token: token,
            cursor: cursor || undefined,
            count: 500
          });

          const data = response.data;

          batch.added.push(...data.added);
          batch.modified.push(...data.modified);
          batch.removed.push(...data.removed);

          cursor = data.next_cursor;
          hasMore = data.has_more;
        }

        changes = batch;
        finalCursor = cursor;
        break;
      } catch (error) {
        if (
          error?.response?.data?.error_code ===
          "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION" &&
          attempt < 2
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!changes) throw new Error("Sync unsuccessful");

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      for (const tx of [
        ...changes.added,
        ...changes.modified
      ]) {
        await client.query(`
          INSERT INTO bs_transactions (
            transaction_id, account_id, item_id, user_id,
            name, merchant, amount, date, category, pending
          )
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(transaction_id)
          DO UPDATE SET
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
          item.item_id,
          item.user_id,
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
        `, [tx.transaction_id, item.user_id]);
      }

      await client.query(`
        UPDATE bs_items
        SET cursor=$1,
            last_synced_at=NOW(),
            sync_error=NULL
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
      added: changes.added.length,
      modified: changes.modified.length,
      removed: changes.removed.length
    };
  } catch (error) {
    await pool.query(`
      UPDATE bs_items
      SET sync_error=$1
      WHERE item_id=$2 AND user_id=$3
    `, [
      String(error?.response?.data?.error_code ||
        "SYNC_FAILED").slice(0, 100),
      item.item_id,
      item.user_id
    ]);

    throw error;
  } finally {
    syncingItems.delete(item.item_id);
  }
}

api.post("/transactions/sync", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_items WHERE user_id=$1
  `, [req.userId]);

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

api.get("/transactions", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      transaction_id AS id,
      name, merchant, amount, date, category, pending,
      account_id, 'plaid' AS source
    FROM bs_transactions
    WHERE user_id=$1
    ORDER BY date DESC
    LIMIT 500
  `, [req.userId]);

  const manual = await pool.query(`
    SELECT
      id, name, NULL AS merchant, amount, date,
      category, FALSE AS pending,
      NULL AS account_id, 'manual' AS source
    FROM bs_manual_transactions
    WHERE user_id=$1
    ORDER BY date DESC
    LIMIT 500
  `, [req.userId]);

  res.json({
    transactions: [...result.rows, ...manual.rows]
      .sort((a, b) =>
        String(b.date).localeCompare(String(a.date))
      )
  });
}));

api.post("/transactions/manual", asyncRoute(async (req, res) => {
  const id = crypto.randomUUID();
  const name = validText(req.body.name);
  const amount = Number(req.body.amount);
  const date = validDate(req.body.date);
  const category = validText(req.body.category, 80);

  if (!Number.isFinite(amount) || Math.abs(amount) > 1000000000) {
    throw httpError(400, "Invalid amount");
  }

  await pool.query(`
    INSERT INTO bs_manual_transactions
    (id,user_id,name,amount,date,category)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [id, req.userId, name, amount, date, category]);

  res.status(201).json({ id });
}));

api.delete("/transactions/manual/:id", asyncRoute(async (req, res) => {
  await pool.query(`
    DELETE FROM bs_manual_transactions
    WHERE id=$1 AND user_id=$2
  `, [req.params.id, req.userId]);

  res.json({ ok: true });
}));

// ---------------------------------------
// Budgets
// ---------------------------------------

api.get("/budgets", asyncRoute(async (req, res) => {
  const month = String(req.query.month || "");

  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw httpError(400, "Invalid budget month");
  }

  const result = await pool.query(`
    SELECT category, amount
    FROM bs_budgets
    WHERE user_id=$1 AND month_key=$2
    ORDER BY category
  `, [req.userId, month]);

  res.json({ month, budgets: result.rows });
}));

api.put("/budgets", asyncRoute(async (req, res) => {
  const month = String(req.body.month || "");
  const budgets = req.body.budgets;

  if (
    !/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
    !Array.isArray(budgets) ||
    budgets.length > 100
  ) {
    throw httpError(400, "Invalid budgets");
  }

  const entries = budgets.map(item => ({
    category: validText(item.category, 80),
    amount: validAmount(item.amount)
  }));

  if (new Set(entries.map(x => x.category)).size !== entries.length) {
    throw httpError(400, "Duplicate budget category");
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
        INSERT INTO bs_budgets
        (user_id,month_key,category,amount)
        VALUES ($1,$2,$3,$4)
      `, [req.userId, month, entry.category, entry.amount]);
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

// ---------------------------------------
// Bills and goals
// ---------------------------------------

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
    INSERT INTO bs_bills
      (id,user_id,name,amount,due_date)
    VALUES ($1,$2,$3,$4,$5)
  `, [
    id,
    req.userId,
    validText(req.body.name),
    validAmount(req.body.amount, false),
    validDate(req.body.due_date)
  ]);

  res.status(201).json({ id });
}));

api.patch("/bills/:id", asyncRoute(async (req, res) => {
  if (typeof req.body.paid !== "boolean") {
    throw httpError(400, "Invalid paid status");
  }

  await pool.query(`
    UPDATE bs_bills SET paid=$1
    WHERE id=$2 AND user_id=$3
  `, [req.body.paid, req.params.id, req.userId]);

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
    INSERT INTO bs_goals
    (id,user_id,name,target,progress,is_debt)
    VALUES ($1,$2,$3,$4,$5,$6)
  `, [
    id,
    req.userId,
    validText(req.body.name),
    validAmount(req.body.target, false),
    validAmount(req.body.progress ?? 0),
    req.body.is_debt === true
  ]);

  res.status(201).json({ id });
}));

// ---------------------------------------
// User preferences and planning
// ---------------------------------------

api.get("/preferences", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT * FROM bs_preferences WHERE user_id=$1
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
  const reserve = validAmount(req.body.checking_reserve);
  const spending = validAmount(req.body.planned_spending);
  const debt = validAmount(req.body.planned_debt);
  const savings = validAmount(req.body.planned_savings);

  await pool.query(`
    INSERT INTO bs_preferences (
      user_id, checking_reserve,
      planned_spending, planned_debt, planned_savings
    )
    VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT(user_id)
    DO UPDATE SET
      checking_reserve=EXCLUDED.checking_reserve,
      planned_spending=EXCLUDED.planned_spending,
      planned_debt=EXCLUDED.planned_debt,
      planned_savings=EXCLUDED.planned_savings,
      updated_at=NOW()
  `, [req.userId, reserve, spending, debt, savings]);

  res.json({ ok: true });
}));

// ---------------------------------------
// Sync health
// ---------------------------------------

api.get("/sync-health", asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      item_id, institution_name, last_synced_at,
      sync_error
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

// ---------------------------------------
// Disconnect bank
// ---------------------------------------

api.post("/plaid/disconnect", asyncRoute(async (req, res) => {
  const itemId = validText(req.body.item_id, 200);

  const result = await pool.query(`
    SELECT * FROM bs_items
    WHERE item_id=$1 AND user_id=$2
  `, [itemId, req.userId]);

  const item = result.rows[0];

  if (!item) {
    throw httpError(404, "Bank connection not found");
  }

  await plaidClient.itemRemove({
    access_token: decryptToken(item.token_encrypted)
  });

  await pool.query(`
    DELETE FROM bs_items
    WHERE item_id=$1 AND user_id=$2
  `, [itemId, req.userId]);

  res.json({ ok: true });
}));

app.use("/api", api);

// ---------------------------------------
// Verified Plaid webhooks
// ---------------------------------------

app.post("/plaid/webhook", asyncRoute(async (req, res) => {
  const signedJWT = req.get("plaid-verification");

  if (!signedJWT || !Buffer.isBuffer(req.body)) {
    throw httpError(401, "Invalid webhook");
  }

  const header = decodeProtectedHeader(signedJWT);

  if (
    header.alg !== "ES256" ||
    typeof header.kid !== "string"
  ) {
    throw httpError(401, "Invalid webhook signature");
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

  const { payload } = await jwtVerify(signedJWT, key, {
    algorithms: ["ES256"],
    maxTokenAge: "5 min",
    clockTolerance: "30s"
  });

  const actualHash = crypto
    .createHash("sha256")
    .update(req.body)
    .digest();

  if (
    typeof payload.request_body_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/i.test(payload.request_body_sha256)
  ) {
    throw httpError(401, "Invalid body hash");
  }

  const expectedHash = Buffer.from(
    payload.request_body_sha256,
    "hex"
  );

  if (!crypto.timingSafeEqual(actualHash, expectedHash)) {
    throw httpError(401, "Webhook body mismatch");
  }

  const body = JSON.parse(req.body.toString("utf8"));

  if (
    body.webhook_type === "TRANSACTIONS" &&
    body.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
    typeof body.item_id === "string"
  ) {
    const result = await pool.query(`
      SELECT * FROM bs_items WHERE item_id=$1
    `, [body.item_id]);

    if (result.rows[0]) {
      await syncItem(result.rows[0]);
    }
  }

  res.json({ received: true });
}));

// ---------------------------------------
// Unknown routes and error handler
// ---------------------------------------

app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.use((err, req, res, _next) => {
  const status = Number.isInteger(err.status)
    ? err.status
    : 500;

  if (status >= 500) {
    console.error("Server operation failed", {
      path: req.path,
      type: err.name
    });
  }

  res.status(status).json({
    error:
      status >= 500
        ? "Internal server error"
        : err.message
  });
});

// ---------------------------------------
// Startup
// ---------------------------------------

async function start() {
  await initializeDatabase();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(
      `BudgetSaver 2.0 Alpha backend running on port ${PORT}`
    );
  });
}

start().catch(error => {
  console.error("Backend startup failed:", error.message);
  process.exit(1);
});
