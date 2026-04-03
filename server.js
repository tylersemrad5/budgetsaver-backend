import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import plaid from "plaid";

dotenv.config();

const {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
} = plaid;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =========================
// Plaid setup
// =========================
const plaidEnvName = (process.env.PLAID_ENV || "sandbox").toLowerCase();

const plaidEnv =
  plaidEnvName === "production"
    ? PlaidEnvironments.production
    : plaidEnvName === "development"
    ? PlaidEnvironments.development
    : PlaidEnvironments.sandbox;

const plaidConfig = new Configuration({
  basePath: plaidEnv,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": process.env.PLAID_CLIENT_ID || "",
      "PLAID-SECRET": process.env.PLAID_SECRET || "",
      "Plaid-Version": "2020-09-14",
    },
  },
});

const plaidClient = new PlaidApi(plaidConfig);

// =========================
// Temporary in-memory token store
// Replace with DB later for production
// =========================
const userTokens = new Map();

// =========================
// Helpers
// =========================
function getUserId(req) {
  return req.header("X-USER-ID") || "tyler_local_user";
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function getDateRangeLast30Days() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 30);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

function getPrevious30DayRange() {
  const end = new Date();
  end.setDate(end.getDate() - 30);

  const start = new Date(end);
  start.setDate(start.getDate() - 30);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

function getCurrentMonthLabel() {
  const formatter = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  });
  return formatter.format(new Date());
}

function isDebitLikeTransaction(tx) {
  return typeof tx.amount === "number" && tx.amount > 0;
}

function getCategory(tx) {
  return (
    tx.personal_finance_category?.primary ||
    (Array.isArray(tx.category) && tx.category.length > 0 ? tx.category[0] : null) ||
    "OTHER"
  );
}

function formatCategoryName(raw) {
  return String(raw)
    .toLowerCase()
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function normalizeMerchant(tx) {
  return (tx.merchant_name || tx.name || "Unknown").trim();
}

function percentChange(current, previous) {
  if (!previous && !current) return 0;
  if (!previous) return 100;
  return Number((((current - previous) / previous) * 100).toFixed(1));
}

function topEntries(obj, limit = 5) {
  return Object.entries(obj)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([name, amount]) => ({
      name,
      amount: Number(amount.toFixed(2)),
    }));
}

function sumByCategory(transactions) {
  const totals = {};
  for (const tx of transactions) {
    const category = formatCategoryName(getCategory(tx));
    totals[category] = (totals[category] || 0) + tx.amount;
  }
  return totals;
}

function sumByMerchant(transactions) {
  const totals = {};
  for (const tx of transactions) {
    const merchant = normalizeMerchant(tx);
    totals[merchant] = (totals[merchant] || 0) + tx.amount;
  }
  return totals;
}

