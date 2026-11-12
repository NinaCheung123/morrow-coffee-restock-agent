// Proves the intent-market money flow in the PayPal sandbox, using test funds only.
//   node scripts/gate.mjs create   -> makes two orders and prints approval links
//   node scripts/gate.mjs finish   -> hold both, capture one below the cap, void one, pay out
// Prints statuses and ids only, never keys or tokens.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

process.loadEnvFile(".env.sandbox");
const id = process.env.PAYPAL_SANDBOX_CLIENT_ID?.trim();
const secret = process.env.PAYPAL_SANDBOX_CLIENT_SECRET?.trim();
if (!id || !secret) throw new Error("Fill both sandbox values in .env.sandbox");

const BASE = "https://api-m.sandbox.paypal.com";
const STATE = ".gate-state.json";
const CAP = "25.00";
const WINNING_BID = "21.40";

const tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    "content-type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) throw new Error(`token failed: ${tokenRes.status}`);
const { access_token: token } = await tokenRes.json();

async function call(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "paypal-request-id": randomUUID(),
      prefer: "return=representation",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text.slice(0, 200) };
  }
  return { status: res.status, ok: res.ok, json };
}

const describeError = (r) =>
  JSON.stringify({ status: r.status, name: r.json.name, message: r.json.message, details: r.json.details });

async function create() {
  const makeOrder = async (ref) => {
    const r = await call("POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: ref, description: "Intent market gate test", amount: { currency_code: "USD", value: CAP } }],
      payment_source: {
        paypal: {
          experience_context: {
            return_url: "https://example.com/approved",
            cancel_url: "https://example.com/cancelled",
            user_action: "CONTINUE",
            shipping_preference: "NO_SHIPPING",
          },
        },
      },
    });
    if (!r.ok) throw new Error(`create ${ref} failed: ${describeError(r)}`);
    const link = r.json.links.find((l) => l.rel === "payer-action" || l.rel === "approve");
    console.log(`${ref}: order ${r.json.id} status ${r.json.status}`);
    console.log(`APPROVE ${ref}: ${link.href}`);
    return r.json.id;
  };
  const state = { matched: await makeOrder("matched"), unmatched: await makeOrder("unmatched") };
  writeFileSync(STATE, JSON.stringify(state));
}

async function finish() {
  if (!existsSync(STATE)) throw new Error("run create first");
  const state = JSON.parse(readFileSync(STATE, "utf8"));

  const hold = async (orderId, label) => {
    const r = await call("POST", `/v2/checkout/orders/${orderId}/authorize`, {});
    if (!r.ok) throw new Error(`hold ${label} failed: ${describeError(r)}`);
    const auth = r.json.purchase_units[0].payments.authorizations[0];
    console.log(`hold ${label}: ${auth.status} ${auth.amount.value} ${auth.amount.currency_code}`);
    return { auth, payer: r.json.payer };
  };
  const matched = await hold(state.matched, "matched");
  const unmatched = await hold(state.unmatched, "unmatched");

  const capture = await call("POST", `/v2/payments/authorizations/${matched.auth.id}/capture`, {
    amount: { currency_code: "USD", value: WINNING_BID },
    final_capture: true,
  });
  if (!capture.ok) throw new Error(`capture failed: ${describeError(capture)}`);
  console.log(`capture below cap: ${capture.json.status} ${capture.json.amount.value}`);

  const voided = await call("POST", `/v2/payments/authorizations/${unmatched.auth.id}/void`);
  if (!voided.ok) throw new Error(`void failed: ${describeError(voided)}`);
  const readBack = await call("GET", `/v2/payments/authorizations/${unmatched.auth.id}`);
  console.log(`void: http ${voided.status}, read back status ${readBack.json.status}`);

  // The buyer's sandbox account stands in for the winning merchant in this test.
  const payout = await call("POST", "/v1/payments/payouts", {
    sender_batch_header: { sender_batch_id: `gate-${randomUUID()}`, email_subject: "Intent market gate test" },
    items: [{
      recipient_type: "EMAIL",
      receiver: matched.payer.email_address,
      amount: { value: "20.00", currency: "USD" },
      note: "Winning merchant payout, sandbox test",
      sender_item_id: `item-${randomUUID()}`,
    }],
  });
  if (!payout.ok) throw new Error(`payout failed: ${describeError(payout)}`);
  const batchId = payout.json.batch_header.payout_batch_id;
  console.log(`payout created: ${payout.json.batch_header.batch_status}`);
  for (let i = 0; i < 6; i++) {
    await new Promise((done) => setTimeout(done, 5000));
    const r = await call("GET", `/v1/payments/payouts/${batchId}`);
    const batch = r.json.batch_header?.batch_status;
    const item = r.json.items?.[0]?.transaction_status;
    console.log(`payout read back: batch ${batch}, item ${item}`);
    if (batch === "SUCCESS" || batch === "DENIED") break;
  }
}

async function status() {
  const state = JSON.parse(readFileSync(STATE, "utf8"));
  for (const [label, orderId] of Object.entries(state)) {
    const r = await call("GET", `/v2/checkout/orders/${orderId}`);
    console.log(`${label}: http ${r.status}, status ${r.json.status}, payer attached: ${Boolean(r.json.payer)}, created ${r.json.create_time}`);
  }
}

const step = process.argv[2];
if (step === "status") await status();
else if (step === "create") await create();
else if (step === "finish") await finish();
else console.log("usage: node scripts/gate.mjs create|finish");
