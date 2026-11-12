import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RestockService, RestockStore, resetOfferRules, type Rules } from "../src/restock.js";

const rules: Rules = { request: "Two bags, one time.", mode: "confirm", brandIds: ["morrow", "daybreak"],
  productIds: ["morrow-house", "morrow-seasonal", "daybreak-house"], quantity: 2, targetCents: 3700, capCents: 4500,
  deliveryDays: 14, region: "US-CA", currency: "USD", oneTime: true, notificationTime: "18:00" };

/** A stand-in for PayPal that records calls, so failures can be forced without real money. */
function fakePayPal(opts: { captureFails?: boolean; amount?: string } = {}) {
  const calls = { create: 0, capture: 0 }; let taskId = ""; let captured = false;
  const unit = () => ({ custom_id: taskId, amount: { currency_code: "USD", value: opts.amount ?? "36.00" }, payee: { merchant_id: "M1" },
    payments: captured ? { captures: [{ id: "CAP1", status: "COMPLETED", amount: { currency_code: "USD", value: "36.00" } }] } : undefined });
  return { calls, client: {
    async createDirectOrder(input: { reference: string }) { calls.create++; taskId = input.reference;
      return { id: "ORDER1", purchase_units: [{ payee: { merchant_id: "M1" } }], links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }; },
    async getOrder() { return { id: "ORDER1", status: captured ? "COMPLETED" : "APPROVED", purchase_units: [unit()] }; },
    async captureOrder() { calls.capture++; if (opts.captureFails) throw new Error("INSTRUMENT_DECLINED"); captured = true; return {}; },
  } };
}
async function toCheckout(fake: ReturnType<typeof fakePayPal>) {
  resetOfferRules();
  const store = new RestockStore(join(mkdtempSync(join(tmpdir(), "pipbuy-")), "tasks.json"));
  const service = new RestockService(store, fake.client as never, "http://localhost:4030");
  const t = service.create("owner", rules);
  await service.scan(t.id); await service.checkout(t.id);
  return { service, id: t.id };
}

test("a declined capture goes to review, marks nothing paid, and never creates a second order", async () => {
  const fake = fakePayPal({ captureFails: true });
  const { service, id } = await toCheckout(fake);
  const first = await service.finishPayment(id);
  assert.equal(first.status, "needs_review"); assert.equal(first.paidCents, undefined); assert.equal(first.captureId, undefined);
  await service.finishPayment(id);
  await assert.rejects(service.checkout(id));
  assert.equal(fake.calls.create, 1);
});

test("an order whose amount differs from the quote is never captured", async () => {
  const fake = fakePayPal({ amount: "99.00" });
  const { service, id } = await toCheckout(fake);
  const t = await service.finishPayment(id);
  assert.equal(t.status, "needs_review"); assert.equal(fake.calls.capture, 0);
});

test("a successful payment is captured once, even if the buyer returns twice", async () => {
  const fake = fakePayPal();
  const { service, id } = await toCheckout(fake);
  const paid = await service.finishPayment(id);
  assert.equal(paid.status, "purchased"); assert.equal(paid.paidCents, 3600); assert.equal(paid.captureId, "CAP1");
  await service.finishPayment(id);
  await assert.rejects(service.scan(id));
  assert.equal(fake.calls.capture, 1); assert.equal(fake.calls.create, 1);
});
