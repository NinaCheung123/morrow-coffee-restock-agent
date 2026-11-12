import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toStaySuggestion } from "../src/interpret.js";
import { HOTELS, StayService, StayStore, getHotelRules, nightlyOfferCents, offerRequestFor, resetHotelRules, setHotelRule, totals, type StayRules } from "../src/stay.js";

const rules = (over: Partial<StayRules> = {}): StayRules => ({ request: "Two nights in Lisbon.", hotelIds: ["aurora", "miradouro", "tejo"],
  nights: 2, guests: 2, mustHaves: [], targetCents: 40000, capCents: 46000, startDays: 21, ...over });

/** A stand-in for PayPal that keeps the state of one order, so every payment path can be forced. */
function fakePayPal(opts: { captureFails?: boolean } = {}) {
  const calls = { create: 0, authorize: 0, capture: 0, void: 0, refund: 0 };
  let ref = "", total = "0.00", orderStatus = "APPROVED", authStatus = "", capStatus = "", capAmount = "0.00", refunded = 0;
  const usd = (c: number) => `${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
  return { calls, client: {
    async createStayOrder(i: { reference: string; cents: number }) { calls.create++; ref = i.reference; total = usd(i.cents);
      return { id: "ORDER1", purchase_units: [{ payee: { merchant_id: "HOTEL1" } }], links: [{ rel: "payer-action", href: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER1" }] }; },
    async getOrder() { return { id: "ORDER1", intent: "AUTHORIZE", status: orderStatus, purchase_units: [{ custom_id: ref, amount: { currency_code: "USD", value: total }, payee: { merchant_id: "HOTEL1" },
      payments: authStatus ? { authorizations: [{ id: "AUTH1" }] } : undefined }] }; },
    async authorizeOrder() { calls.authorize++; orderStatus = "COMPLETED"; authStatus = "CREATED"; return { authorizationId: "AUTH1", amountCents: Math.round(Number(total) * 100) }; },
    async getAuthorization() { return { id: "AUTH1", status: authStatus, amount: { currency_code: "USD", value: total } }; },
    async captureAuthorization(_id: string, cents: number) { calls.capture++; if (opts.captureFails) throw new Error("INSTRUMENT_DECLINED");
      capStatus = "COMPLETED"; capAmount = usd(cents); authStatus = cents === Math.round(Number(total) * 100) ? "CAPTURED" : "PARTIALLY_CAPTURED"; return { captureId: "CAP1", status: "COMPLETED", amountCents: cents }; },
    async getCapture() { return { id: "CAP1", status: capStatus, amount: { currency_code: "USD", value: capAmount } }; },
    async voidAuthorization() { calls.void++; authStatus = "VOIDED"; },
    async refundCapture(_id: string, cents: number) { calls.refund++; refunded += cents; capStatus = refunded === Math.round(Number(capAmount) * 100) ? "REFUNDED" : "PARTIALLY_REFUNDED"; return { id: "REF1", status: "COMPLETED" }; },
  } };
}
function setup(fake = fakePayPal(), over: Partial<StayRules> = {}) {
  resetHotelRules();
  const service = new StayService(new StayStore(join(mkdtempSync(join(tmpdir(), "pipstay-")), "stays.json")), fake.client as never, "http://localhost:4030");
  return { fake, service, id: service.create("owner", rules(over)).id };
}

test("a hotel's private rate slides from its public rate to its floor as check-in approaches", () => {
  resetHotelRules(); const a = HOTELS[0], rule = getHotelRules().aurora;
  assert.deepEqual([21, 14, 10, 5, 3, 0].map(d => nightlyOfferCents(a.listCents, rule, d)), [21000, 21000, 19300, 17100, 16300, 15000]);
});

test("three rounds: over the maximum, then above target, then the lowest offer meets the target", async () => {
  const { service, id } = setup();
  let t = await service.ask(id);
  const at = (hotel: string) => t.rounds.at(-1)!.offers.find(o => o.hotelId === hotel)!;
  assert.equal(at("aurora").totalCents, 46200); assert.equal(at("aurora").qualifies, false);
  assert.equal(at("miradouro").totalCents, 41800); assert.equal(at("miradouro").meetsTarget, false);
  assert.equal(t.selectedOfferId, at("miradouro").id);
  t = await service.ask(id, 11); assert.equal(t.daysToCheckIn, 10); assert.equal(at("aurora").totalCents, 42460);
  t = await service.ask(id, 5); assert.equal(t.daysToCheckIn, 5);
  assert.equal(at("aurora").totalCents, 37620); assert.equal(at("aurora").meetsTarget, true);
  assert.equal(t.selectedOfferId, at("aurora").id); assert.equal(t.rounds.length, 3);
});

test("the request a hotel receives never contains the target or the maximum", () => {
  const text = JSON.stringify(offerRequestFor(rules({ targetCents: 34567, capCents: 45678 }), 5));
  assert.ok(!text.includes("34567") && !text.includes("45678") && !/target|cap|max/i.test(text));
});

test("a must-have removes hotels that lack it", async () => {
  const { service, id } = setup(fakePayPal(), { mustHaves: ["river_view"], capCents: 60000 });
  const t = await service.ask(id);
  assert.deepEqual(t.rounds[0].offers.filter(o => o.qualifies).map(o => o.hotelId).sort(), ["miradouro", "tejo"]);
});

test("more than 3 days out: paid at booking, and free cancellation refunds in full", async () => {
  const { fake, service, id } = setup();
  await service.ask(id, 16); await service.book(id);
  let t = await service.finishApproval(id);
  assert.equal(t.plan, "pay_now"); assert.equal(t.status, "paid");
  assert.deepEqual(t.ledger.map(e => [e.type, e.amountCents, e.verified]), [["AUTHORIZED", 37620, true], ["CAPTURED", 37620, true]]);
  t = await service.cancel(id);
  assert.equal(t.status, "refunded"); assert.deepEqual(totals(t), { heldCents: 0, chargedCents: 37620, refundedCents: 37620, netPaidCents: 0 });
  assert.equal(fake.calls.refund, 1);
});

test("a late cancellation of a paid stay refunds everything except the first night", async () => {
  const { service, id } = setup();
  await service.ask(id, 16); await service.book(id); await service.finishApproval(id);
  await service.advance(id, 3);
  const t = await service.cancel(id);
  assert.equal(t.status, "refunded"); assert.equal(totals(t).netPaidCents, 18810); assert.equal(t.ledger.at(-1)!.amountCents, 18810);
});

test("the hotel cancelling a paid stay always refunds in full", async () => {
  const { service, id } = setup();
  await service.ask(id, 16); await service.book(id); await service.finishApproval(id); await service.advance(id, 4);
  const t = await service.cancel(id, "hotel");
  assert.equal(totals(t).netPaidCents, 0);
});

test("within 3 days: the amount is held, not charged, and free cancellation releases it", async () => {
  const { fake, service, id } = setup(fakePayPal(), { startDays: 3 });
  await service.ask(id); await service.book(id);
  let t = await service.finishApproval(id);
  assert.equal(t.plan, "hold"); assert.equal(t.status, "held");
  assert.deepEqual(totals(t), { heldCents: 35860, chargedCents: 0, refundedCents: 0, netPaidCents: 0 });
  t = await service.cancel(id);
  assert.equal(t.status, "voided"); assert.equal(totals(t).chargedCents, 0); assert.equal(fake.calls.void, 1); assert.equal(fake.calls.capture, 0);
});

test("a late cancellation of a held stay charges only the first night", async () => {
  const { service, id } = setup(fakePayPal(), { startDays: 3 });
  await service.ask(id); await service.book(id); await service.finishApproval(id); await service.advance(id, 2);
  const t = await service.cancel(id);
  assert.equal(t.status, "fee_captured"); assert.equal(totals(t).chargedCents, 17930);
});

test("check-in captures the hold exactly once", async () => {
  const { fake, service, id } = setup(fakePayPal(), { startDays: 3 });
  await service.ask(id); await service.book(id); await service.finishApproval(id);
  const t = await service.checkIn(id);
  assert.equal(t.status, "completed"); assert.equal(totals(t).chargedCents, 35860);
  await assert.rejects(service.checkIn(id)); await assert.rejects(service.cancel(id)); await assert.rejects(service.book(id));
  assert.equal(fake.calls.capture, 1); assert.equal(fake.calls.create, 1); assert.equal(fake.calls.authorize, 1);
});

test("a declined charge goes to review and never creates a second order", async () => {
  const { fake, service, id } = setup(fakePayPal({ captureFails: true }));
  await service.ask(id, 16); await service.book(id);
  const t = await service.finishApproval(id);
  assert.equal(t.status, "needs_review"); assert.equal(totals(t).chargedCents, 0);
  await assert.rejects(service.book(id)); assert.equal(fake.calls.create, 1);
});

test("a quote-only hotel can't be booked, and a hotel's new rule changes only later offers", async () => {
  const { service, id } = setup();
  const first = await service.ask(id);
  await assert.rejects(service.book(id));
  setHotelRule("aurora", { floorCents: 12000, windowDays: 30, freeCancelDays: 3, active: true });
  assert.equal(first.rounds[0].offers.find(o => o.hotelId === "aurora")!.totalCents, 46200);
  const next = await service.ask(id);
  assert.ok(next.rounds[1].offers.find(o => o.hotelId === "aurora")!.totalCents < 46200);
  resetHotelRules();
});

test("the AI reading for a stay is bounded in code and never carries a price", () => {
  const s = toStaySuggestion({ understood: "You want a quiet weekend.", nights: 30, guests: null, daysUntilCheckIn: 400, mustHaves: ["quiet", "quiet"], unsure: [] });
  assert.deepEqual([s.nights, s.guests, s.startDays, s.mustHaves], [7, 2, 60, ["quiet"]]);
  assert.ok(!("targetCents" in s) && !("capCents" in s));
});
