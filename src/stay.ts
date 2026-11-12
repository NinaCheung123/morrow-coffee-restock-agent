/**
 * Pip Buy for hotel stays. A buyer's agent asks hotel agents for private offers; prices fall by each
 * hotel's own rule as check-in approaches. Payment follows the booking's life: hold, capture, void, refund.
 * Hotels and their offers are simulated. Every PayPal call is a real sandbox call.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertCents, usdToCents } from "./money.js";
import type { PayPalClient } from "./paypal.js";

export class StayError extends Error {}

export const AMENITIES = { quiet: "Quiet room", breakfast: "Breakfast included", river_view: "River view", free_cancellation: "Free cancellation" } as const;
export type Amenity = keyof typeof AMENITIES;

export const HOTELS = [
  { id: "aurora", name: "Casa Aurora", connected: true, stars: 4, listCents: 21000, taxBps: 1000, amenities: ["quiet", "breakfast", "free_cancellation"] as Amenity[] },
  { id: "miradouro", name: "Hotel Miradouro", connected: false, stars: 4, listCents: 19000, taxBps: 1000, amenities: ["breakfast", "river_view", "free_cancellation"] as Amenity[] },
  { id: "tejo", name: "Tejo House", connected: false, stars: 4, listCents: 23000, taxBps: 1000, amenities: ["quiet", "breakfast", "river_view", "free_cancellation"] as Amenity[] },
] as const;
export const CITY = "Lisbon";

/** PayPal honors a hold for 3 days. A booking further out than that is paid at booking and refunded on cancellation. */
export const HONOR_DAYS = 3;

/** A hotel's private-offer rule: the public rate slides to the floor as check-in approaches. */
export interface HotelRule { floorCents: number; windowDays: number; freeCancelDays: number; active: boolean }
const defaultRules = (): Record<string, HotelRule> => ({
  aurora: { floorCents: 15000, windowDays: 14, freeCancelDays: 3, active: true },
  miradouro: { floorCents: 16500, windowDays: 10, freeCancelDays: 2, active: true },
  tejo: { floorCents: 15500, windowDays: 21, freeCancelDays: 5, active: true },
});
let hotelRules = defaultRules();
export const getHotelRules = () => structuredClone(hotelRules);
export const resetHotelRules = () => { hotelRules = defaultRules(); return getHotelRules(); };
export function setHotelRule(hotelId: string, input: HotelRule) {
  const h = HOTELS.find(h => h.id === hotelId); if (!h) throw new StayError("Unknown hotel");
  const r = { floorCents: Number(input?.floorCents), windowDays: Number(input?.windowDays), freeCancelDays: Number(input?.freeCancelDays), active: input?.active !== false };
  if (!Number.isInteger(r.floorCents) || r.floorCents < 5000 || r.floorCents > h.listCents) throw new StayError(`Lowest private rate must be between $50 and the public rate of $${h.listCents / 100} a night.`);
  if (!Number.isInteger(r.windowDays) || r.windowDays < 1 || r.windowDays > 60) throw new StayError("Discount window must be 1 to 60 days.");
  if (!Number.isInteger(r.freeCancelDays) || r.freeCancelDays < 0 || r.freeCancelDays > 30) throw new StayError("Free cancellation must be 0 to 30 days before check-in.");
  hotelRules[hotelId] = r; return structuredClone(r);
}
export function loadHotelRules(saved: unknown) {
  if (saved && typeof saved === "object") for (const h of HOTELS) { const r = (saved as any)[h.id]; if (r) try { setHotelRule(h.id, r); } catch { /* keep the default */ } }
}

/** The nightly private rate a hotel's rule gives at a number of days before check-in, in whole dollars. */
export function nightlyOfferCents(listCents: number, rule: HotelRule, daysToCheckIn: number): number {
  if (daysToCheckIn >= rule.windowDays) return listCents;
  const used = (rule.windowDays - Math.max(0, daysToCheckIn)) / rule.windowDays;
  return Math.round((listCents - (listCents - rule.floorCents) * used) / 100) * 100;
}