function monthKeyFromDateString(dateString) {
  const d = new Date(dateString);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function buildTransactionsByMonth(transactions, start, end) {
  const groups = {};

  for (const tx of transactions) {
    const key = monthKeyFromDateString(tx.date);
    if (!groups[key]) groups[key] = [];

    groups[key].push({
      id: tx.transaction_id,
      name: tx.name || "Unknown",
      date: tx.date,
      amount: Number(tx.amount.toFixed(2)),
      category: formatCategoryName(getCategory(tx)),
    });
  }

  const months = Object.entries(groups)
    .map(([month, txs]) => ({
      month,
      totalSpent: Number(txs.reduce((sum, t) => sum + t.amount, 0).toFixed(2)),
      count: txs.length,
      transactions: txs.sort((a, b) => b.date.localeCompare(a.date)),
    }))
    .sort((a, b) => b.month.localeCompare(a.month));

  return {
    range: {
      start_date: start,
      end_date: end,
    },
    months,
  };
}

function findRecurringCharges(transactions) {
  const grouped = {};

  for (const tx of transactions) {
    const merchant = normalizeMerchant(tx);
    if (!grouped[merchant]) grouped[merchant] = [];
    grouped[merchant].push(tx);
  }

  const recurring = [];

  for (const [merchant, txs] of Object.entries(grouped)) {
    if (txs.length < 2) continue;

    const total = txs.reduce((sum, t) => sum + t.amount, 0);
    recurring.push({
      merchant,
      count: txs.length,
      total: Number(total.toFixed(2)),
      average: Number((total / txs.length).toFixed(2)),
    });
  }

  return recurring.sort((a, b) => b.total - a.total).slice(0, 10);
}

function buildRuleInsights(currentTransactions, previousTransactions) {
  const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
  const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

  const currentCategories = sumByCategory(currentTransactions);
  const previousCategories = sumByCategory(previousTransactions);
  const currentMerchants = sumByMerchant(currentTransactions);

  const topCategory = topEntries(currentCategories, 1)[0] || null;
  const topMerchant = topEntries(currentMerchants, 1)[0] || null;
  const recurring = findRecurringCharges(currentTransactions);

  const insights = [];

  if (topCategory) {
    insights.push({
      type: "top_category",
      title: `Top spending category: ${topCategory.name}`,
      message: `${topCategory.name} was your biggest category at $${topCategory.amount.toFixed(2)} in the last 30 days.`,
      priority: "high",
    });
  }

  if (topMerchant) {
    insights.push({
      type: "top_merchant",
      title: `Biggest merchant: ${topMerchant.name}`,
      message: `Your highest spend with a single merchant was ${topMerchant.name} at $${topMerchant.amount.toFixed(2)}.`,
      priority: "medium",
    });
  }

  const overallChange = percentChange(currentSpent, previousSpent);
  if (currentSpent > previousSpent) {
    insights.push({
      type: "spending_up",
      title: "Spending increased",
      message: `You spent $${currentSpent.toFixed(2)} in the last 30 days, up ${overallChange}% from the previous period.`,
      priority: "high",
    });
  } else if (currentSpent < previousSpent) {
    insights.push({
      type: "spending_down",
      title: "Spending decreased",
      message: `You spent $${currentSpent.toFixed(2)} in the last 30 days, down ${Math.abs(overallChange)}% from the previous period.`,
      priority: "good",
    });
  }

  for (const [category, amount] of Object.entries(currentCategories)) {
    const prev = previousCategories[category] || 0;
    const change = percentChange(amount, prev);

    if (amount >= 50 && change >= 30) {
      insights.push({
        type: "category_jump",
        title: `${category} is trending up`,
        message: `You spent $${amount.toFixed(2)} on ${category}, which is up ${change}% from the prior 30 days.`,
        priority: "medium",
      });
    }
  }

  if (recurring.length > 0) {
    const topRecurring = recurring[0];
    insights.push({
      type: "recurring",
      title: "Recurring charges detected",
      message: `You have recurring spending with ${topRecurring.merchant}. It appeared ${topRecurring.count} times and totaled $${topRecurring.total.toFixed(2)}.`,
      priority: "medium",
    });
  }

  if (topCategory && topCategory.amount >= currentSpent * 0.45) {
    insights.push({
      type: "concentration",
      title: "Spending is concentrated",
      message: `Nearly half of your spending came from ${topCategory.name}. Reducing that category would have the biggest impact.`,
      priority: "high",
    });
  }

  return insights.slice(0, 6);
}

function buildMoneyInsights(currentTransactions, previousTransactions) {
  const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
  const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

  const categoryTotals = sumByCategory(currentTransactions);
  const merchantTotals = sumByMerchant(currentTransactions);
  const recurringCharges = findRecurringCharges(currentTransactions);
  const insights = buildRuleInsights(currentTransactions, previousTransactions);

  const topCategories = topEntries(categoryTotals, 5);
  const topMerchants = topEntries(merchantTotals, 5);

  const topCategoryAmount = topCategories[0]?.amount || 0;
  const budgetScore = buildBudgetScore(
    currentSpent,
    previousSpent,
    recurringCharges,
    topCategoryAmount
  );

  const savingsOpportunities = buildSavingsOpportunities(topCategories, recurringCharges);
  const actionItems = buildActionItems(
    currentSpent,
    previousSpent,
    topCategories,
    recurringCharges
  );
  const riskFlags = buildRiskFlags(
    currentSpent,
    previousSpent,
    topCategories,
    recurringCharges
  );

  return {
    summary: {
      currentSpent: Number(currentSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      changePercent: percentChange(currentSpent, previousSpent),
      transactionCount: currentTransactions.length,
    },
    budgetScore,
    topCategories,
    topMerchants,
    recurringCharges,
    insights,
    savingsOpportunities,
    actionItems,
    riskFlags,
  };
}

function buildBudgetAIResponse(question, moneyInsights) {
  const q = question.toLowerCase();

  const topCategory = moneyInsights.topCategories[0];
  const topMerchant = moneyInsights.topMerchants[0];
  const recurring = moneyInsights.recurringCharges[0];
  const currentSpent = moneyInsights.summary.currentSpent;
  const previousSpent = moneyInsights.summary.previousSpent;
  const changePercent = moneyInsights.summary.changePercent;

  let answer = "";
  let suggestions = [];
  let score = 70;

  if (q.includes("wasting") || q.includes("waste")) {
    answer = topCategory
      ? `Your biggest spending pressure is **${topCategory.name}** at **$${topCategory.amount.toFixed(2)}**. ${
          recurring
            ? `You also have recurring spending with **${recurring.merchant}** totaling **$${recurring.total.toFixed(2)}**. `
            : ""
        }The easiest place to cut first is your largest category.`
      : "I don't have enough spending data yet to identify waste areas.";

    suggestions = [
      "What subscriptions should I cut?",
      "What did I spend the most on?",
      "Did I spend more than last month?"
    ];
    score = 62;
  } else if (q.includes("biggest expense") || q.includes("top category")) {
    answer = topCategory
      ? `Your top spending category is **${topCategory.name}** at **$${topCategory.amount.toFixed(2)}** in the last 30 days.`
      : "I don't have enough data yet to find your biggest expense.";

    suggestions = [
      "Where am I wasting money?",
      "What was my biggest merchant?",
      "Show recurring charges"
    ];
    score = 72;
  } else if (q.includes("merchant")) {
    answer = topMerchant
      ? `Your biggest merchant spend was **${topMerchant.name}** at **$${topMerchant.amount.toFixed(2)}**.`
      : "I don't have enough merchant data yet.";

    suggestions = [
      "What did I spend the most on?",
      "Where am I wasting money?",
      "Did I spend more than last month?"
    ];
    score = 70;
  } else if (q.includes("subscription") || q.includes("recurring")) {
    if (moneyInsights.recurringCharges.length === 0) {
      answer = "I did not detect recurring charges in the last 30 days.";
    } else {
      const lines = moneyInsights.recurringCharges
        .slice(0, 3)
        .map(
          (r) =>
            `- **${r.merchant}**: ${r.count} charges totaling **$${r.total.toFixed(2)}**`
        )
        .join("\n");

      answer = `Here are your top recurring charges:\n${lines}`;
    }

    suggestions = [
      "Which recurring charge is biggest?",
      "Where am I wasting money?",
      "How can I save more?"
    ];
    score = 68;
  } else if (q.includes("save") || q.includes("saving")) {
    answer = topCategory
      ? `The fastest way to save more is to reduce **${topCategory.name}**, your largest category at **$${topCategory.amount.toFixed(2)}**. ${
          topMerchant ? `Your biggest merchant was **${topMerchant.name}**.` : ""
        } Start with the biggest category first.`
      : "I need more transaction data before I can suggest savings areas.";

    suggestions = [
      "Where am I wasting money?",
      "Break down my subscriptions",
      "Did I spend more than last month?"
    ];
    score = 74;
  } else if (
    q.includes("more than last month") ||
    q.includes("spend more") ||
    q.includes("last month")
  ) {
    answer =
      currentSpent > previousSpent
        ? `Yes — you spent **$${currentSpent.toFixed(2)}** in the last 30 days versus **$${previousSpent.toFixed(2)}** in the previous period, which is **up ${changePercent}%**.`
        : `No — you spent **$${currentSpent.toFixed(2)}** in the last 30 days versus **$${previousSpent.toFixed(2)}** in the previous period, which is **down ${Math.abs(changePercent)}%**.`;

    suggestions = [
      "What category increased the most?",
      "Where am I wasting money?",
      "How can I save more?"
    ];
    score = 73;
  } else {
    const insightLines = moneyInsights.insights
      .slice(0, 3)
      .map((i) => `- ${i.message}`)
      .join("\n");

    answer = `Here’s your current money snapshot:\n${insightLines}`;
    suggestions = [
      "Where am I wasting money?",
      "What did I spend the most on?",
      "Break down my subscriptions"
    ];
    score = 70;
  }

  return {
    answer,
    suggestions,
    score,
  };
}

async function getTransactions(accessToken, startDate, endDate) {
  const all = [];
  let offset = 0;
  const count = 100;

  while (true) {
    const response = await plaidClient.transactionsGet({
      access_token: accessToken,
      start_date: startDate,
      end_date: endDate,
      options: {
        count,
        offset,
      },
    });

    const txs = response.data.transactions || [];
    all.push(...txs);

    offset += txs.length;
    if (all.length >= response.data.total_transactions) break;
  }

  return all;
}

function buildBudgetScore(currentSpent, previousSpent, recurringCharges, topCategoryAmount) {
  let score = 100;

  if (currentSpent > previousSpent) {
    score -= Math.min(20, Math.round((currentSpent - previousSpent) / 10));
  }

  if (recurringCharges.length >= 3) {
    score -= 10;
  }

  if (topCategoryAmount > currentSpent * 0.5) {
    score -= 10;
  }

  return Math.max(35, Math.min(100, score));
}

function buildSavingsOpportunities(topCategories, recurringCharges) {
  const opportunities = [];

  if (topCategories[0]) {
    opportunities.push({
      title: `Reduce ${topCategories[0].name}`,
      amount: Number((topCategories[0].amount * 0.15).toFixed(2)),
      message: `Cutting 15% from ${topCategories[0].name} could save about $${(topCategories[0].amount * 0.15).toFixed(2)}.`,
    });
  }

  if (recurringCharges[0]) {
    opportunities.push({
      title: `Review ${recurringCharges[0].merchant}`,
      amount: recurringCharges[0].average,
      message: `${recurringCharges[0].merchant} appears recurring. Reviewing it could save about $${recurringCharges[0].average.toFixed(2)} per cycle.`,
    });
  }

  return opportunities.slice(0, 3);
}

function buildActionItems(currentSpent, previousSpent, topCategories, recurringCharges) {
  const items = [];

  if (currentSpent > previousSpent) {
    items.push("Your spending is up from the previous period. Review your largest category first.");
  }

  if (topCategories[0]) {
    items.push(`Your biggest category is ${topCategories[0].name}. That is the fastest place to cut.`);
  }

  if (recurringCharges.length > 0) {
    items.push(`You have ${recurringCharges.length} recurring charge pattern(s). Review subscriptions and repeated services.`);
  }

  if (items.length === 0) {
    items.push("Your spending is stable. Keep tracking your top categories to stay on target.");
  }

  return items.slice(0, 4);
}

function buildRiskFlags(currentSpent, previousSpent, topCategories, recurringCharges) {
  const flags = [];

  if (currentSpent > previousSpent * 1.2 && previousSpent > 0) {
    flags.push("Spending increased sharply versus the prior 30 days.");
  }

  if (topCategories[0] && topCategories[0].amount > currentSpent * 0.5) {
    flags.push(`More than half of your spending is concentrated in ${topCategories[0].name}.`);
  }

  if (recurringCharges.length >= 3) {
    flags.push("Several recurring charges were detected.");
  }

  return flags;
}

// =========================
// Routes
// =========================
app.get("/", (_req, res) => {
  res.json({
    ok: true,
    message: "BudgetSaver backend is running.",
    env: plaidEnvName,
  });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post("/create_link_token", async (req, res) => {
  try {
    const userId = getUserId(req);

    const response = await plaidClient.linkTokenCreate({
      user: {
        client_user_id: userId,
      },
      client_name: "BudgetSaver",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });

    res.json({
      link_token: response.data.link_token,
    });
  } catch (err) {
    console.error("create_link_token error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to create link token.",
      details: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body;
    const userId = getUserId(req);

    if (!public_token) {
      return res.status(400).json({ error: "Missing public_token" });
    }

    const response = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const accessToken = response.data.access_token;
    const itemId = response.data.item_id;

    userTokens.set(userId, {
      access_token: accessToken,
      item_id: itemId,
    });

    res.json({
      ok: true,
      item_id: itemId,
    });
  } catch (err) {
    console.error("exchange_public_token error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to exchange public token.",
      details: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected." });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getTransactions(
      saved.access_token,
      currentRange.start,
      currentRange.end
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getTransactions(
      saved.access_token,
      previousRange.start,
      previousRange.end
    )).filter(isDebitLikeTransaction);

    const totalSpent = currentTransactions.reduce((sum, tx) => sum + tx.amount, 0);
    const previousSpent = previousTransactions.reduce((sum, tx) => sum + tx.amount, 0);

    const recurringCharges = findRecurringCharges(currentTransactions);
    const alerts = [];

    const change = percentChange(totalSpent, previousSpent);
    if (totalSpent > previousSpent && totalSpent > 0) {
      alerts.push({
        type: "warning",
        title: "Spending increased",
        message: `You spent $${totalSpent.toFixed(2)} in the last 30 days, up ${change}% from the previous period.`,
      });
    } else if (totalSpent < previousSpent) {
      alerts.push({
        type: "good",
        title: "Spending decreased",
        message: `You spent less than the previous 30-day period.`,
      });
    }

    if (recurringCharges.length > 0) {
      alerts.push({
        type: "info",
        title: "Recurring charges found",
        message: `${recurringCharges.length} recurring charge pattern(s) detected.`,
      });
    }

    res.json({
      totalSpent: Number(totalSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      alerts,
    });
  } catch (err) {
    console.error("alerts error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build alerts." });
  }
});

app.get("/insights", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected." });
    }

    const range = getDateRangeLast30Days();

    const transactions = (await getTransactions(
      saved.access_token,
      range.start,
      range.end
    )).filter(isDebitLikeTransaction);

    const spentByCategoryRaw = sumByCategory(transactions);
    const totalSpent = transactions.reduce((sum, tx) => sum + tx.amount, 0);

    const budgetByCategory = {};
    const spentByCategory = {};
    const remainingByCategory = {};

    for (const [category, spent] of Object.entries(spentByCategoryRaw)) {
      const budget = Math.max(spent * 1.2, spent + 25);
      budgetByCategory[category] = Number(budget.toFixed(2));
      spentByCategory[category] = Number(spent.toFixed(2));
      remainingByCategory[category] = Number((budget - spent).toFixed(2));
    }

    res.json({
      month: getCurrentMonthLabel(),
      totals: {
        total_transactions: transactions.length,
        spent: Number(totalSpent.toFixed(2)),
      },
      budgets: {
        budgetByCategory,
        spentByCategory,
        remainingByCategory,
      },
    });
  } catch (err) {
    console.error("insights error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build insights." });
  }
});

app.get("/transactions_by_month", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected." });
    }

    const end = new Date();
    const start = new Date();
    start.setMonth(end.getMonth() - 6);

    const startDate = formatDate(start);
    const endDate = formatDate(end);

    const transactions = (await getTransactions(
      saved.access_token,
      startDate,
      endDate
    )).filter(isDebitLikeTransaction);

    res.json(buildTransactionsByMonth(transactions, startDate, endDate));
  } catch (err) {
    console.error("transactions_by_month error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build transactions by month." });
  }
});

