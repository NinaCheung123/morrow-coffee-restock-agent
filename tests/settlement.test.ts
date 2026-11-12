import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { centsToUsd, usdToCents } from "../src/money.js";
import type { PayPalClient } from "../src/paypal.js";
import { Settlement, SettlementError } from "../src/settlement.js";
import { IntentStore } from "../src/store.js";

function setup(overrides: Partial<Record<keyof PayPalClient, unknown>> = {}) {
  const calls: { name: string; args: unknown[] }[] = [];
  const record = (name: string, result: (...args: any[]) => unknown) => async (...args: unknown[]) => {
    calls.push({ name, args });
    return result(...args);
  };
  const paypal = {
    createHoldOrder: record("createHoldOrder", () => ({ orderId: "ORDER", approveUrl: "https://approve" })),
    authorizeOrder: record("authorizeOrder", () => ({ authorizationId: "AUTH", amountCents: 2500 })),
    captureAuthorization: record("captureAuthorization", (_a, cents) => ({ captureId: "CAP", status: "COMPLETED", amountCents: cents })),
    voidAuthorization: record("voidAuthorization", () => undefined),
    createPayout: record("createPayout", () => ({ payoutBatchId: "BATCH", batchStatus: "PENDING" })),
    ...overrides,
  } as unknown as PayPalClient;
  const path = join(mkdtempSync(join(tmpdir(), "intent-")), "intents.jsonl");
  const store = new IntentStore(path);
  return { calls, store, path, settlement: new Settlement(store, paypal, "http://test") };
}

const deal = { finalCents: 2140, merchantEmail: "m@example.com", merchantPayoutCents: 2000 };
const count = (calls: { name: string }[], name: string) => calls.filter((c) => c.name === name).length;

async function held(s: ReturnType<typeof setup>) {
  const intent = await s.settlement.open({ description: "detergent", capCents: 2500 });
  await s.settlement.hold(intent.id);
  return intent.id;
}

test("money converts without rounding errors", () => {
  assert.equal(centsToUsd(2140), "21.40");
  assert.equal(centsToUsd(5), "0.05");
  assert.equal(usdToCents("21.4"), 2140);
  assert.equal(usdToCents("19.99"), 1999);
  assert.throws(() => usdToCents("1.999"));
  assert.throws(() => usdToCents("-1"));
});

test("a matched intent charges the final price and pays the merchant", async () => {
  const s = setup();
  const id = await held(s);
  const done = await s.settlement.closeMatched(id, deal);
  assert.equal(done.status, "paid_out");
  assert.equal(s.calls.find((c) => c.name === "captureAuthorization")!.args[1], 2140);
});

test("never charges above the cap", async () => {
  const s = setup();
  const id = await held(s);
  await assert.rejects(s.settlement.closeMatched(id, { ...deal, finalCents: 2501 }), SettlementError);
  assert.equal(count(s.calls, "captureAuthorization"), 0);
});

test("never pays a merchant more than the buyer paid", async () => {
  const s = setup();
  const id = await held(s);
  await assert.rejects(s.settlement.closeMatched(id, { ...deal, merchantPayoutCents: 2141 }), SettlementError);
  assert.equal(count(s.calls, "captureAuthorization"), 0);
});

test("a finished intent can't be charged twice", async () => {
  const s = setup();
  const id = await held(s);
  await s.settlement.closeMatched(id, deal);
  await assert.rejects(s.settlement.closeMatched(id, deal), SettlementError);
  assert.equal(count(s.calls, "captureAuthorization"), 1);
  assert.equal(count(s.calls, "createPayout"), 1);
});

test("a retry after a failed capture reuses the same PayPal request id", async () => {
  let attempts = 0;
  const seen: string[] = [];
  const s = setup({
    captureAuthorization: async (_a: string, cents: number, requestId: string) => {
      seen.push(requestId);
      if (++attempts === 1) throw new Error("network dropped");
      return { captureId: "CAP", status: "COMPLETED", amountCents: cents };
    },
  });
  const id = await held(s);
  await assert.rejects(s.settlement.closeMatched(id, deal));
  assert.equal(s.store.get(id)!.status, "capture_requested");
  const done = await s.settlement.closeMatched(id, deal);
  assert.equal(done.status, "paid_out");
  assert.equal(seen[0], seen[1]);
});

test("the final price can't change between retries", async () => {
  const s = setup({
    captureAuthorization: async () => {
      throw new Error("network dropped");
    },
  });
  const id = await held(s);
  await assert.rejects(s.settlement.closeMatched(id, deal));
  await assert.rejects(s.settlement.closeMatched(id, { ...deal, finalCents: 2000 }), SettlementError);
});

test("a failed payout goes to review and is never resent", async () => {
  let payouts = 0;
  const s = setup({
    createPayout: async () => {
      payouts++;
      throw new Error("timeout");
    },
  });
  const id = await held(s);
  const first = await s.settlement.closeMatched(id, deal);
  assert.equal(first.status, "needs_review");
  await assert.rejects(s.settlement.closeMatched(id, deal), SettlementError);
  assert.equal(payouts, 1);
});

test("a crash just before the payout result goes to review on restart", async () => {
  const s = setup();
  const id = await held(s);
  s.store.put({ ...s.store.get(id)!, status: "payout_requested", finalCents: 2140, captureId: "CAP" });
  const reloaded = new IntentStore(s.path);
  assert.equal(reloaded.get(id)!.status, "payout_requested");
  const done = await s.settlement.closeMatched(id, deal);
  assert.equal(done.status, "needs_review");
  assert.equal(count(s.calls, "createPayout"), 0);
});

test("no match releases the hold, and it can't be charged afterwards", async () => {
  const s = setup();
  const id = await held(s);
  assert.equal((await s.settlement.closeUnmatched(id)).status, "voided");
  await assert.rejects(s.settlement.closeMatched(id, deal), SettlementError);
  assert.equal(count(s.calls, "captureAuthorization"), 0);
});

test("the hold must match the cap", async () => {
  const s = setup({ authorizeOrder: async () => ({ authorizationId: "AUTH", amountCents: 9999 }) });
  const intent = await s.settlement.open({ description: "detergent", capCents: 2500 });
  await assert.rejects(s.settlement.hold(intent.id), SettlementError);
});

test("returning from PayPal twice places only one hold", async () => {
  const s = setup();
  const id = await held(s);
  await s.settlement.hold(id);
  assert.equal(count(s.calls, "authorizeOrder"), 1);
});