export interface StayRules {
  request: string; hotelIds: string[]; nights: number; guests: number; mustHaves: Amenity[];
  targetCents: number; capCents: number; startDays: number;
}
export interface Offer {
  id: string; hotelId: string; hotelName: string; connected: boolean; round: number; daysToCheckIn: number;
  nights: number; guests: number; listNightCents: number; nightCents: number; subtotalCents: number; taxCents: number; totalCents: number;
  discountPct: number; freeCancelDays: number; lateFeeCents: number; currency: "USD";
  issuedAt: string; expiresAt: string; reasons: string[]; qualifies: boolean; meetsTarget: boolean;
}
export type StayStatus = "open" | "creating_payment" | "awaiting_approval" | "held" | "paid" | "completed" | "voided" | "fee_captured" | "refunded" | "cancelled" | "needs_review";
export type LedgerType = "AUTHORIZED" | "CAPTURED" | "VOIDED" | "REFUNDED";
export interface LedgerEvent { at: string; type: LedgerType; amountCents: number; paypalId: string; paypalStatus: string; verified: boolean; note: string }
export interface StayTask {
  id: string; owner: string; callbackState: string; rules: StayRules; status: StayStatus; createdAt: string; updatedAt: string;
  daysToCheckIn: number; round: number; rounds: { round: number; daysToCheckIn: number; at: string; offers: Offer[] }[];
  selectedOfferId?: string; bookedOffer?: Offer; plan?: "hold" | "pay_now";
  orderId?: string; approveUrl?: string; expectedPayeeId?: string; payeeId?: string; authorizationId?: string; captureId?: string;
  ledger: LedgerEvent[]; trace: { at: string; actor: string; text: string }[]; problem?: string;
}

export function validateStayRules(input: StayRules): StayRules {
  const r = structuredClone(input);
  if (!r || typeof r.request !== "string" || !r.request.trim() || r.request.length > 2500) throw new StayError("Describe the stay you want first.");
  if (!Array.isArray(r.hotelIds) || !r.hotelIds.length || r.hotelIds.some(x => !HOTELS.some(h => h.id === x))) throw new StayError("Approve at least one demo hotel.");
  if (!Number.isInteger(r.nights) || r.nights < 1 || r.nights > 7) throw new StayError("Choose 1 to 7 nights.");
  if (!Number.isInteger(r.guests) || r.guests < 1 || r.guests > 4) throw new StayError("Choose 1 to 4 guests.");
  if (!Array.isArray(r.mustHaves) || r.mustHaves.some(a => !(a in AMENITIES))) throw new StayError("Unknown must-have.");
  assertCents(r.targetCents); assertCents(r.capCents);
  if (r.targetCents < 1000 || r.capCents > 300000 || r.targetCents > r.capCents) throw new StayError("Target must be between $10 and your maximum; the demo maximum is $3,000.");
  if (!Number.isInteger(r.startDays) || r.startDays < 0 || r.startDays > 60) throw new StayError("Check-in must be 0 to 60 days away.");
  r.hotelIds = [...new Set(r.hotelIds)]; r.mustHaves = [...new Set(r.mustHaves)];
  return r;
}

/** Every term of an offer is checked in code before it can be booked. */
export function checkOffer(r: StayRules, o: Offer, daysToCheckIn: number, now = Date.now()): string[] {
  const reasons: string[] = [];
  const h = HOTELS.find(h => h.id === o.hotelId);
  if (!h || !r.hotelIds.includes(o.hotelId)) reasons.push("Hotel not approved");
  if (o.nights !== r.nights || o.guests !== r.guests) reasons.push("Nights or guests differ from your request");
  if (h && r.mustHaves.some(a => !h.amenities.includes(a))) reasons.push("Missing a must-have: " + r.mustHaves.filter(a => !h.amenities.includes(a)).map(a => AMENITIES[a]).join(", "));
  if ([o.nightCents, o.subtotalCents, o.taxCents, o.totalCents, o.lateFeeCents].some(x => !Number.isSafeInteger(x) || x < 0)) reasons.push("Unknown or invalid amounts");
  if (o.subtotalCents !== o.nightCents * o.nights || o.totalCents !== o.subtotalCents + o.taxCents) reasons.push("Offer does not add up");
  if (o.totalCents <= 0 || o.totalCents > r.capCents) reasons.push("Whole-stay total is above your maximum");
  if (o.currency !== "USD") reasons.push("Currency mismatch");
  if (o.daysToCheckIn !== daysToCheckIn) reasons.push("Offer is from an earlier day; ask again");
  if (!Number.isFinite(Date.parse(o.expiresAt)) || Date.parse(o.expiresAt) <= now) reasons.push("Offer expired; ask again");
  return reasons;
}

