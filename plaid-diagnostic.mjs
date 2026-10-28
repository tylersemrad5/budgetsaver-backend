import "dotenv/config";
import plaid from "plaid";

const {
  Configuration,
  PlaidApi,
  PlaidEnvironments
} = plaid;

const enabled =
  process.env.RUN_PLAID_DIAGNOSTIC === "true";

async function runDiagnostic() {
  if (!enabled) {
    console.log("[Plaid Diagnostic] Not enabled.");
    return;
  }

  console.log("[Plaid Diagnostic] Starting Production check.");

  if (process.env.PLAID_ENV !== "production") {
    console.log(
      "[Plaid Diagnostic] SKIPPED: Environment is not Production."
    );
    return;
  }

  const clientId = process.env.PLAID_CLIENT_ID;
  const secret = process.env.PLAID_SECRET;

  if (!clientId || !secret) {
    console.log(
      "[Plaid Diagnostic] FAILED: Missing Plaid credentials."
    );
    return;
  }

  const client = new PlaidApi(new Configuration({
    basePath: PlaidEnvironments.production,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": clientId,
        "PLAID-SECRET": secret,
        "Plaid-Version": "2020-09-14"
      }
    }
  }));

  try {
    const response = await client.linkTokenCreate({
      client_name: "BudgetSaver",
      language: "en",
      country_codes: ["US"],
      user: {
        client_user_id: "budgetsaver-production-diagnostic"
      },
      products: ["transactions"],
      webhook:
        "https://budgetsaver-backend.onrender.com/plaid/webhook",
      hosted_link: {
        url_lifetime_seconds: 900,
        completion_redirect_uri:
          "https://budgetsaver-backend.onrender.com/connect-bank"
      }
    });

    const linkToken = response.data?.link_token;
    const hostedURL = response.data?.hosted_link_url;

    if (
      typeof linkToken !== "string" ||
      typeof hostedURL !== "string"
    ) {
      console.log(
        "[Plaid Diagnostic] FAILED: Incomplete Plaid response."
      );
      return;
    }

    const url = new URL(hostedURL);

    if (
      url.protocol !== "https:" ||
      url.hostname !== "secure.plaid.com"
    ) {
      console.log(
        "[Plaid Diagnostic] FAILED: Unexpected Hosted Link URL."
      );
      return;
    }

    console.log(
      "[Plaid Diagnostic] SUCCESS: Production Hosted Link created."
    );
    console.log(
      "[Plaid Diagnostic] URL and tokens intentionally hidden."
    );
    console.log(
      "[Plaid Diagnostic] No bank account was connected."
    );
  } catch (error) {
    const plaidError = error?.response?.data;

    console.log(
      "[Plaid Diagnostic] FAILED."
    );

    console.log(
      "[Plaid Diagnostic] Code:",
      typeof plaidError?.error_code === "string"
        ? plaidError.error_code
        : "UNKNOWN"
    );

    console.log(
      "[Plaid Diagnostic] Type:",
      typeof plaidError?.error_type === "string"
        ? plaidError.error_type
        : "UNKNOWN"
    );
  }
}

await runDiagnostic();
