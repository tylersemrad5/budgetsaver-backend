import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const userTokens = new Map();

function getUserId(req) {
  return req.header("X-USER-ID") || "tyler_local_user";
}

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

  if (name.includes("spotify") || name.includes("netflix") || name.includes("hulu") || name.includes("apple"))
    return "Subscriptions";
  if (name.includes("shell") || name.includes("bp") || name.includes("exxon") || name.includes("chevron"))
    return "Gas";
  if (name.includes("walmart") || name.includes("target") || name.includes("costco") || name.includes("kroger"))
    return "Groceries";
  if (name.includes("mcdonald") || name.includes("chipotle") || name.includes("starbucks") || name.includes("taco"))
    return "Dining";

  return "Other";
}

function monthKey(dateStr) {
  return (dateStr || "").slice(0,7);

const env = process.env.PLAID_ENV || "sandbox";

const config = new Configuration({
  basePath: PlaidEnvironments[env],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaid = new PlaidApi(config);

// temp storage (fine for local testing)
const accessTokens = [];

app.get("/", (req, res) => {
  res.send("Budget backend is running");
});

app.get("/link_token", async (req, res) => {
  try {
    const resp = await plaid.linkTokenCreate({
      user: { client_user_id: "tyler_local_user" },
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

app.post("/create_link_token", async (req, res) => {
  try {
    const resp = await plaid.linkTokenCreate({
      user: { client_user_id: "tyler_local_user" },
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

app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body;
    const resp = await plaid.itemPublicTokenExchange({ public_token });

    const access_token = resp.data.access_token;
    const item_id = resp.data.item_id;

    const userId = req.header("X-USER-ID") || "tyler_local_user";
    userTokens.set(userId, { access_token, item_id });

    accessTokens.push(access_token);

    res.json({ ok: true, item_id });
    
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to exchange public token" });
  }
});

app.get("/transactions", async (req, res) => {
  try {
    const start_date = req.query.start_date || "2026-01-01";
    const end_date = req.query.end_date || "2026-03-03";

    const all = [];

    for (const access_token of accessTokens) {
      const resp = await plaid.transactionsGet({
        access_token,
        start_date,
        end_date,
        options: { count: 250, offset: 0 },
      });
      all.push(...resp.data.transactions);
    }

    all.sort((a, b) => (a.date < b.date ? 1 : -1));
    res.json({ transactions: all });
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch transactions" });
  }
});

app.get("/insights", async (req, res) => {
  try {

    const userId = req.header("X-USER-ID") || "tyler_local_user";
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);

    const start_date = start.toISOString().slice(0,10);
    const end_date = now.toISOString().slice(0,10);

    const resp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date,
      end_date,
    });

    const transactions = resp.data.transactions;

    let spent = 0;

    for (const tx of transactions) {
      if (tx.amount > 0) {
        spent += tx.amount;
      }
    }

    res.json({
      month: end_date.slice(0,7),
      total_transactions: transactions.length,
      spent: spent.toFixed(2),
      transactions
    });

  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.status(500).json({ error: "Failed to generate insights" });
  }
});

const port = process.env.PORT || 4242;

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${port}`);
});