/** The only message a hotel's agent receives. No name, email, target or maximum. */
export function offerRequestFor(r: StayRules, daysToCheckIn: number) {
  return { type: "offer_request", city: CITY, checkInInDays: daysToCheckIn, nights: r.nights, guests: r.guests,
    mustHaves: r.mustHaves, marketingConsent: false, guest: "name and email not included in this request", currency: "USD" };
}

/** Each simulated hotel agent answers from its own rule. No language model sets a price. */
export function requestOffers(r: StayRules, daysToCheckIn: number, round: number, now = Date.now()): Offer[] {
  return HOTELS.filter(h => r.hotelIds.includes(h.id) && hotelRules[h.id].active).map(h => {
    const rule = hotelRules[h.id];
    const nightCents = nightlyOfferCents(h.listCents, rule, daysToCheckIn);
    const subtotalCents = nightCents * r.nights;
    const taxCents = Math.round((subtotalCents * h.taxBps) / 10000);
    const o: Offer = { id: randomUUID(), hotelId: h.id, hotelName: h.name, connected: h.connected, round, daysToCheckIn,
      nights: r.nights, guests: r.guests, listNightCents: h.listCents, nightCents, subtotalCents, taxCents, totalCents: subtotalCents + taxCents,
      discountPct: Math.round(((h.listCents - nightCents) / h.listCents) * 100), freeCancelDays: rule.freeCancelDays,
      lateFeeCents: nightCents + Math.round((nightCents * h.taxBps) / 10000), currency: "USD",
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 30 * 60_000).toISOString(), reasons: [], qualifies: true, meetsTarget: false };
    o.reasons = checkOffer(r, o, daysToCheckIn, now); o.qualifies = !o.reasons.length; o.meetsTarget = o.qualifies && o.totalCents <= r.targetCents;
    return o;
  });
}

