import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

function formatCategoryName(category) {
  return (category || "Other")
    .toLowerCase()
    .split("_")
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function getCategory(tx) {
  if (tx.personal_finance_category?.primary) {
    return tx.personal_finance_category.primary;
  }

  if (Array.isArray(tx.category) && tx.category.length > 0) {
    return tx.category[0];
  }

  return "OTHER";
}

function sumByCategory(transactions) {
  const totals = {};

  for (const tx of transactions) {
    const category = getCategory(tx);
    totals[category] = (totals[category] || 0) + tx.amount;
  }

  return totals;
}

function sumByMerchant(transactions) {
  const totals = {};

  for (const tx of transactions) {
    const merchant = (tx.merchant_name || tx.name || "Unknown").trim();
    totals[merchant] = (totals[merchant] || 0) + tx.amount;
  }

  return totals;
}

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

app.get("/ai_advice", async (req, res) => {
  try {
    const userId = req.header("X-USER-ID") || "tyler_local_user";
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const now = new Date();

    const currentEnd = now.toISOString().slice(0, 10);

    const currentStartDate = new Date(now);
    currentStartDate.setDate(currentStartDate.getDate() - 30);
    const currentStart = currentStartDate.toISOString().slice(0, 10);

    const previousEndDate = new Date(currentStartDate);
    previousEndDate.setDate(previousEndDate.getDate() - 1);
    const previousEnd = previousEndDate.toISOString().slice(0, 10);

    const previousStartDate = new Date(previousEndDate);
    previousStartDate.setDate(previousStartDate.getDate() - 30);
    const previousStart = previousStartDate.toISOString().slice(0, 10);

    const currentResp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date: currentStart,
      end_date: currentEnd,
      options: { count: 500, offset: 0 },
    });

    const previousResp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date: previousStart,
      end_date: previousEnd,
      options: { count: 500, offset: 0 },
    });

    const currentTransactions = (currentResp.data.transactions || []).filter(
      (t) => typeof t.amount === "number" && t.amount > 0
    );

    const previousTransactions = (previousResp.data.transactions || []).filter(
      (t) => typeof t.amount === "number" && t.amount > 0
    );

    const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
    const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

    const categoryTotals = {};
    const merchantTotals = {};

    for (const tx of currentTransactions) {
      const category =
        tx.personal_finance_category?.primary ||
        (Array.isArray(tx.category) && tx.category.length > 0 ? tx.category[0] : "OTHER");

      const merchant = tx.merchant_name || tx.name || "Unknown";

      categoryTotals[category] = (categoryTotals[category] || 0) + tx.amount;
      merchantTotals[merchant] = (merchantTotals[merchant] || 0) + tx.amount;
    }

    const topCategoryEntry =
      Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0] || ["OTHER", 0];

    const topMerchantEntry =
      Object.entries(merchantTotals).sort((a, b) => b[1] - a[1])[0] || ["Unknown", 0];

    const topCategory = topCategoryEntry[0];
    const topCategoryAmount = Number(topCategoryEntry[1].toFixed(2));

    const topMerchant = topMerchantEntry[0];
    const topMerchantAmount = Number(topMerchantEntry[1].toFixed(2));

    let trendText = "about the same as";
    if (currentSpent > previousSpent + 5) trendText = "higher than";
    if (currentSpent < previousSpent - 5) trendText = "lower than";

    const summary = `In the last 30 days, you spent $${currentSpent.toFixed(2)}. Your biggest spending category was ${topCategory} at $${topCategoryAmount.toFixed(2)}. Your spending was ${trendText} the previous 30-day period.`;

    const tips = [];

    if (topCategoryAmount > currentSpent * 0.4) {
      tips.push(`Most of your spending came from ${topCategory}. Setting a category limit here could help the most.`);
    }

    if (topMerchant !== "Unknown") {
      tips.push(`Your top merchant was ${topMerchant} at $${topMerchantAmount.toFixed(2)}.`);
    }

    if (currentSpent > previousSpent + 5) {
      tips.push(`You spent $${(currentSpent - previousSpent).toFixed(2)} more than the previous 30 days.`);
    } else if (currentSpent < previousSpent - 5) {
      tips.push(`You spent $${(previousSpent - currentSpent).toFixed(2)} less than the previous 30 days.`);
    } else {
      tips.push(`Your spending is staying pretty consistent month to month.`);
    }

    if (tips.length === 0) {
      tips.push("Your spending pattern looks steady right now.");
    }

    res.json({
      summary,
      tips,
      currentSpent: Number(currentSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      topCategory,
      topCategoryAmount,
      topMerchant,
      topMerchantAmount,
    });
  } catch (err) {
    console.error("ai_advice error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to generate AI advice",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.post("/ask_budget", async (req, res) => {
  try {
    const userId = req.header("X-USER-ID") || "tyler_local_user";
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const question = (req.body?.question || "").toLowerCase().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing question" });
    }

    const now = new Date();
    const currentEnd = now.toISOString().slice(0, 10);

    const currentStartDate = new Date(now);
    currentStartDate.setDate(currentStartDate.getDate() - 30);
    const currentStart = currentStartDate.toISOString().slice(0, 10);

    const previousEndDate = new Date(currentStartDate);
    previousEndDate.setDate(previousEndDate.getDate() - 1);
    const previousEnd = previousEndDate.toISOString().slice(0, 10);

    const previousStartDate = new Date(previousEndDate);
    previousStartDate.setDate(previousStartDate.getDate() - 30);
    const previousStart = previousStartDate.toISOString().slice(0, 10);

    const currentResp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date: currentStart,
      end_date: currentEnd,
      options: { count: 500, offset: 0 },
    });

    const previousResp = await plaid.transactionsGet({
      access_token: saved.access_token,
      start_date: previousStart,
      end_date: previousEnd,
      options: { count: 500, offset: 0 },
    });

    const currentTransactions = (currentResp.data.transactions || []).filter(
      (t) => typeof t.amount === "number" && t.amount > 0
    );

    const previousTransactions = (previousResp.data.transactions || []).filter(
      (t) => typeof t.amount === "number" && t.amount > 0
    );

    const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
    const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

    const currentCategoryTotals = sumByCategory(currentTransactions);
    const previousCategoryTotals = sumByCategory(previousTransactions);
    const merchantTotals = sumByMerchant(currentTransactions);

    const topCategoryEntry =
      Object.entries(currentCategoryTotals).sort((a, b) => b[1] - a[1])[0] || ["OTHER", 0];

    const topMerchantEntry =
      Object.entries(merchantTotals).sort((a, b) => b[1] - a[1])[0] || ["Unknown", 0];

    const biggestTransaction = currentTransactions
      .slice()
      .sort((a, b) => b.amount - a.amount)[0];

    const recurringMerchantCounts = {};
    for (const tx of currentTransactions) {
      const merchant = (tx.merchant_name || tx.name || "Unknown").trim();
      recurringMerchantCounts[merchant] = (recurringMerchantCounts[merchant] || 0) + 1;
    }

    const recurringMerchants = Object.entries(recurringMerchantCounts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1]);

    let mostIncreasedCategory = null;
    let biggestIncreaseAmount = 0;

    const allCategories = new Set([
      ...Object.keys(currentCategoryTotals),
      ...Object.keys(previousCategoryTotals),
    ]);

    for (const category of allCategories) {
      const currentAmt = currentCategoryTotals[category] || 0;
      const previousAmt = previousCategoryTotals[category] || 0;
      const diff = currentAmt - previousAmt;

      if (diff > biggestIncreaseAmount) {
        biggestIncreaseAmount = diff;
        mostIncreasedCategory = category;
      }
    }

    let answer = "I couldn't understand that question yet. Try asking about your top category, biggest purchase, recurring charges, Uber spending, or whether you spent more than last month.";

    if (
      question.includes("most") &&
      (question.includes("spend") || question.includes("spent") || question.includes("category"))
    ) {
      answer = `You spent the most on ${formatCategoryName(topCategoryEntry[0])}, totaling $${topCategoryEntry[1].toFixed(2)} in the last 30 days.`;
    } else if (
      question.includes("biggest purchase") ||
      question.includes("largest purchase") ||
      question.includes("largest transaction") ||
      question.includes("biggest transaction")
    ) {
      if (biggestTransaction) {
        const merchant = biggestTransaction.merchant_name || biggestTransaction.name || "Unknown";
        answer = `Your biggest purchase in the last 30 days was ${merchant} for $${biggestTransaction.amount.toFixed(2)} on ${biggestTransaction.date}.`;
      } else {
        answer = "I couldn't find a biggest purchase in the last 30 days.";
      }
    } else if (
      question.includes("cut back") ||
      question.includes("save money") ||
      question.includes("where should i cut") ||
      question.includes("what should i cut")
    ) {
      answer = `Your highest spending category is ${formatCategoryName(topCategoryEntry[0])} at $${topCategoryEntry[1].toFixed(2)}. Cutting back there would likely have the biggest impact on your total spending.`;
    } else if (
      question.includes("top merchant") ||
      question.includes("where did i spend the most") ||
      (question.includes("spent") && question.includes("where"))
    ) {
      answer = `Your top merchant in the last 30 days was ${topMerchantEntry[0]} at $${topMerchantEntry[1].toFixed(2)}.`;
    } else if (
      question.includes("uber") ||
      question.includes("lyft") ||
      question.includes("rideshare")
    ) {
      const rideshareTotal = currentTransactions
        .filter((tx) => {
          const merchant = (tx.merchant_name || tx.name || "").toLowerCase();
          return merchant.includes("uber") || merchant.includes("lyft");
        })
        .reduce((sum, tx) => sum + tx.amount, 0);

      answer = `You spent $${rideshareTotal.toFixed(2)} on rideshare-related transactions in the last 30 days.`;
    } else if (
      question.includes("food") ||
      question.includes("drink") ||
      question.includes("dining") ||
      question.includes("restaurant") ||
      question.includes("eat out")
    ) {
      const foodTotal = Object.entries(currentCategoryTotals)
        .filter(([category]) => {
          const cat = category.toUpperCase();
          return cat.includes("FOOD") || cat.includes("DRINK") || cat.includes("DINING");
        })
        .reduce((sum, [, amount]) => sum + amount, 0);

      answer = `You spent $${foodTotal.toFixed(2)} on food and drink in the last 30 days.`;
    } else if (
      question.includes("transport") ||
      question.includes("transportation")
    ) {
      const transportationTotal = Object.entries(currentCategoryTotals)
        .filter(([category]) => category.toUpperCase().includes("TRANSPORT"))
        .reduce((sum, [, amount]) => sum + amount, 0);

      answer = `You spent $${transportationTotal.toFixed(2)} on transportation in the last 30 days.`;
    } else if (
      question.includes("more than last month") ||
      question.includes("more this month") ||
      question.includes("compare") ||
      question.includes("last month")
    ) {
      if (currentSpent > previousSpent) {
        answer = `Yes. You spent $${(currentSpent - previousSpent).toFixed(2)} more in the last 30 days than in the previous 30-day period.`;
      } else if (currentSpent < previousSpent) {
        answer = `No. You spent $${(previousSpent - currentSpent).toFixed(2)} less in the last 30 days than in the previous 30-day period.`;
      } else {
        answer = `Your spending was almost exactly the same across the last two 30-day periods.`;
      }
    } else if (
      question.includes("subscription") ||
      question.includes("recurring") ||
      question.includes("repeat charge")
    ) {
      if (recurringMerchants.length > 0) {
        const topRecurring = recurringMerchants[0];
        answer = `A likely recurring charge is ${topRecurring[0]}, which appeared ${topRecurring[1]} times in the last 30 days.`;
      } else {
        answer = "I didn’t detect any strong recurring merchant patterns in the last 30 days.";
      }
    } else if (
      question.includes("increased the most") ||
      question.includes("went up the most") ||
      question.includes("which category increased")
    ) {
      if (mostIncreasedCategory && biggestIncreaseAmount > 0) {
        answer = `${formatCategoryName(mostIncreasedCategory)} increased the most, up $${biggestIncreaseAmount.toFixed(2)} compared with the previous 30-day period.`;
      } else {
        answer = "I didn’t find a category that clearly increased compared with the previous 30-day period.";
      }
    } else if (
      question.includes("total") ||
      question.includes("how much did i spend")
    ) {
      answer = `You spent a total of $${currentSpent.toFixed(2)} in the last 30 days.`;
    }

    res.json({
      question,
      answer,
      currentSpent: Number(currentSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      topCategory: formatCategoryName(topCategoryEntry[0]),
      topCategoryAmount: Number(topCategoryEntry[1].toFixed(2)),
      topMerchant: topMerchantEntry[0],
      topMerchantAmount: Number(topMerchantEntry[1].toFixed(2)),
    });
  } catch (err) {
    console.error("ask_budget error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to answer budget question",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

// --------------------
// Start server (Render-friendly)
// --------------------
const port = process.env.PORT || 4242;
app.listen(port, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${port}`);
});
