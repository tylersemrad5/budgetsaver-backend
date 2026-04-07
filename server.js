import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import dotenv from "dotenv";
import plaid from "plaid";
import pg from "pg";
import OpenAI from "openai";

dotenv.config();

const { Configuration, PlaidApi, PlaidEnvironments } = plaid;
const { Pool } = pg;

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// =========================
// Rate limiting
// =========================
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again in a minute." },
});

const plaidLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many Plaid requests. Please slow down and try again." },
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many AI requests. Please wait a moment and try again." },
});

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
// Database
// =========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_items (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      institution_id TEXT,
      institution_name TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_accounts (
      account_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      institution_name TEXT,
      name TEXT,
      official_name TEXT,
      mask TEXT,
      type TEXT,
      subtype TEXT,
      current_balance DOUBLE PRECISION,
      available_balance DOUBLE PRECISION,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    ALTER TABLE plaid_accounts
    ADD COLUMN IF NOT EXISTS current_balance DOUBLE PRECISION;
  `);

  await pool.query(`
    ALTER TABLE plaid_accounts
    ADD COLUMN IF NOT EXISTS available_balance DOUBLE PRECISION;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_item_sync_state (
      item_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      transactions_cursor TEXT,
      last_webhook_code TEXT,
      last_synced_at TIMESTAMP,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS plaid_transactions (
      transaction_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      date DATE,
      name TEXT,
      merchant_name TEXT,
      amount DOUBLE PRECISION,
      pending BOOLEAN,
      category_primary TEXT,
      raw_json JSONB,
      updated_at TIMESTAMP DEFAULT NOW()
    );
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_plaid_transactions_user_date
    ON plaid_transactions (user_id, date DESC);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_plaid_transactions_user_account
    ON plaid_transactions (user_id, account_id);
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_plaid_transactions_user_item
    ON plaid_transactions (user_id, item_id);
  `);

  console.log("Database initialized");
}

// =========================
// OpenAI
// =========================
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

// =========================
// Request helpers
// =========================
function getUserId(req) {
  return req.header("X-USER-ID") || "tyler_local_user";
}

function parseHeaderList(req, headerName) {
  const headerValue = req.header(headerName);
  if (!headerValue) return null;

  const ids = headerValue
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return ids.length > 0 ? ids : null;
}

function getSelectedItemIds(req) {
  return parseHeaderList(req, "X-SELECTED-ITEM-IDS");
}

function getSelectedAccountIds(req) {
  return parseHeaderList(req, "X-SELECTED-ACCOUNT-IDS");
}

// =========================
// Date helpers
// =========================
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

function getDateRangeLastSixMonths() {
  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - 5);
  start.setDate(1);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

function getDateRangeLast7Days() {
  const end = new Date();
  const start = new Date();
  start.setDate(end.getDate() - 7);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

function getPrevious7DayRange() {
  const end = new Date();
  end.setDate(end.getDate() - 7);

  const start = new Date(end);
  start.setDate(start.getDate() - 7);

  return {
    start: formatDate(start),
    end: formatDate(end),
  };
}

function getCurrentMonthLabel() {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(new Date());
}

// =========================
// Data helpers
// =========================
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

function monthDisplay(monthKey) {
  const [year, month] = monthKey.split("-");
  const date = new Date(Number(year), Number(month) - 1, 1);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    year: "numeric",
  }).format(date);
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
      institutionName: tx._institution_name || null,
      accountName: tx._account_name || null,
      accountMask: tx._account_mask || null,
      item_id: tx._item_id || null,
      account_id: tx.account_id || null,
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

function buildMonthlyTrend(transactions) {
  const grouped = {};

  for (const tx of transactions) {
    const key = monthKeyFromDateString(tx.date);
    grouped[key] = (grouped[key] || 0) + tx.amount;
  }

  return Object.entries(grouped)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, totalSpent]) => ({
      month,
      label: monthDisplay(month),
      totalSpent: Number(totalSpent.toFixed(2)),
    }));
}

function buildCategoryChartData(transactions) {
  const totals = sumByCategory(transactions);
  const items = topEntries(totals, 8);
  const grandTotal = items.reduce((sum, item) => sum + item.amount, 0);

  return items.map((item) => ({
    category: item.name,
    amount: item.amount,
    percentage: grandTotal > 0 ? Number(((item.amount / grandTotal) * 100).toFixed(1)) : 0,
  }));
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

// =========================
// Insights engine
// =========================
function buildBudgetScore(currentSpent, previousSpent, recurringCharges, topCategoryAmount) {
  let score = 100;

  if (currentSpent > previousSpent) {
    score -= Math.min(20, Math.round((currentSpent - previousSpent) / 10));
  }

  if (recurringCharges.length >= 3) {
    score -= 10;
  }

  if (currentSpent > 0 && topCategoryAmount > currentSpent * 0.5) {
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
      message: `Cutting 15% from ${topCategories[0].name} could save about $${(
        topCategories[0].amount * 0.15
      ).toFixed(2)}.`,
    });
  }

  if (recurringCharges[0]) {
    opportunities.push({
      title: `Review ${recurringCharges[0].merchant}`,
      amount: recurringCharges[0].average,
      message: `${recurringCharges[0].merchant} appears recurring. Reviewing it could save about $${recurringCharges[0].average.toFixed(
        2
      )} per cycle.`,
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

  if (topCategories[0] && currentSpent > 0 && topCategories[0].amount > currentSpent * 0.5) {
    flags.push(`More than half of your spending is concentrated in ${topCategories[0].name}.`);
  }

  if (recurringCharges.length >= 3) {
    flags.push("Several recurring charges were detected.");
  }

  return flags;
}

function buildActionableMessages(currentTransactions, previousTransactions) {
  const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
  const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);
  const currentCategories = sumByCategory(currentTransactions);
  const previousCategories = sumByCategory(previousTransactions);
  const currentMerchants = sumByMerchant(currentTransactions);

  const messages = [];

  const topCategory = topEntries(currentCategories, 1)[0];
  if (topCategory) {
    messages.push({
      title: `${topCategory.name} is your biggest category`,
      message: `You spent $${topCategory.amount.toFixed(2)} on ${topCategory.name}. This is the fastest category to target if you want quick savings.`,
      impact: "high",
      suggestedAction: `Try cutting ${topCategory.name} by 10–15% this month.`,
    });
  }

  const topMerchant = topEntries(currentMerchants, 1)[0];
  if (topMerchant) {
    messages.push({
      title: `${topMerchant.name} is your top merchant`,
      message: `Your highest merchant spend was $${topMerchant.amount.toFixed(2)} with ${topMerchant.name}.`,
      impact: "medium",
      suggestedAction: `Review whether that merchant reflects a habit you want to change.`,
    });
  }

  if (currentSpent > previousSpent) {
    const increase = currentSpent - previousSpent;
    messages.push({
      title: "Your spending increased",
      message: `You spent $${increase.toFixed(2)} more than the previous 30-day period.`,
      impact: "high",
      suggestedAction: "Check the category and merchant sections to see what changed.",
    });
  }

  for (const [category, amount] of Object.entries(currentCategories)) {
    const prev = previousCategories[category] || 0;
    const change = percentChange(amount, prev);

    if (amount >= 50 && change >= 25) {
      messages.push({
        title: `${category} is rising`,
        message: `You spent $${amount.toFixed(2)} on ${category}, up ${change}% from the prior period.`,
        impact: "medium",
        suggestedAction: `Watch your ${category} spending over the next 2 weeks.`,
      });
    }
  }

  return messages.slice(0, 5);
}

function buildRuleInsights(currentTransactions, previousTransactions) {
  const currentSpent = currentTransactions.reduce((sum, t) => sum + t.amount, 0);
  const previousSpent = previousTransactions.reduce((sum, t) => sum + t.amount, 0);

  const currentCategories = sumByCategory(currentTransactions);
  const previousCategories = sumByCategory(previousTransactions);
  const currentMerchants = sumByMerchant(currentTransactions);
  const recurring = findRecurringCharges(currentTransactions);

  const topCategory = topEntries(currentCategories, 1)[0] || null;
  const topMerchant = topEntries(currentMerchants, 1)[0] || null;

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

  if (topCategory && currentSpent > 0 && topCategory.amount >= currentSpent * 0.45) {
    insights.push({
      type: "concentration",
      title: "Spending is concentrated",
      message: `Nearly half of your spending came from ${topCategory.name}. Reducing that category would have the biggest impact.`,
      priority: "high",
    });
  }

  return insights.slice(0, 6);
}

function buildMoneyInsights(currentTransactions, previousTransactions, sixMonthTransactions) {
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
    actionableMessages: buildActionableMessages(currentTransactions, previousTransactions),
    savingsOpportunities: buildSavingsOpportunities(topCategories, recurringCharges),
    actionItems: buildActionItems(
      currentSpent,
      previousSpent,
      topCategories,
      recurringCharges
    ),
    riskFlags: buildRiskFlags(
      currentSpent,
      previousSpent,
      topCategories,
      recurringCharges
    ),
    monthlyTrend: buildMonthlyTrend(sixMonthTransactions),
    categoryChart: buildCategoryChartData(currentTransactions),
  };
}

function buildRichAlerts(currentTransactions, previousTransactions) {
  const alerts = [];

  const currentSpent = currentTransactions.reduce((sum, tx) => sum + tx.amount, 0);
  const previousSpent = previousTransactions.reduce((sum, tx) => sum + tx.amount, 0);
  const recurringCharges = findRecurringCharges(currentTransactions);

  const change = percentChange(currentSpent, previousSpent);

  if (currentSpent > previousSpent && currentSpent > 0) {
    alerts.push({
      type: "SPENDING_SPIKE",
      title: "Spending spike detected",
      message: `You spent $${currentSpent.toFixed(2)} in the last 30 days, up ${change}% from the previous period.`,
      severity: change >= 25 ? "high" : "medium",
    });
  }

  if (recurringCharges.length > 0) {
    alerts.push({
      type: "RECURRING_CHARGES",
      title: "Recurring charges detected",
      message: `${recurringCharges.length} recurring charge pattern(s) were found in your recent transactions.`,
      severity: recurringCharges.length >= 3 ? "medium" : "low",
    });
  }

  const topCategories = topEntries(sumByCategory(currentTransactions), 1);
  if (topCategories[0] && currentSpent > 0 && topCategories[0].amount > currentSpent * 0.5) {
    alerts.push({
      type: "CATEGORY_CONCENTRATION",
      title: "One category dominates your spending",
      message: `${topCategories[0].name} makes up most of your recent spending.`,
      severity: "medium",
    });
  }

  return alerts;
}

function buildWeeklySummary(currentWeekTransactions, previousWeekTransactions) {
  const currentSpent = currentWeekTransactions.reduce((sum, tx) => sum + tx.amount, 0);
  const previousSpent = previousWeekTransactions.reduce((sum, tx) => sum + tx.amount, 0);
  const topCategories = topEntries(sumByCategory(currentWeekTransactions), 3);
  const topMerchants = topEntries(sumByMerchant(currentWeekTransactions), 3);
  const recurringCharges = findRecurringCharges(currentWeekTransactions);
  const changePercentValue = percentChange(currentSpent, previousSpent);

  const highlights = [];

  if (currentSpent > previousSpent) {
    highlights.push(`You spent more this week than last week by ${changePercentValue}%.`);
  } else if (currentSpent < previousSpent) {
    highlights.push(`You spent less this week than last week by ${Math.abs(changePercentValue)}%.`);
  } else {
    highlights.push("Your weekly spending was flat compared with last week.");
  }

  if (topCategories[0]) {
    highlights.push(`Your top category this week was ${topCategories[0].name} at $${topCategories[0].amount.toFixed(2)}.`);
  }

  if (topMerchants[0]) {
    highlights.push(`Your top merchant this week was ${topMerchants[0].name} at $${topMerchants[0].amount.toFixed(2)}.`);
  }

  const recommendations = [];

  if (topCategories[0]) {
    recommendations.push(`Watch ${topCategories[0].name} next week since it was your largest category.`);
  }

  if (recurringCharges.length > 0) {
    recommendations.push(`Review recurring charges like ${recurringCharges[0].merchant} for easy savings opportunities.`);
  }

  if (currentSpent > previousSpent) {
    recommendations.push("Try to reduce one non-essential category next week to reverse the spending increase.");
  }

  if (recommendations.length === 0) {
    recommendations.push("Your spending looks steady. Keep following your current pattern.");
  }

  return {
    summary: {
      currentSpent: Number(currentSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      changePercent: changePercentValue,
      transactionCount: currentWeekTransactions.length,
    },
    highlights,
    recommendations: recommendations.slice(0, 3),
    topCategories,
    topMerchants,
  };
}

// =========================
// AI response helper
// =========================
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
  let score = moneyInsights.budgetScore || 70;

  if (q.includes("wasting") || q.includes("waste")) {
    answer = topCategory
      ? `Your biggest spending pressure is **${topCategory.name}** at **$${topCategory.amount.toFixed(2)}**. ${
          recurring
            ? `You also have recurring spending with **${recurring.merchant}** totaling **$${recurring.total.toFixed(2)}**. `
            : ""
        }The easiest place to cut first is your largest category.`
      : "I don't have enough spending data yet to identify waste areas.";

    suggestions = [
      "What should I cut first?",
      "Show my recurring charges",
      "How much could I save this month?"
    ];
  } else if (q.includes("save") || q.includes("saving")) {
    if (moneyInsights.savingsOpportunities.length > 0) {
      const topOpportunity = moneyInsights.savingsOpportunities[0];
      answer = `Your best near-term savings move is **${topOpportunity.title}**. ${topOpportunity.message}`;
    } else {
      answer = "I don't have a strong savings recommendation yet. Keep tracking your top categories.";
    }

    suggestions = [
      "What category is hurting me most?",
      "Show my biggest merchant",
      "Did my spending increase?"
    ];
  } else if (q.includes("biggest expense") || q.includes("top category")) {
    answer = topCategory
      ? `Your top spending category is **${topCategory.name}** at **$${topCategory.amount.toFixed(2)}** in the last 30 days.`
      : "I don't have enough data yet to find your biggest expense.";

    suggestions = [
      "Where am I wasting money?",
      "What should I cut first?",
      "Show my top merchants"
    ];
  } else if (q.includes("merchant")) {
    answer = topMerchant
      ? `Your biggest merchant spend was **${topMerchant.name}** at **$${topMerchant.amount.toFixed(2)}**.`
      : "I don't have enough merchant data yet.";

    suggestions = [
      "What did I spend the most on?",
      "Show recurring charges",
      "Did I spend more than last month?"
    ];
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
      "How much could I save?",
      "Where am I wasting money?"
    ];
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
      "What should I cut first?"
    ];
  } else if (q.includes("budget score") || q.includes("score")) {
    answer = `Your current **Budget Score** is **${moneyInsights.budgetScore}/100**. ${
      moneyInsights.riskFlags.length > 0
        ? `The biggest issues are: ${moneyInsights.riskFlags.join(" ")}`
        : "Your spending pattern looks fairly stable right now."
    }`;

    suggestions = [
      "How can I improve my score?",
      "What should I cut first?",
      "Show my savings opportunities"
    ];
  } else {
    const insightLines = moneyInsights.insights
      .slice(0, 3)
      .map((i) => `- ${i.message}`)
      .join("\n");

    answer = `Here’s your current money snapshot:\n${insightLines}`;
    suggestions = [
      "Where am I wasting money?",
      "What did I spend the most on?",
      "How much could I save?"
    ];
  }

  return {
    answer,
    suggestions,
    score,
  };
}

// =========================
// DB helpers
// =========================
async function saveUserItem(userId, accessToken, itemId, institutionId = null, institutionName = null) {
  await pool.query(
    `
    INSERT INTO plaid_items (
      user_id, item_id, access_token, institution_id, institution_name, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (item_id)
    DO UPDATE SET
      access_token = EXCLUDED.access_token,
      institution_id = EXCLUDED.institution_id,
      institution_name = EXCLUDED.institution_name,
      updated_at = NOW()
    `,
    [userId, itemId, accessToken, institutionId, institutionName]
  );
}

async function getUserItems(userId) {
  const result = await pool.query(
    `
    SELECT id, user_id, item_id, access_token, institution_id, institution_name
    FROM plaid_items
    WHERE user_id = $1
    ORDER BY created_at ASC
    `,
    [userId]
  );

  return result.rows;
}

async function getUserItemsFiltered(userId, selectedItemIds = null) {
  const allItems = await getUserItems(userId);

  if (!selectedItemIds || selectedItemIds.length === 0) {
    return allItems;
  }

  return allItems.filter((item) => selectedItemIds.includes(item.item_id));
}

async function getUserItemByItemId(userId, itemId) {
  const result = await pool.query(
    `
    SELECT id, user_id, item_id, access_token, institution_id, institution_name
    FROM plaid_items
    WHERE user_id = $1 AND item_id = $2
    LIMIT 1
    `,
    [userId, itemId]
  );

  return result.rows[0] || null;
}

async function deleteUserItem(userId, itemId) {
  await pool.query(
    `DELETE FROM plaid_items WHERE user_id = $1 AND item_id = $2`,
    [userId, itemId]
  );

  await pool.query(
    `DELETE FROM plaid_accounts WHERE user_id = $1 AND item_id = $2`,
    [userId, itemId]
  );

  await pool.query(
    `DELETE FROM plaid_item_sync_state WHERE user_id = $1 AND item_id = $2`,
    [userId, itemId]
  );

  await pool.query(
    `DELETE FROM plaid_transactions WHERE user_id = $1 AND item_id = $2`,
    [userId, itemId]
  );
}

async function replaceAccountsForItem(userId, itemId, institutionName, accounts) {
  await pool.query(
    `
    DELETE FROM plaid_accounts WHERE user_id = $1 AND item_id = $2
    `,
    [userId, itemId]
  );

  for (const account of accounts) {
    await pool.query(
      `
      INSERT INTO plaid_accounts (
        account_id,
        user_id,
        item_id,
        institution_name,
        name,
        official_name,
        mask,
        type,
        subtype,
        current_balance,
        available_balance,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
      ON CONFLICT (account_id)
      DO UPDATE SET
        institution_name = EXCLUDED.institution_name,
        name = EXCLUDED.name,
        official_name = EXCLUDED.official_name,
        mask = EXCLUDED.mask,
        type = EXCLUDED.type,
        subtype = EXCLUDED.subtype,
        current_balance = EXCLUDED.current_balance,
        available_balance = EXCLUDED.available_balance,
        item_id = EXCLUDED.item_id,
        updated_at = NOW()
      `,
      [
        account.account_id,
        userId,
        itemId,
        institutionName,
        account.name || null,
        account.official_name || null,
        account.mask || null,
        account.type || null,
        account.subtype || null,
        account.balances?.current ?? null,
        account.balances?.available ?? null,
      ]
    );
  }
}

async function getAccountsForUser(userId, selectedItemIds = null, selectedAccountIds = null) {
  if (selectedAccountIds && selectedAccountIds.length > 0) {
    const result = await pool.query(
      `
      SELECT
        account_id,
        user_id,
        item_id,
        institution_name,
        name,
        official_name,
        mask,
        type,
        subtype,
        current_balance,
        available_balance
      FROM plaid_accounts
      WHERE user_id = $1 AND account_id = ANY($2::text[])
      ORDER BY institution_name ASC, name ASC
      `,
      [userId, selectedAccountIds]
    );
    return result.rows;
  }

  if (selectedItemIds && selectedItemIds.length > 0) {
    const result = await pool.query(
      `
      SELECT
        account_id,
        user_id,
        item_id,
        institution_name,
        name,
        official_name,
        mask,
        type,
        subtype,
        current_balance,
        available_balance
      FROM plaid_accounts
      WHERE user_id = $1 AND item_id = ANY($2::text[])
      ORDER BY institution_name ASC, name ASC
      `,
      [userId, selectedItemIds]
    );
    return result.rows;
  }

  const result = await pool.query(
    `
    SELECT
      account_id,
      user_id,
      item_id,
      institution_name,
      name,
      official_name,
      mask,
      type,
      subtype,
      current_balance,
      available_balance
    FROM plaid_accounts
    WHERE user_id = $1
    ORDER BY institution_name ASC, name ASC
    `,
    [userId]
  );

  return result.rows;
}

async function getItemSyncState(itemId) {
  const result = await pool.query(
    `
    SELECT item_id, user_id, transactions_cursor, last_webhook_code, last_synced_at
    FROM plaid_item_sync_state
    WHERE item_id = $1
    LIMIT 1
    `,
    [itemId]
  );

  return result.rows[0] || null;
}

async function upsertItemSyncState(userId, itemId, cursor, webhookCode = null) {
  await pool.query(
    `
    INSERT INTO plaid_item_sync_state (
      item_id, user_id, transactions_cursor, last_webhook_code, last_synced_at, updated_at
    )
    VALUES ($1, $2, $3, $4, NOW(), NOW())
    ON CONFLICT (item_id)
    DO UPDATE SET
      transactions_cursor = EXCLUDED.transactions_cursor,
      last_webhook_code = COALESCE(EXCLUDED.last_webhook_code, plaid_item_sync_state.last_webhook_code),
      last_synced_at = NOW(),
      updated_at = NOW()
    `,
    [itemId, userId, cursor, webhookCode]
  );
}

async function applyTransactionSyncUpdates(userId, itemId, syncData) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    for (const tx of syncData.added || []) {
      await client.query(
        `
        INSERT INTO plaid_transactions (
          transaction_id,
          user_id,
          item_id,
          account_id,
          date,
          name,
          merchant_name,
          amount,
          pending,
          category_primary,
          raw_json,
          updated_at
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
        ON CONFLICT (transaction_id)
        DO UPDATE SET
          user_id = EXCLUDED.user_id,
          item_id = EXCLUDED.item_id,
          account_id = EXCLUDED.account_id,
          date = EXCLUDED.date,
          name = EXCLUDED.name,
          merchant_name = EXCLUDED.merchant_name,
          amount = EXCLUDED.amount,
          pending = EXCLUDED.pending,
          category_primary = EXCLUDED.category_primary,
          raw_json = EXCLUDED.raw_json,
          updated_at = NOW()
        `,
        [
          tx.transaction_id,
          userId,
          itemId,
          tx.account_id,
          tx.date || null,
          tx.name || null,
          tx.merchant_name || null,
          tx.amount ?? null,
          tx.pending ?? null,
          tx.personal_finance_category?.primary || null,
          JSON.stringify(tx),
        ]
      );
    }

    for (const tx of syncData.modified || []) {
      await client.query(
        `
        UPDATE plaid_transactions
        SET
          user_id = $2,
          item_id = $3,
          account_id = $4,
          date = $5,
          name = $6,
          merchant_name = $7,
          amount = $8,
          pending = $9,
          category_primary = $10,
          raw_json = $11,
          updated_at = NOW()
        WHERE transaction_id = $1
        `,
        [
          tx.transaction_id,
          userId,
          itemId,
          tx.account_id,
          tx.date || null,
          tx.name || null,
          tx.merchant_name || null,
          tx.amount ?? null,
          tx.pending ?? null,
          tx.personal_finance_category?.primary || null,
          JSON.stringify(tx),
        ]
      );
    }

    for (const removed of syncData.removed || []) {
      await client.query(
        `
        DELETE FROM plaid_transactions
        WHERE transaction_id = $1 AND user_id = $2
        `,
        [removed.transaction_id, userId]
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function getStoredTransactionsForUser(
  userId,
  startDate,
  endDate,
  selectedItemIds = null,
  selectedAccountIds = null
) {
  let query = `
    SELECT
      t.transaction_id,
      t.account_id,
      t.item_id AS _item_id,
      t.date,
      t.name,
      t.merchant_name,
      t.amount,
      t.pending,
      t.category_primary,
      a.institution_name AS _institution_name,
      a.name AS _account_name,
      a.mask AS _account_mask
    FROM plaid_transactions t
    LEFT JOIN plaid_accounts a
      ON t.account_id = a.account_id
    WHERE t.user_id = $1
      AND t.date >= $2
      AND t.date <= $3
  `;

  const params = [userId, startDate, endDate];
  let idx = 4;

  if (selectedItemIds && selectedItemIds.length > 0) {
    query += ` AND t.item_id = ANY($${idx}::text[])`;
    params.push(selectedItemIds);
    idx += 1;
  }

  if (selectedAccountIds && selectedAccountIds.length > 0) {
    query += ` AND t.account_id = ANY($${idx}::text[])`;
    params.push(selectedAccountIds);
    idx += 1;
  }

  query += ` ORDER BY t.date DESC`;

  const result = await pool.query(query, params);

  return result.rows.map((row) => ({
    transaction_id: row.transaction_id,
    account_id: row.account_id,
    _item_id: row._item_id,
    date: row.date,
    name: row.name,
    merchant_name: row.merchant_name,
    amount: row.amount,
    pending: row.pending,
    personal_finance_category: row.category_primary
      ? { primary: row.category_primary }
      : null,
    _institution_name: row._institution_name || null,
    _account_name: row._account_name || null,
    _account_mask: row._account_mask || null,
  }));
}

// =========================
// Plaid transaction helpers
// =========================
async function syncTransactionsForItem(itemRow, webhookCode = null) {
  const userId = itemRow.user_id;
  const itemId = itemRow.item_id;

  const syncState = await getItemSyncState(itemId);
  const originalCursor = syncState?.transactions_cursor || null;

  let cursor = originalCursor;
  let nextCursor = originalCursor;
  let hasMore = true;

  const accumulated = {
    added: [],
    modified: [],
    removed: [],
  };

  while (hasMore) {
    try {
      const response = await plaidClient.transactionsSync({
        access_token: itemRow.access_token,
        cursor,
      });

      const data = response.data;

      accumulated.added.push(...(data.added || []));
      accumulated.modified.push(...(data.modified || []));
      accumulated.removed.push(...(data.removed || []));

      nextCursor = data.next_cursor;
      hasMore = data.has_more;
      cursor = data.next_cursor;
    } catch (err) {
      const errorCode = err?.response?.data?.error_code;
      const errorType = err?.response?.data?.error_type;
      const requestId = err?.response?.data?.request_id;

      console.error("transactionsSync error:", {
        itemId,
        errorCode,
        errorType,
        requestId,
        message: err?.message,
      });

      if (errorCode === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") {
        cursor = originalCursor;
        nextCursor = originalCursor;
        hasMore = true;
        accumulated.added = [];
        accumulated.modified = [];
        accumulated.removed = [];
        continue;
      }

      throw err;
    }
  }

  await applyTransactionSyncUpdates(userId, itemId, accumulated);
  await upsertItemSyncState(userId, itemId, nextCursor, webhookCode);

  return {
    item_id: itemId,
    added: accumulated.added.length,
    modified: accumulated.modified.length,
    removed: accumulated.removed.length,
    next_cursor: nextCursor,
  };
}

async function requireSelectionOrAll(req, res) {
  const userId = getUserId(req);
  const selectedItemIds = getSelectedItemIds(req);
  const selectedAccountIds = getSelectedAccountIds(req);

  const items = await getUserItemsFiltered(userId, selectedItemIds);

  if (items.length === 0) {
    res.status(401).json({ error: "No selected bank connected." });
    return null;
  }

  if (selectedAccountIds && selectedAccountIds.length > 0) {
    const accounts = await getAccountsForUser(userId, selectedItemIds, selectedAccountIds);
    if (accounts.length === 0) {
      res.status(401).json({ error: "No selected accounts found." });
      return null;
    }
  }

  return { userId, selectedItemIds, selectedAccountIds, items };
}

async function initialFullTransactionSync(itemRow) {
  const userId = itemRow.user_id;
  const itemId = itemRow.item_id;

  const end = new Date();
  const start = new Date();
  start.setMonth(end.getMonth() - 6); // last 6 months

  const startDate = start.toISOString().slice(0, 10);
  const endDate = end.toISOString().slice(0, 10);

  const transactions = await getTransactionsForOneItem(
    itemRow,
    startDate,
    endDate
  );

  await applyTransactionSyncUpdates(userId, itemId, {
    added: transactions,
    modified: [],
    removed: [],
  });

  console.log(`Initial sync complete: ${transactions.length} transactions`);

  return transactions.length;
}

// =========================
// Apply limiters before routes
// =========================
app.use("/", generalLimiter);
app.use("/health", generalLimiter);
app.use("/connection_status", generalLimiter);
app.use("/connected_accounts", generalLimiter);
app.use("/alerts", generalLimiter);
app.use("/insights", generalLimiter);
app.use("/transactions_by_month", generalLimiter);
app.use("/money_insights", generalLimiter);
app.use("/category_chart", generalLimiter);
app.use("/weekly_summary", generalLimiter);
app.use("/spending_by_account", generalLimiter);

app.use("/create_link_token", plaidLimiter);
app.use("/exchange_public_token", plaidLimiter);
app.use("/sync_connected_accounts", plaidLimiter);
app.use("/sync_transactions", plaidLimiter);
app.use("/disconnect_bank", plaidLimiter);
app.use("/plaid/webhook", plaidLimiter);

app.use("/ai_recommendations", aiLimiter);
app.use("/ask_budget_ai", aiLimiter);

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

app.get("/connection_status", async (req, res) => {
  try {
    const userId = getUserId(req);
    const items = await getUserItems(userId);

    res.json({
      connected: items.length > 0,
      itemCount: items.length,
      items: items.map((item) => ({
        item_id: item.item_id,
        institution_id: item.institution_id,
        institution_name: item.institution_name,
      })),
    });
  } catch (err) {
    console.error("connection_status error:", err?.message || err);
    res.status(500).json({ error: "Failed to get connection status." });
  }
});

app.get("/connected_accounts", async (req, res) => {
  try {
    const userId = getUserId(req);
    const selectedItemIds = getSelectedItemIds(req);
    const selectedAccountIds = getSelectedAccountIds(req);

    const items = await getUserItemsFiltered(userId, selectedItemIds);
    const accounts = await getAccountsForUser(userId, selectedItemIds, selectedAccountIds);

    res.json({
      institutions: items.map((item) => ({
        item_id: item.item_id,
        institution_id: item.institution_id,
        institution_name: item.institution_name,
      })),
      accounts,
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("connected_accounts error:", err?.message || err);
    res.status(500).json({ error: "Failed to load connected accounts." });
  }
});

app.post("/sync_connected_accounts", async (req, res) => {
  try {
    const userId = getUserId(req);
    const items = await getUserItems(userId);

    if (items.length === 0) {
      return res.status(404).json({ error: "No connected banks found." });
    }

    let syncedItems = 0;
    let syncedAccounts = 0;

    for (const item of items) {
      const accountsResponse = await plaidClient.accountsGet({
        access_token: item.access_token,
      });

      const institutionName = item.institution_name || "Connected Bank";

      await replaceAccountsForItem(
        userId,
        item.item_id,
        institutionName,
        accountsResponse.data.accounts || []
      );

      syncedItems += 1;
      syncedAccounts += accountsResponse.data.accounts?.length || 0;
    }

    res.json({
      ok: true,
      syncedItems,
      syncedAccounts,
    });
  } catch (err) {
    console.error("sync_connected_accounts error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to sync connected accounts." });
  }
});

app.post("/create_link_token", async (req, res) => {
  try {
    const userId = getUserId(req);

    const requestBody = {
      user: {
        client_user_id: userId,
      },
      client_name: "BudgetSaver",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    };

    if (process.env.PLAID_WEBHOOK_URL) {
      requestBody.webhook = process.env.PLAID_WEBHOOK_URL;
    }

    const response = await plaidClient.linkTokenCreate(requestBody);

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

app.post("/sync_transactions", async (req, res) => {
  try {
    const userId = getUserId(req);
    const selectedItemIds = getSelectedItemIds(req);

    const items = await getUserItemsFiltered(userId, selectedItemIds);

    if (items.length === 0) {
      return res.status(404).json({ error: "No connected items found." });
    }

    const results = [];

    for (const item of items) {
  const syncState = await getItemSyncState(item.item_id);

  let result;

  if (!syncState) {
    // FIRST TIME → FULL LOAD
    console.log("🚀 Running initial full sync...");
    const count = await initialFullTransactionSync(item);

    result = {
      item_id: item.item_id,
      initial_sync: true,
      added: count,
    };
  } else {
    // NORMAL SYNC
    result = await syncTransactionsForItem(item);
  }

  results.push(result);
}

app.post("/exchange_public_token", async (req, res) => {
  try {
    const { public_token } = req.body;
    const userId = getUserId(req);

    if (!public_token) {
      return res.status(400).json({ error: "Missing public_token" });
    }

    const exchangeResponse = await plaidClient.itemPublicTokenExchange({
      public_token,
    });

    const accessToken = exchangeResponse.data.access_token;
    const itemId = exchangeResponse.data.item_id;

    let institutionId = null;
    let institutionName = "Connected Bank";

    try {
      const itemGetResponse = await plaidClient.itemGet({
        access_token: accessToken,
      });
      institutionId = itemGetResponse.data.item?.institution_id || null;
    } catch (err) {
      console.error("itemGet warning:", err?.response?.data || err?.message || err);
    }

    if (institutionId) {
      try {
        const instResponse = await plaidClient.institutionsGetById({
          institution_id: institutionId,
          country_codes: ["US"],
        });
        institutionName = instResponse.data.institution?.name || "Connected Bank";
      } catch (err) {
        console.error("institutionsGetById warning:", err?.response?.data || err?.message || err);
      }
    }

    await saveUserItem(userId, accessToken, itemId, institutionId, institutionName);

    let accounts = [];
    try {
      const accountsResponse = await plaidClient.accountsGet({
        access_token: accessToken,
      });

      accounts = accountsResponse.data.accounts || [];

      await replaceAccountsForItem(
        userId,
        itemId,
        institutionName,
        accounts
      );
    } catch (err) {
      console.error("accountsGet warning:", err?.response?.data || err?.message || err);
    }

    try {
      const linkedItem = await getUserItemByItemId(userId, itemId);
      if (linkedItem) {
        await syncTransactionsForItem(linkedItem);
      }
    } catch (err) {
      console.error("initial transaction sync warning:", err?.response?.data || err?.message || err);
    }

    res.json({
      ok: true,
      item_id: itemId,
      institution_id: institutionId,
      institution_name: institutionName,
      accounts_count: accounts.length,
    });
  } catch (err) {
    console.error("exchange_public_token error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to exchange public token.",
      details: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

app.post("/disconnect_bank", async (req, res) => {
  try {
    const userId = getUserId(req);
    const itemId = req.body?.item_id;

    if (!itemId) {
      return res.status(400).json({ error: "Missing item_id." });
    }

    const saved = await getUserItemByItemId(userId, itemId);

    if (!saved) {
      return res.status(404).json({ error: "Connected bank not found." });
    }

    try {
      await plaidClient.itemRemove({
        access_token: saved.access_token,
      });
    } catch {
      // ignore
    }

    await deleteUserItem(userId, itemId);

    res.json({ ok: true, message: "Bank disconnected.", item_id: itemId });
  } catch (err) {
    console.error("disconnect_bank error:", err?.message || err);
    res.status(500).json({ error: "Failed to disconnect bank." });
  }
});

app.get("/alerts", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();

    const currentTransactions = (await getStoredTransactionsForUser(
      userId,
      currentRange.start,
      currentRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getStoredTransactionsForUser(
      userId,
      previousRange.start,
      previousRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const totalSpent = currentTransactions.reduce((sum, tx) => sum + tx.amount, 0);
    const previousSpent = previousTransactions.reduce((sum, tx) => sum + tx.amount, 0);

    const alerts = buildRichAlerts(currentTransactions, previousTransactions);

    res.json({
      totalSpent: Number(totalSpent.toFixed(2)),
      previousSpent: Number(previousSpent.toFixed(2)),
      alerts,
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("alerts error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build alerts." });
  }
});

app.get("/insights", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;
    const range = getDateRangeLast30Days();

    const transactions = (await getStoredTransactionsForUser(
      userId,
      range.start,
      range.end,
      selectedItemIds,
      selectedAccountIds
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
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("insights error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build insights." });
  }
});

app.get("/transactions_by_month", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;

    const end = new Date();
    const start = new Date();
    start.setMonth(end.getMonth() - 6);

    const startDate = formatDate(start);
    const endDate = formatDate(end);

    const transactions = (await getStoredTransactionsForUser(
      userId,
      startDate,
      endDate,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    res.json(buildTransactionsByMonth(transactions, startDate, endDate));
  } catch (err) {
    console.error("transactions_by_month error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build transactions by month." });
  }
});

app.get("/money_insights", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();
    const sixMonthRange = getDateRangeLastSixMonths();

    const currentTransactions = (await getStoredTransactionsForUser(
      userId,
      currentRange.start,
      currentRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getStoredTransactionsForUser(
      userId,
      previousRange.start,
      previousRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const sixMonthTransactions = (await getStoredTransactionsForUser(
      userId,
      sixMonthRange.start,
      sixMonthRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const insightData = buildMoneyInsights(
      currentTransactions,
      previousTransactions,
      sixMonthTransactions
    );

    res.json({
      ...insightData,
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("money_insights error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build money insights." });
  }
});

app.get("/category_chart", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;
    const range = getDateRangeLast30Days();

    const transactions = (await getStoredTransactionsForUser(
      userId,
      range.start,
      range.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    res.json({
      categories: buildCategoryChartData(transactions),
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("category_chart error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build category chart." });
  }
});

app.get("/weekly_summary", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;

    const currentWeekRange = getDateRangeLast7Days();
    const previousWeekRange = getPrevious7DayRange();

    const currentWeekTransactions = (await getStoredTransactionsForUser(
      userId,
      currentWeekRange.start,
      currentWeekRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const previousWeekTransactions = (await getStoredTransactionsForUser(
      userId,
      previousWeekRange.start,
      previousWeekRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const summary = buildWeeklySummary(currentWeekTransactions, previousWeekTransactions);

    res.json({
      ...summary,
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("weekly_summary error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build weekly summary." });
  }
});

app.get("/ai_recommendations", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();
    const sixMonthRange = getDateRangeLastSixMonths();

    const currentTransactions = (await getStoredTransactionsForUser(
      userId,
      currentRange.start,
      currentRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getStoredTransactionsForUser(
      userId,
      previousRange.start,
      previousRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const sixMonthTransactions = (await getStoredTransactionsForUser(
      userId,
      sixMonthRange.start,
      sixMonthRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const moneyInsights = buildMoneyInsights(
      currentTransactions,
      previousTransactions,
      sixMonthTransactions
    );

    if (!openai) {
      return res.json({
        source: "rule_engine",
        recommendations: moneyInsights.actionItems.map((item) => ({
          title: "Recommended next step",
          message: item,
        })),
        selectedItemCount: selectedItemIds?.length || null,
        selectedAccountCount: selectedAccountIds?.length || null,
      });
    }

    const prompt = `
You are BudgetSaver AI, a practical personal finance coach.

Use only the data provided.
Do not invent numbers or merchants.
Give 3 short, specific recommendations.
Each recommendation should have:
- title
- message

Return valid JSON in this exact format:
{
  "recommendations": [
    { "title": "string", "message": "string" },
    { "title": "string", "message": "string" },
    { "title": "string", "message": "string" }
  ]
}

Data:
${JSON.stringify(moneyInsights, null, 2)}
`;

    const response = await openai.responses.create({
      model: "gpt-5.4",
      input: prompt,
    });

    const raw = response.output_text?.trim() || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {
        recommendations: moneyInsights.actionItems.slice(0, 3).map((item) => ({
          title: "Recommended next step",
          message: item,
        })),
      };
    }

    res.json({
      source: "openai",
      recommendations: Array.isArray(parsed.recommendations)
        ? parsed.recommendations.slice(0, 3)
        : [],
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("ai_recommendations error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build AI recommendations." });
  }
});

app.post("/ask_budget_ai", async (req, res) => {
  try {
    const userId = getUserId(req);
    const selectedItemIds = getSelectedItemIds(req);
    const selectedAccountIds = getSelectedAccountIds(req);
    const question = String(req.body?.question || "").trim();

    const items = await getUserItemsFiltered(userId, selectedItemIds);

    if (items.length === 0) {
      return res.status(401).json({ error: "No selected bank connected." });
    }

    if (selectedAccountIds && selectedAccountIds.length > 0) {
      const accounts = await getAccountsForUser(userId, selectedItemIds, selectedAccountIds);
      if (accounts.length === 0) {
        return res.status(401).json({ error: "No selected accounts found." });
      }
    }

    if (!question) {
      return res.status(400).json({ error: "Missing question." });
    }

    const currentRange = getDateRangeLast30Days();
    const previousRange = getPrevious30DayRange();
    const sixMonthRange = getDateRangeLastSixMonths();

    const currentTransactions = (await getStoredTransactionsForUser(
      userId,
      currentRange.start,
      currentRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const previousTransactions = (await getStoredTransactionsForUser(
      userId,
      previousRange.start,
      previousRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const sixMonthTransactions = (await getStoredTransactionsForUser(
      userId,
      sixMonthRange.start,
      sixMonthRange.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const moneyInsights = buildMoneyInsights(
      currentTransactions,
      previousTransactions,
      sixMonthTransactions
    );

    const result = buildBudgetAIResponse(question, moneyInsights);

    res.json({
      question,
      answer: result.answer,
      score: result.score,
      suggestions: result.suggestions,
      source: "rule_engine",
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("ask_budget_ai error:", err?.response?.data || err?.message || err);
    res.status(500).json({
      error: "Failed to answer budget question.",
      details: err?.response?.data || err?.message || "Unknown error",
    });
  }
});

app.post("/plaid/webhook", async (req, res) => {
  try {
    const body = req.body;

    console.log("Plaid webhook received:", {
      webhook_type: body.webhook_type,
      webhook_code: body.webhook_code,
      item_id: body.item_id,
    });

    if (
      body.webhook_type === "TRANSACTIONS" &&
      body.webhook_code === "SYNC_UPDATES_AVAILABLE" &&
      body.item_id
    ) {
      const result = await pool.query(
        `
        SELECT id, user_id, item_id, access_token, institution_id, institution_name
        FROM plaid_items
        WHERE item_id = $1
        LIMIT 1
        `,
        [body.item_id]
      );

      const item = result.rows[0];

      if (item) {
        await syncTransactionsForItem(item, body.webhook_code);
      }
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("plaid webhook error:", err?.response?.data || err?.message || err);
    res.sendStatus(200);
  }
});

app.get("/spending_by_account", async (req, res) => {
  try {
    const ctx = await requireSelectionOrAll(req, res);
    if (!ctx) return;

    const { userId, selectedItemIds, selectedAccountIds } = ctx;
    const range = getDateRangeLast30Days();

    const transactions = (await getStoredTransactionsForUser(
      userId,
      range.start,
      range.end,
      selectedItemIds,
      selectedAccountIds
    )).filter(isDebitLikeTransaction);

    const accounts = await getAccountsForUser(userId, selectedItemIds, selectedAccountIds);

    const grouped = {};

    for (const account of accounts) {
      grouped[account.account_id] = {
        account_id: account.account_id,
        item_id: account.item_id,
        institution_name: account.institution_name || "Connected Bank",
        name: account.name || account.official_name || "Account",
        mask: account.mask || null,
        type: account.type || null,
        subtype: account.subtype || null,
        current_balance: account.current_balance ?? null,
        available_balance: account.available_balance ?? null,
        spent_30d: 0,
        transaction_count: 0,
      };
    }

    for (const tx of transactions) {
      if (!grouped[tx.account_id]) continue;
      grouped[tx.account_id].spent_30d += tx.amount;
      grouped[tx.account_id].transaction_count += 1;
    }

    const accountsWithSpending = Object.values(grouped)
      .map((account) => ({
        ...account,
        spent_30d: Number(account.spent_30d.toFixed(2)),
      }))
      .sort((a, b) => b.spent_30d - a.spent_30d);

    res.json({
      accounts: accountsWithSpending,
      selectedItemCount: selectedItemIds?.length || null,
      selectedAccountCount: selectedAccountIds?.length || null,
    });
  } catch (err) {
    console.error("spending_by_account error:", err?.response?.data || err?.message || err);
    res.status(500).json({ error: "Failed to build spending by account." });
  }
});

app.get("/debug_transaction_count", async (req, res) => {
  try {
    const userId = getUserId(req);

    const txCountResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM plaid_transactions
      WHERE user_id = $1
      `,
      [userId]
    );

    const itemCountResult = await pool.query(
      `
      SELECT COUNT(*)::int AS count
      FROM plaid_items
      WHERE user_id = $1
      `,
      [userId]
    );

    res.json({
      userId,
      itemCount: itemCountResult.rows[0].count,
      transactionCount: txCountResult.rows[0].count,
    });
  } catch (err) {
    console.error("debug_transaction_count error:", err?.message || err);
    res.status(500).json({ error: "Failed to debug transaction count." });
  }
});

// =========================
// Start server
// =========================
async function startServer() {
  try {
    await initDatabase();

    app.listen(PORT, () => {
      console.log(`BudgetSaver backend running on port ${PORT}`);
    });
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

startServer();