/** Single-process snapshot store. Never serve this directory. */
export class StayStore {
  private tasks: Record<string, StayTask>;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.tasks = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  get(id: string) { const t = this.tasks[id]; return t ? structuredClone(t) : undefined; }
  all() { return Object.values(this.tasks).map(t => structuredClone(t)); }
  put(t: StayTask) {
    t.updatedAt = new Date().toISOString();
    const next = { ...this.tasks, [t.id]: structuredClone(t) };
    writeFileSync(this.path + ".tmp", JSON.stringify(next), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
    this.tasks = next;
    return structuredClone(t);
  }
}

const PAYMENT_STARTED: StayStatus[] = ["creating_payment", "awaiting_approval", "held", "paid", "completed", "voided", "fee_captured", "refunded", "needs_review"];

export class StayService {
  private busy = new Set<string>();
  constructor(readonly store: StayStore, private paypal: PayPalClient, private origin: string) {}
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new StayError("This booking is processing. Check its status before trying again.");
    this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); }
  }
  private get(id: string) { const t = this.store.get(id); if (!t) throw new StayError("Booking not found"); return t; }
  private trace(t: StayTask, actor: string, text: string) { t.trace.push({ at: new Date().toISOString(), actor, text }); }
  private event(t: StayTask, type: LedgerType, amountCents: number, paypalId: string, paypalStatus: string, verified: boolean, note: string) {
    t.ledger.push({ at: new Date().toISOString(), type, amountCents, paypalId, paypalStatus, verified, note });
  }
  private review(t: StayTask, problem: string) { t.status = "needs_review"; t.problem = problem; return this.store.put(t); }

  create(owner: string, rules: StayRules) {
    const now = new Date().toISOString(); const r = validateStayRules(rules);
    const t: StayTask = { id: randomUUID(), owner, callbackState: randomUUID(), rules: r, status: "open", createdAt: now, updatedAt: now,
      daysToCheckIn: r.startDays, round: 0, rounds: [], ledger: [], trace: [] };
    this.trace(t, "You", "Confirmed nights, guests, must-haves, hotels, your target and your maximum.");
    return this.store.put(t);
  }

  /** Ask every approved hotel for an offer. `waitDays` first moves the demo clock forward. */
  async ask(id: string, waitDays = 0) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status !== "open") throw new StayError("This booking is no longer collecting offers.");
    if (!Number.isInteger(waitDays) || waitDays < 0 || waitDays > 60) throw new StayError("Wait 0 to 60 days.");
    if (waitDays > 0) {
      if (t.daysToCheckIn === 0) throw new StayError("Check-in is today. There is no time left to wait.");
      const before = t.daysToCheckIn; t.daysToCheckIn = Math.max(0, before - waitDays);
      this.trace(t, "Demo clock", `${before - t.daysToCheckIn} day(s) pass. Check-in is now ${t.daysToCheckIn} day(s) away. Nothing was bought while waiting.`);
    }
    t.round += 1;
    this.trace(t, "Pip", `Round ${t.round}: sent the same request to ${t.rules.hotelIds.length} approved demo hotel(s). Your target and maximum were not shared.`);
    const offers = requestOffers(t.rules, t.daysToCheckIn, t.round);
    t.rounds.push({ round: t.round, daysToCheckIn: t.daysToCheckIn, at: new Date().toISOString(), offers });
    const ranked = offers.filter(o => o.qualifies).sort((a, b) => a.totalCents - b.totalCents || b.freeCancelDays - a.freeCancelDays || a.hotelId.localeCompare(b.hotelId));
    t.selectedOfferId = ranked[0]?.id;
    this.trace(t, "Pip", !ranked.length ? "No offer passed your rules this round. Nothing was booked."
      : ranked[0].meetsTarget ? `${ranked[0].hotelName} meets your target. It is the lowest total that passes every check.`
      : `Best offer is ${ranked[0].hotelName}, under your maximum but above your target. You can wait or book it yourself.`);
    return this.store.put(t);
  }); }

  private currentOffer(t: StayTask) { return t.rounds.at(-1)?.offers.find(o => o.id === t.selectedOfferId); }

  /** Create the PayPal order. The buyer still has to approve it in PayPal. */
  async book(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "awaiting_approval" && t.approveUrl) return t;
    if (t.status !== "open") throw new StayError("This booking has already started payment.");
    const o = this.currentOffer(t);
    if (!o) throw new StayError("There is no offer to book. Ask the hotels first.");
    const reasons = checkOffer(t.rules, o, t.daysToCheckIn);
    if (reasons.length) throw new StayError(reasons.join("; "));
    if (!o.connected) throw new StayError("This hotel is quote-only in the demo. Its payments are not connected.");
    t.bookedOffer = o; t.plan = t.daysToCheckIn <= HONOR_DAYS ? "hold" : "pay_now";
    t.status = "creating_payment"; this.store.put(t);
    try {
      const suffix = `?task=${t.id}&state=${t.callbackState}`;
      const order = await this.paypal.createStayOrder({ reference: t.id, cents: o.totalCents,
        description: `${o.hotelName} DEMO: ${o.nights} night(s), ${CITY}, taxes included`,
        returnUrl: this.origin + "/paypal/stay-return" + suffix, cancelUrl: this.origin + "/paypal/stay-cancel" + suffix, requestId: `${t.id}-order` });
      t.orderId = order.id; t.expectedPayeeId = order.purchase_units?.[0]?.payee?.merchant_id;
      t.approveUrl = order.links?.find((l: any) => ["payer-action", "approve"].includes(l.rel))?.href;
      if (!t.approveUrl) throw new StayError("PayPal returned no approval link");
      t.status = "awaiting_approval";
      this.trace(t, "PayPal", t.plan === "hold"
        ? `Order created for a hold of the full amount. Check-in is within ${HONOR_DAYS} days, so the hotel is paid at check-in.`
        : `Order created. Check-in is more than ${HONOR_DAYS} days away, longer than PayPal guarantees a hold, so the stay is paid at booking and refunded if cancelled in time.`);
      return this.store.put(t);
    } catch { return this.review(t, "The payment could not be started cleanly. No second order will be created. Check PayPal status."); }
  }); }

  private validateOrder(t: StayTask, order: any) {
    const unit = order.purchase_units?.[0]; const o = t.bookedOffer!;
    if (!unit || order.id !== t.orderId || order.intent !== "AUTHORIZE" || unit.custom_id !== t.id || unit.amount?.currency_code !== "USD"
      || usdToCents(unit.amount.value) !== o.totalCents || !unit.payee?.merchant_id || (t.expectedPayeeId && unit.payee.merchant_id !== t.expectedPayeeId))
      throw new StayError("PayPal order does not match the booked offer and hotel.");
    t.payeeId = unit.payee.merchant_id;
  }

  /** One capture per booking, ever: the request id never changes, so a retry cannot charge twice. */
  private async capture(t: StayTask, cents: number, note: string) {
    const c = await this.paypal.captureAuthorization(t.authorizationId!, cents, `${t.id}-capture`);
    t.captureId = c.captureId;
    const read = await this.paypal.getCapture(c.captureId);
    const ok = read.status === "COMPLETED" && read.amount?.currency_code === "USD" && usdToCents(read.amount.value) === cents;
    this.event(t, "CAPTURED", cents, c.captureId, String(read.status), ok, note);
    if (!ok) throw new StayError("Capture needs checking");
  }

  private async settleApproval(t: StayTask) {
    if (!t.orderId || !t.bookedOffer) throw new StayError("No known PayPal order; do not retry before checking PayPal.");
    const order = await this.paypal.getOrder(t.orderId);
    this.validateOrder(t, order);
    if (!t.authorizationId) {
      if (order.status === "APPROVED") {
        const a = await this.paypal.authorizeOrder(t.orderId, `${t.id}-authorize`);
        if (a.amountCents !== t.bookedOffer.totalCents) throw new StayError("Held amount differs from the offer.");
        t.authorizationId = a.authorizationId;
      } else if (order.status === "COMPLETED" && order.purchase_units[0].payments?.authorizations?.[0]?.id) {
        t.authorizationId = order.purchase_units[0].payments.authorizations[0].id;
      } else { t.status = "awaiting_approval"; t.problem = "Waiting for your approval in PayPal. Nothing is held or charged."; return this.store.put(t); }
      const auth = await this.paypal.getAuthorization(t.authorizationId!);
      const ok = ["CREATED", "PENDING"].includes(auth.status) && usdToCents(auth.amount.value) === t.bookedOffer.totalCents;
      this.event(t, "AUTHORIZED", t.bookedOffer.totalCents, t.authorizationId!, String(auth.status), ok, "Buyer approved in PayPal. The amount is reserved, not charged.");
      if (!ok) throw new StayError("Hold needs checking");
      t.status = "held"; delete t.problem; delete t.approveUrl;
      this.trace(t, "PayPal", "Hold placed and read back from PayPal. The hotel is the receiver. Pip Buy never holds the money.");
      this.store.put(t);
    }
    if (t.plan === "pay_now" && t.status === "held") {
      await this.capture(t, t.bookedOffer.totalCents, "Paid in full at booking. Refundable under the hotel's cancellation terms.");
      t.status = "paid";
      this.trace(t, "PayPal", "Charged in full and read back. Free cancellation refunds this payment.");
    }
    return this.store.put(t);
  }

  async finishApproval(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (["held", "paid", "completed", "voided", "fee_captured", "refunded"].includes(t.status)) return t;
    if (!["awaiting_approval", "needs_review"].includes(t.status)) throw new StayError("No payment is waiting.");
    try { return await this.settleApproval(t); }
    catch { return this.review(t, "The payment outcome needs checking. No new order or charge will be attempted."); }
  }); }

  /** Check-in: a held booking is charged now; a prepaid booking needs no payment action. */
  async checkIn(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "paid") { t.status = "completed"; this.trace(t, "Hotel", "Guest checked in. The stay was already paid; no payment action."); return this.store.put(t); }
    if (t.status !== "held") throw new StayError("Only a held or paid booking can be checked in.");
    try {
      await this.capture(t, t.bookedOffer!.totalCents, "Charged at check-in from the hold.");
      t.status = "completed"; t.daysToCheckIn = 0;
      this.trace(t, "PayPal", "Hold captured at check-in and read back. Booking complete.");
      return this.store.put(t);
    } catch { return this.review(t, "The check-in charge needs checking. No second charge will be attempted."); }
  }); }

  /** What cancelling would do right now, so the buyer sees it before deciding. */
  static cancelPreview(t: StayTask, by: "guest" | "hotel" = "guest") {
    const o = t.bookedOffer;
    if (!o || !["held", "paid"].includes(t.status)) return undefined;
    const free = by === "hotel" || t.daysToCheckIn >= o.freeCancelDays;
    if (t.status === "held") return free ? { kind: "void" as const, chargedCents: 0, refundCents: 0 } : { kind: "fee" as const, chargedCents: o.lateFeeCents, refundCents: 0 };
    return free ? { kind: "refund_full" as const, chargedCents: 0, refundCents: o.totalCents } : { kind: "refund_partial" as const, chargedCents: o.lateFeeCents, refundCents: o.totalCents - o.lateFeeCents };
  }

  async cancel(id: string, by: "guest" | "hotel" = "guest") { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "cancelled") return t;
    if (t.status === "open") { t.status = "cancelled"; this.trace(t, "You", "Request cancelled. Nothing was booked or charged."); return this.store.put(t); }
    if (t.status === "awaiting_approval") {
      const order = await this.paypal.getOrder(t.orderId!);
      if (["APPROVED", "COMPLETED"].includes(order.status)) throw new StayError("PayPal approval has started. Check the payment status before cancelling.");
      t.status = "cancelled"; delete t.approveUrl; this.trace(t, "You", "Cancelled before approving in PayPal. Nothing was held or charged."); return this.store.put(t);
    }
    const plan = StayService.cancelPreview(t, by);
    if (!plan) throw new StayError("This booking can't be cancelled in its current state.");
    const who = by === "hotel" ? "Hotel" : "You";
    try {
      if (plan.kind === "void") {
        await this.paypal.voidAuthorization(t.authorizationId!, `${t.id}-void`);
        const auth = await this.paypal.getAuthorization(t.authorizationId!);
        this.event(t, "VOIDED", t.bookedOffer!.totalCents, t.authorizationId!, String(auth.status), auth.status === "VOIDED", by === "hotel" ? "Hotel cancelled. Hold released in full." : "Free cancellation. Hold released in full.");
        if (auth.status !== "VOIDED") throw new StayError("Void needs checking");
        t.status = "voided"; this.trace(t, who, "Booking cancelled. The hold was released and nothing was charged.");
      } else if (plan.kind === "fee") {
        await this.capture(t, plan.chargedCents, "Late cancellation: first night charged. The rest of the hold is released.");
        t.status = "fee_captured"; this.trace(t, who, "Cancelled after the free-cancellation deadline. Only the first night was charged.");
      } else {
        const refund = await this.paypal.refundCapture(t.captureId!, plan.refundCents, `${t.id}-refund`, plan.kind === "refund_full" ? "Booking cancelled: full refund" : "Late cancellation: refund less the first night");
        const read = await this.paypal.getCapture(t.captureId!);
        const expected = plan.kind === "refund_full" ? "REFUNDED" : "PARTIALLY_REFUNDED";
        this.event(t, "REFUNDED", plan.refundCents, String(refund.id), String(refund.status), refund.status === "COMPLETED" && read.status === expected,
          plan.kind === "refund_full" ? (by === "hotel" ? "Hotel cancelled. Refunded in full." : "Free cancellation. Refunded in full.") : "Late cancellation. Refunded less the first night.");
        if (refund.status !== "COMPLETED") throw new StayError("Refund needs checking");
        t.status = "refunded"; this.trace(t, who, plan.kind === "refund_full" ? "Booking cancelled and refunded in full." : "Booking cancelled. Refunded except the first night.");
      }
      return this.store.put(t);
    } catch { return this.review(t, "The cancellation's payment step needs checking. Nothing will be retried automatically."); }
  }); }

  /** After booking, the demo clock can still move toward check-in. */
  async advance(id: string, days: number) { return this.locked(id, async () => {
    const t = this.get(id);
    if (!["held", "paid"].includes(t.status)) throw new StayError("Only a booked stay can move toward check-in.");
    if (!Number.isInteger(days) || days < 1 || days > 60) throw new StayError("Move 1 to 60 days.");
    const before = t.daysToCheckIn; t.daysToCheckIn = Math.max(0, before - days);
    this.trace(t, "Demo clock", `${before - t.daysToCheckIn} day(s) pass. Check-in is now ${t.daysToCheckIn} day(s) away.`);
    return this.store.put(t);
  }); }
}