app.get("/money_insights", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected." });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getTransactions(
      saved.access_token,
      currentRange.start,
      currentRange.end
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getTransactions(
      saved.access_token,
      previousRange.start,
      previousRange.end
    )).filter(isDebitLikeTransaction);

    const insightData = buildMoneyInsights(currentTransactions, previousTransactions);

    res.json(insightData);
  } catch (err) {
    console.error("money_insights error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build money insights." });
  }
});

app.post("/ask_budget_ai", async (req, res) => {
  try {
    const userId = getUserId(req);
    const saved = userTokens.get(userId);
    const question = String(req.body?.question || "").trim();

    if (!saved?.access_token) {
      return res.status(401).json({ error: "No bank connected." });
    }

    if (!question) {
      return res.status(400).json({ error: "Missing question." });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getTransactions(
      saved.access_token,
      currentRange.start,
      currentRange.end
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getTransactions(
      saved.access_token,
      previousRange.start,
      previousRange.end
    )).filter(isDebitLikeTransaction);

    const moneyInsights = buildMoneyInsights(currentTransactions, previousTransactions);
    const result = buildBudgetAIResponse(question, moneyInsights);

    res.json({
      question,
      answer: result.answer,
      score: result.score,
      suggestions: result.suggestions,
      source: "rule_engine",
    });
  } catch (err) {
    console.error("ask_budget_ai error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to answer budget question.",
      details: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

// =========================
// Start server
// =========================
app.listen(PORT, () => {
  console.log(`BudgetSaver backend running on port ${PORT}`);
});
