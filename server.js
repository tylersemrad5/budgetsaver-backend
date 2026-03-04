import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

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
    if (!public_token) return res.status(400).json({ error: "Missing public_token" });

    const resp = await plaid.itemPublicTokenExchange({ public_token });
    accessTokens.push(resp.data.access_token);

    res.json({ ok: true, connected_items: accessTokens.length });
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

const port = process.env.PORT || 4242;

app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${port}`);
});