export function totals(t: StayTask) {
  const sum = (type: LedgerType) => t.ledger.filter(e => e.type === type).reduce((s, e) => s + e.amountCents, 0);
  const chargedCents = sum("CAPTURED"), refundedCents = sum("REFUNDED");
  return { heldCents: t.status === "held" ? sum("AUTHORIZED") : 0, chargedCents, refundedCents, netPaidCents: chargedCents - refundedCents };
}

export function publicStay(t: StayTask) {
  const { owner, callbackState, expectedPayeeId, ...view } = t;
  return { ...view, totals: totals(t), started: PAYMENT_STARTED.includes(t.status), cancelPreview: StayService.cancelPreview(t),
    planIfBookedNow: t.daysToCheckIn <= HONOR_DAYS ? "hold" : "pay_now", honorDays: HONOR_DAYS,
    request: offerRequestFor(t.rules, t.daysToCheckIn), environment: "sandbox" };
}

/** What a hotel sees: requests without identity or budget, its own answers, and its bookings and payments. */
export function hotelView(tasks: StayTask[], hotelId: string) {
  const mine = tasks.filter(t => t.rounds.some(r => r.offers.some(o => o.hotelId === hotelId))).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  const inbox = mine.slice(0, 8).flatMap(t => t.rounds.map(r => ({ r, o: r.offers.find(o => o.hotelId === hotelId) })).filter(x => x.o).reverse().slice(0, 4).map(({ r, o }) => ({
    at: r.at, round: r.round, daysToCheckIn: r.daysToCheckIn, request: offerRequestFor(t.rules, r.daysToCheckIn), nightCents: o!.nightCents, totalCents: o!.totalCents,
    outcome: t.bookedOffer?.id === o!.id ? "Booked with you" : t.bookedOffer ? "Guest booked elsewhere or an earlier offer" : t.status === "cancelled" ? "Request cancelled" : "Open",
  }))).slice(0, 12);
  const bookings = mine.filter(t => t.bookedOffer?.hotelId === hotelId && ["held", "paid", "completed", "voided", "fee_captured", "refunded", "needs_review"].includes(t.status))
    .slice(0, 8).map(t => ({ taskId: t.id, status: t.status, plan: t.plan, daysToCheckIn: t.daysToCheckIn, nights: t.bookedOffer!.nights, totalCents: t.bookedOffer!.totalCents,
      totals: totals(t), ledger: t.ledger, hotelCancel: StayService.cancelPreview(t, "hotel") }));
  return { inbox, bookings };
}
