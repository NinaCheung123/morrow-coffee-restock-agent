import assert from "node:assert/strict";
import { test } from "node:test";
import { checkQuote, requestQuotes, validateRules, type Rules } from "../src/restock.js";
import { toSuggestion } from "../src/interpret.js";

const rules = (over: Partial<Rules> = {}): Rules => ({
  request: "Two bags, medium-dark, one time.", mode: "confirm", brandIds: ["morrow", "daybreak"],
  productIds: ["morrow-house", "morrow-seasonal", "daybreak-house"], quantity: 2, targetCents: 3700, capCents: 4500,
  deliveryDays: 14, region: "US-CA", currency: "USD", oneTime: true, notificationTime: "18:00", ...over,
});

test("each approved roaster returns one quote that adds up", () => {
  const quotes = requestQuotes(rules());
  assert.equal(quotes.length, 2);
  for (const q of quotes) assert.equal(q.totalCents, q.subtotalCents + q.shippingCents + q.taxCents);
});

test("a quote above the approved maximum never qualifies", () => {
  const quotes = requestQuotes(rules({ targetCents: 3000, capCents: 3500 }));
  assert.ok(quotes.every(q => !q.qualifies && q.reasons.includes("Above your approved payment maximum")));
});

test("a quote that arrives after the deadline never qualifies", () => {
  const quotes = requestQuotes(rules({ deliveryDays: 3 }));
  assert.ok(quotes.every(q => q.reasons.includes("Arrives after your deadline")));
});

test("a roaster the buyer did not approve is not asked", () => {
  const quotes = requestQuotes(rules({ brandIds: ["morrow"], productIds: ["morrow-house"] }));
  assert.deepEqual(quotes.map(q => q.brandId), ["morrow"]);
});

test("an expired or tampered quote is rejected", () => {
  const r = rules(); const [q] = requestQuotes(r, 0);
  assert.ok(checkQuote(r, q, Date.now()).includes("Quote expired"));
  const [fresh] = requestQuotes(r);
  assert.ok(checkQuote(r, { ...fresh, totalCents: fresh.totalCents - 100 }).includes("Quote does not add up"));
  assert.ok(checkQuote(r, { ...fresh, subscription: true as never }).includes("Requires a subscription"));
});

test("the target can't exceed the maximum, and the maximum is capped", () => {
  assert.throws(() => validateRules(rules({ targetCents: 5000, capCents: 4500 })));
  assert.throws(() => validateRules(rules({ capCents: 30000 })));
});

test("the AI reading becomes numbers in code, and unknown products are dropped", () => {
  const s = toSuggestion({ understood: "You want two bags.", cupsPerDayMin: 1, cupsPerDayMax: 2, daysOfCoffeeLeft: 14,
    productIds: ["morrow-house", "made-up-product"], wantsAutomaticPurchase: false, unsure: [] });
  assert.deepEqual(s.productIds, ["morrow-house"]);
  assert.equal(s.quantity, 2);
  assert.equal(s.deliveryDays, 14);
  assert.equal(s.mode, "confirm");
  assert.ok(!("targetCents" in s) && !("capCents" in s));
});

test("an unclear reading falls back to safe defaults", () => {
  const s = toSuggestion({ understood: "", cupsPerDayMin: null, cupsPerDayMax: null, daysOfCoffeeLeft: 5,
    productIds: [], wantsAutomaticPurchase: false, unsure: [] });
  assert.equal(s.quantity, 2);
  assert.equal(s.deliveryDays, 5);
});
