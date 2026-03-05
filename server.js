import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

function getCategory(tx) {
  // Newer Plaid field:
  const pfc = tx.personal_finance_category;
  if (pfc?.primary) return pfc.primary; // e.g. "FOOD_AND_DRINK"

  // Older Plaid field:
  if (Array.isArray(tx.category) && tx.category.length > 0) return tx.category[0]; // e.g. "Food and Drink"

  return "Other";
}

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

// --------------------
// Simple "user" identity
// --------------------
function getUserId(req) {
  return req.header("X-USER-ID") || "tyler_local_user";
}

// In-memory storage (fine for sandbox/testing; resets on deploy)
const userTokens = new Map(); // userId -> { access_token, item_id }

// --------------------
// Budget + categorization helpers
// --------------------
const MONTHLY_BUDGETS = {
  Groceries: 300,
  Dining: 150,
  Gas: 120,
  Shopping: 100,
  Subscriptions: 50,
  Transfers: 0,
  Other: 200,
};

function categorize(tx) {
  const name = (tx.merchant_name || tx.name || "").toLowerCase();

  if (name.includes("spotify") || name.includes("netflix") || name.includes("hulu") || name.includes("apple")) {
    return "Subscriptions";
  }
  if (name.includes("shell") || name.includes("bp") || name.includes("exxon") || name.includes("chevron")) {
    return "Gas";
  }
  if (name.includes("walmart") || name.includes("target") || name.includes("costco") || name.includes("kroger")) {
    return "Groceries";
  }
  if (name.includes("mcdonald") || name.includes("chipotle") || name.includes("starbuck") || name.includes("taco")) {
    return "Dining";
  }
  if (name.includes("venmo") || name.includes("paypal") || name.includes("cash app") || name.includes("zelle")) {
    return "Transfers";
  }

  return "Other";
}

function ymd(d) {
  // YYYY-MM-DD in local time (safe enough for this use)
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// --------------------
// Plaid client
// --------------------
const env = process.env.PLAID_ENV || "sandbox";
const plaidEnv = PlaidEnvironments[env] || PlaidEnvironments.sandbox;

const config = new Configuration({
  basePath: plaidEnv,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaid = new PlaidApi(config);

// --------------------
// Routes
// --------------------
app.get("/", (req, res) => {
  res.send("Budget backend is running ✅");
});

// Create link token (GET)
app.get("/link_token", async (req, res) => {
  try {
    const userId = getUserId(req);

    const resp = await plaid.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Budget Saver",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: resp.data.link_token });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// Create link token (POST) - compatibility if your frontend expects this
app.post("/create_link_token", async (req, res) => {
  try {
    const userId = getUserId(req);

    const resp = await plaid.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "Budget Saver",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: resp.data.link_token });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to create link token" });
  }
});

// Exchange public token -> access token
app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body || {};
    if (!public_token) {
      return res.status(400).json({ error: "Missing public_token" });
    }

    const resp = await plaid.itemPublicTokenExchange({ public_token });

    const access_token = resp.data.access_token;
    const item_id = resp.data.item_id;

    const userId = getUserId(req);
    userTokens.set(userId, { access_token, item_id });

    res.json({ ok: true, item_id });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange public token" });
  }
});

// Get transactions for date range
app.get("/transactions", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const start_date = req.query.start_date || "2026-01-01";
    const end_date = req.query.end_date || ymd(new Date());

    // Pull up to ~500 transactions with pagination
    const all = [];
    let offset = 0;
    const count = 250;

    while (true) {
      const resp = await plaid.transactionsGet({
        access_token: saved.access_token,
        start_date,
        end_date,
        options: { count, offset },
      });

      const txs = resp.data.transactions || [];
      all.push(...txs);

      if (txs.length < count) break;
      offset += count;
      if (offset >= 1000) break; // safety cap
    }

    // newest first
    all.sort((a, b) => (a.date < b.date ? 1 : -1));

    res.json({ transactions: all });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.get("/transactions_by_month", async (req, res) => {
  try {
    const start_date = req.query.start_date || "2026-01-01";
    const end_date = req.query.end_date || new Date().toISOString().slice(0, 10);

    const userId = req.header("X-USER-ID") || "tyler_local_user";
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected. Connect bank first." });
    }

    const resp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date,
      end_date,
      options: { count: 500, offset: 0 },
    });

    const all = resp.data.transactions || [];

    const spentTx = all
      .filter((t) => typeof t.amount === "number" && t.amount > 0)
      .sort((a, b) => (a.date < b.date ? 1 : -1));

    const grouped = {};
    for (const tx of spentTx) {
      const month = (tx.date || "").slice(0, 7);
      if (!month) continue;

      if (!grouped[month]) grouped[month] = [];
      grouped[month].push({
        id: tx.transaction_id,
        name: tx.merchant_name || tx.name || "Unknown",
        date: tx.date,
        amount: tx.amount,
        category: tx.personal_finance_category?.primary || "OTHER",
      });
    }

    const months = Object.keys(grouped).sort((a, b) => (a < b ? 1 : -1));

    res.json({
      range: { start_date, end_date },
      months: months.map((m) => ({
        month: m,
        totalSpent: Number(
          grouped[m].reduce((sum, t) => sum + (t.amount || 0), 0).toFixed(2)
        ),
        count: grouped[m].length,
        transactions: grouped[m],
      })),
    });
  } catch (err) {
    console.error("transactions_by_month error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to fetch transactions by month",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

// Insights: current month totals + spending by category vs budgets
app.get("/insights", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);

    const start_date = (req.query.start_date ?? start.toISOString().slice(0, 10));
    const end_date = (req.query.end_date     ?? end.toISOString().slice(0, 10));

    // Fetch this month
    const resp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date,
      end_date,
      options: { count: 500, offset: 0 },
    });

    const transactions = resp.data.transactions || [];

    // Compute spend (positive amounts only)
    let spentTotal = 0;
const spentByCategory = {};

for (const tx of transactions) {

  if (typeof tx.amount !== "number") continue;
  if (tx.amount <= 0) continue;

  spentTotal += tx.amount;

  let category = "Other";

  if (tx.personal_finance_category?.primary) {
    category = tx.personal_finance_category.primary;
  } else if (Array.isArray(tx.category) && tx.category.length > 0) {
    category = tx.category[0];
  }

  if (!spentByCategory[category]) {
    spentByCategory[category] = 0;
  }

  spentByCategory[category] += tx.amount;
}

    const budgetByCategory = { ...MONTHLY_BUDGETS };
    const remainingByCategory = {};
    for (const cat of Object.keys(budgetByCategory)) {
      remainingByCategory[cat] = Number((budgetByCategory[cat] - (spentByCategory[cat] || 0)).toFixed(2));
    }

    res.json({
      month: start_date.slice(0, 7),
      range: { start_date, end_date },
      totals: {
        total_transactions: transactions.length,
        spent: Number(spentTotal.toFixed(2)),
      },
      budgets: {
        budgetByCategory,
        spentByCategory: Object.fromEntries(
          Object.entries(spentByCategory).map(([k, v]) => [k, Number(v.toFixed(2))])
        ),
        remainingByCategory,
      },
      // optional: return categorized txs for debugging/UI
      transactions: transactions
        .map((t) => ({ ...t, category_guess: categorize(t) }))
        .sort((a, b) => (a.date < b.date ? 1 : -1)),
    });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to generate insights" });
  }
});

// --------------------
// Start server (Render-friendly)
// --------------------
const port = process.env.PORT || 4242;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${port}`);
});
