import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { Configuration, PlaidApi, PlaidEnvironments } from "plaid";

dotenv.config();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

const PORT = process.env.PORT || 4242;
const PLAID_ENV = process.env.PLAID_ENV || "sandbox";

const config = new Configuration({
  basePath: PlaidEnvironments[PLAID_ENV],
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID,
      "PLAID-SECRET": process.env.PLAID_SECRET,
    },
  },
});

const plaid = new PlaidApi(config);

// In-memory user token store
const userTokens = new Map();

// ---------- Helpers ----------

function getUserId(req) {
  return req.header("X-USER-ID") || "tyler_local_user";
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

function formatCategoryName(category) {
  return (category || "Other")
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
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

function buildBudgetObjects(spentByCategory) {
  const budgetByCategory = {};
  const remainingByCategory = {};

  for (const [category, spent] of Object.entries(spentByCategory)) {
    // Simple starter budget rule: set budget to current spend
    const budget = Number(spent.toFixed(2));
    budgetByCategory[category] = budget;
    remainingByCategory[category] = Number((budget - spent).toFixed(2));
  }

  return {
    budgetByCategory,
    remainingByCategory,
  };
}

function getDateRangeLast30Days() {
  const now = new Date();
  const end = now.toISOString().slice(0, 10);

  const startDate = new Date(now);
  startDate.setDate(startDate.getDate() - 30);
  const start = startDate.toISOString().slice(0, 10);

  return { start, end };
}

function getPrevious30DayRange() {
  const now = new Date();

  const currentStartDate = new Date(now);
  currentStartDate.setDate(currentStartDate.getDate() - 30);

  const previousEndDate = new Date(currentStartDate);
  previousEndDate.setDate(previousEndDate.getDate() - 1);

  const previousStartDate = new Date(previousEndDate);
  previousStartDate.setDate(previousStartDate.getDate() - 30);

  return {
    start: previousStartDate.toISOString().slice(0, 10),
    end: previousEndDate.toISOString().slice(0, 10),
  };
}

async function getTransactions(access_token, start_date, end_date) {
  const resp = await plaid.transactionsGet({
    access_token,
    start_date,
    end_date,
    options: { count: 500, offset: 0 },
  });

  return resp.data.transactions || [];
}

// ---------- Routes ----------

app.get("/", (req, res) => {
  res.send("BudgetSaver backend is running");
});

app.post("/create_link_token", async (req, res) => {
  try {
    const userId = getUserId(req);

    const response = await plaid.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: "BudgetSaver",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({ link_token: response.data.link_token });
  } catch (err) {
    console.error("create_link_token error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to create link token",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.post("/exchange_public_token", async (req, res) => {
  try {
    const userId = getUserId(req);
    const { public_token } = req.body;

    if (!public_token) {
      return res.status(400).json({ error: "Missing public_token" });
    }

    const response = await plaid.itemPublicTokenExchange({ public_token });

    const access_token = response.data.access_token;
    const item_id = response.data.item_id;

    userTokens.set(userId, { access_token, item_id });

    res.json({ ok: true, item_id });
  } catch (err) {
    console.error("exchange_public_token error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to exchange public token",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.get("/transactions", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected. Connect bank first." });
    }

    const start_date = req.query.start_date || "2026-01-01";
    const end_date = req.query.end_date || new Date().toISOString().slice(0, 10);

    const all = await getTransactions(saved.access_token, start_date, end_date);

    const cleaned = all
      .filter((tx) => typeof tx.amount === "number" && tx.amount > 0)
      .sort((a, b) => (a.date < b.date ? 1 : -1))
      .map((tx) => ({
        id: tx.transaction_id,
        name: tx.merchant_name || tx.name || "Unknown",
        date: tx.date,
        amount: tx.amount,
        category: getCategory(tx),
      }));

    res.json({ transactions: cleaned });
  } catch (err) {
    console.error("transactions error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to fetch transactions",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.get("/transactions_by_month", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected. Connect bank first." });
    }

    const start_date = req.query.start_date || "2026-01-01";
    const end_date = req.query.end_date || new Date().toISOString().slice(0, 10);

    const all = await getTransactions(saved.access_token, start_date, end_date);

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
        category: getCategory(tx),
      });
    }

    const months = Object.keys(grouped).sort((a, b) => (a < b ? 1 : -1));

    res.json({
      range: { start_date, end_date },
      months: months.map((month) => ({
        month,
        totalSpent: Number(
          grouped[month].reduce((sum, tx) => sum + (tx.amount || 0), 0).toFixed(2)
        ),
        count: grouped[month].length,
        transactions: grouped[month],
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

app.get("/insights", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const start_date = req.query.start_date || "2026-02-01";
    const end_date = req.query.end_date || new Date().toISOString().slice(0, 10);

    const all = await getTransactions(saved.access_token, start_date, end_date);

    const transactions = all.filter(
      (tx) => typeof tx.amount === "number" && tx.amount > 0
    );

    const spentByCategory = {};
    let spentTotal = 0;

    for (const tx of transactions) {
      const category = getCategory(tx);
      spentByCategory[category] = (spentByCategory[category] || 0) + tx.amount;
      spentTotal += tx.amount;
    }

    for (const key of Object.keys(spentByCategory)) {
      spentByCategory[key] = Number(spentByCategory[key].toFixed(2));
    }

    const { budgetByCategory, remainingByCategory } = buildBudgetObjects(spentByCategory);

    res.json({
      month: start_date.slice(0, 7),
      totals: {
        total_transactions: transactions.length,
        spent: Number(spentTotal.toFixed(2)),
      },
      budgets: {
        budgetByCategory,
        spentByCategory,
        remainingByCategory,
      },
    });
  } catch (err) {
    console.error("insights error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to generate insights",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.get("/ai_advice", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getTransactions(
      saved.access_token,
      currentRange.start,
      currentRange.end
    )).filter((t) => typeof t.amount === "number" && t.amount > 0);

    const previousTransactions = (await getTransactions(
      saved.access_token,
      previousRange.start,
      previousRange.end
    )).filter((t) => typeof t.amount === "number" && t.amount > 0);

    const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
    const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

    const categoryTotals = sumByCategory(currentTransactions);
    const merchantTotals = sumByMerchant(currentTransactions);

    const topCategoryEntry =
      Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0] || ["OTHER", 0];

    const topMerchantEntry =
      Object.entries(merchantTotals).sort((a, b) => b[1] - a[1])[0] || ["Unknown", 0];

    let trendText = "about the same as";
    if (currentSpent > previousSpent + 5) trendText = "higher than";
    if (currentSpent < previousSpent - 5) trendText = "lower than";

    const summary = `In the last 30 days, you spent $${currentSpent.toFixed(2)}. Your biggest spending category was ${formatCategoryName(topCategoryEntry[0])} at $${topCategoryEntry[1].toFixed(2)}. Your spending was ${trendText} the previous 30-day period.`;

    const tips = [];

    if (topCategoryEntry[1] > currentSpent * 0.4) {
      tips.push(
        `Most of your spending came from ${formatCategoryName(topCategoryEntry[0])}. Setting a category limit there could help the most.`
      );
    }

    if (topMerchantEntry[0] !== "Unknown") {
      tips.push(
        `Your top merchant was ${topMerchantEntry[0]} at $${topMerchantEntry[1].toFixed(2)}.`
      );
    }

    if (currentSpent > previousSpent + 5) {
      tips.push(
        `You spent $${(currentSpent - previousSpent).toFixed(2)} more than the previous 30 days.`
      );
    } else if (currentSpent < previousSpent - 5) {
      tips.push(
        `You spent $${(previousSpent - currentSpent).toFixed(2)} less than the previous 30 days.`
      );
    } else {
      tips.push("Your spending is staying pretty consistent month to month.");
    }

    res.json({
      summary,
      tips,
      currentSpent: Number(currentSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      topCategory: formatCategoryName(topCategoryEntry[0]),
      topCategoryAmount: Number(topCategoryEntry[1].toFixed(2)),
      topMerchant: topMerchantEntry[0],
      topMerchantAmount: Number(topMerchantEntry[1].toFixed(2)),
    });
  } catch (err) {
    console.error("ai_advice error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to generate AI advice",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getTransactions(
      saved.access_token,
      currentRange.start,
      currentRange.end
    )).filter((t) => typeof t.amount === "number" && t.amount > 0);

    const previousTransactions = (await getTransactions(
      saved.access_token,
      previousRange.start,
      previousRange.end
    )).filter((t) => typeof t.amount === "number" && t.amount > 0);

    const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
    const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

    const categoryTotals = sumByCategory(currentTransactions);
    const merchantTotals = sumByMerchant(currentTransactions);

    const alerts = [];

    const topCategoryEntry =
      Object.entries(categoryTotals).sort((a, b) => b[1] - a[1])[0] || ["OTHER", 0];

    const topCategory = topCategoryEntry[0];
    const topCategoryAmount = topCategoryEntry[1];

    if (currentSpent > 0 && topCategoryAmount / currentSpent >= 0.45) {
      alerts.push({
        type: "warning",
        title: "Top category is dominating spending",
        message: `${formatCategoryName(topCategory)} makes up ${((topCategoryAmount / currentSpent) * 100).toFixed(0)}% of your last 30 days of spending.`,
      });
    }

    if (currentSpent > previousSpent + 15) {
      alerts.push({
        type: "warning",
        title: "Spending increased",
        message: `You spent $${(currentSpent - previousSpent).toFixed(2)} more than the previous 30-day period.`,
      });
    }

    const uberLyftTotal = currentTransactions
      .filter((tx) => {
        const merchant = (tx.merchant_name || tx.name || "").toLowerCase();
        return merchant.includes("uber") || merchant.includes("lyft");
      })
      .reduce((sum, tx) => sum + tx.amount, 0);

    if (uberLyftTotal >= 20) {
      alerts.push({
        type: "info",
        title: "Rideshare spending detected",
        message: `You spent $${uberLyftTotal.toFixed(2)} on Uber/Lyft in the last 30 days.`,
      });
    }

    const recurringMerchantCounts = {};
    for (const tx of currentTransactions) {
      const merchant = (tx.merchant_name || tx.name || "Unknown").trim();
      recurringMerchantCounts[merchant] = (recurringMerchantCounts[merchant] || 0) + 1;
    }

    const recurringMerchants = Object.entries(recurringMerchantCounts)
      .filter(([, count]) => count >= 2)
      .sort((a, b) => b[1] - a[1]);

    if (recurringMerchants.length > 0) {
      const [merchant, count] = recurringMerchants[0];
      alerts.push({
        type: "info",
        title: "Possible recurring charge",
        message: `${merchant} appeared ${count} times in the last 30 days.`,
      });
    }

    if (alerts.length === 0) {
      alerts.push({
        type: "good",
        title: "No major alerts",
        message: "Your recent spending looks pretty stable right now.",
      });
    }

    res.json({
      totalSpent: Number(currentSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      alerts,
    });
  } catch (err) {
    console.error("alerts error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to generate alerts",
      details: err?.response?.data || err?.message || String(err),
    });
  }
});

app.post("/ask_budget", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected" });
    }

    const question = (req.body?.question || "").toLowerCase().trim();

    if (!question) {
      return res.status(400).json({ error: "Missing question" });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getTransactions(
      saved.access_token,
      currentRange.start,
      currentRange.end
    )).filter((t) => typeof t.amount === "number" && t.amount > 0);

    const previousTransactions = (await getTransactions(
      saved.access_token,
      previousRange.start,
      previousRange.end
    )).filter((t) => typeof t.amount === "number" && t.amount > 0);

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

    let answer =
      "I couldn't understand that question yet. Try asking about your top category, biggest purchase, recurring charges, Uber spending, or whether you spent more than last month.";

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Backend running on port ${PORT}`);
});
