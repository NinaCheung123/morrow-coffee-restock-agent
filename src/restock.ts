import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertCents, usdToCents } from "./money.js";
import { PayPalClient } from "./paypal.js";

export const BRANDS = [
  { id: "morrow", name: "Morrow Roasters", connected: true, source: "Fictional brand · simulated official-store agent · one connected PayPal sandbox merchant", floorCents: 1500, shippingCents: 300, taxCentsPerBag: 150, deliveryDays: 5 },
  { id: "daybreak", name: "Daybreak Coffee", connected: false, source: "Fictional brand · simulated official-store agent · no payment connection", floorCents: 1600, shippingCents: 300, taxCentsPerBag: 150, deliveryDays: 6 },
] as const;
export const PRODUCTS = [
  { id: "morrow-house", brand: "morrow", name: "Everyday Blend", roast: "Medium-dark", grams: 250, notes: "Natural cocoa & toasted almond tasting notes", ingredients: "100% coffee. No added flavorings or sugar.", priceCents: 1900, stock: 8 },
  { id: "morrow-seasonal", brand: "morrow", name: "Seasonal Origin", roast: "Medium-dark", grams: 250, notes: "Natural dark-chocolate & dried-fruit tasting notes", ingredients: "100% coffee. No added flavorings or sugar.", priceCents: 1900, stock: 8 },
  { id: "daybreak-house", brand: "daybreak", name: "Morning Roast", roast: "Medium-dark", grams: 250, notes: "Natural caramel & hazelnut tasting notes", ingredients: "100% coffee. No added flavorings or sugar.", priceCents: 2000, stock: 8 },
] as const;

export interface Rules {
  request: string; mode: "confirm" | "auto"; brandIds: string[]; productIds: string[];
  quantity: number; targetCents: number; capCents: number; deliveryDays: number;
  region: "US-CA"; currency: "USD"; oneTime: true; notificationTime: string;
}
export interface Quote {
  id: string; brandId: string; brandName: string; connected: boolean;
  lines: { productId: string; name: string; quantity: number; unitCents: number }[];
  subtotalCents: number; shippingCents: number; taxCents: number; totalCents: number;
  referenceTotalCents: number; referenceAt: string; source: "simulated-brand-agent";
  currency: "USD"; region: "US-CA"; deliveryDays: number; subscription: false;
  issuedAt: string; expiresAt: string; reasons: string[]; qualifies: boolean; meetsTarget: boolean;
}
export type TaskStatus = "ready" | "awaiting_consent" | "quote_ready" | "awaiting_payment" | "creating_payment" | "capturing" | "verifying" | "purchased" | "cancelled" | "no_offer" | "needs_review";
export interface Task {
  id: string; owner: string; rules: Rules; status: TaskStatus; createdAt: string; updatedAt: string;
  callbackState: string; trace: { at: string; actor: string; text: string }[];
  quotes: Quote[]; selectedQuoteId?: string; setupTokenId?: string; consentUrl?: string;
  vaultId?: string; vaultMerchantId?: string; paymentOrderId?: string; approveUrl?: string;
  expectedPayeeId?: string; problem?: string; captureId?: string; paidCents?: number;
  payeeId?: string; paypalStatus?: string; verifiedAt?: string; offSession?: boolean;
}
export class RestockError extends Error {}

/** Single-process, atomic snapshot store. Contains tokens: never serve this directory. */
export class RestockStore {
  private tasks: Record<string, Task>;
  constructor(private path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.tasks = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {};
  }
  get(id: string) { const t = this.tasks[id]; return t ? structuredClone(t) : undefined; }
  all() { return Object.values(this.tasks).map(t => structuredClone(t)); }
  put(t: Task) {
    t.updatedAt = new Date().toISOString();
    const next = { ...this.tasks, [t.id]: structuredClone(t) };
    writeFileSync(this.path + ".tmp", JSON.stringify(next), { mode: 0o600 });
    renameSync(this.path + ".tmp", this.path);
    this.tasks = next;
    return structuredClone(t);
  }
}

export function validateRules(input: Rules): Rules {
  const r = structuredClone(input);
  if (!r || typeof r.request !== "string" || !r.request.trim() || r.request.length > 2500) throw new RestockError("Describe your coffee restock first.");
  if (!["auto", "confirm"].includes(r.mode)) throw new RestockError("Choose a purchase mode.");
  if (!Array.isArray(r.brandIds) || !r.brandIds.length || r.brandIds.some(x => !BRANDS.some(b => b.id === x))) throw new RestockError("Approve at least one demo roaster.");
  if (!Array.isArray(r.productIds) || !r.productIds.length || r.productIds.some(x => !PRODUCTS.some(p => p.id === x && r.brandIds.includes(p.brand)))) throw new RestockError("Approve products from your selected roasters.");
  if (!Number.isInteger(r.quantity) || r.quantity < 1 || r.quantity > 8) throw new RestockError("Choose 1 to 8 bags.");
  assertCents(r.targetCents); assertCents(r.capCents);
  if (r.targetCents < 100 || r.capCents > 20000 || r.targetCents > r.capCents) throw new RestockError("Target must be between $1 and your maximum; maximum is $200 for this demo.");
  if (!Number.isInteger(r.deliveryDays) || r.deliveryDays < 1 || r.deliveryDays > 30) throw new RestockError("Delivery window must be 1–30 days.");
  if (r.region !== "US-CA" || r.currency !== "USD" || r.oneTime !== true) throw new RestockError("This sandbox supports one-time purchases in California, USD only.");
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(r.notificationTime)) throw new RestockError("Choose a valid update time.");
  r.brandIds = [...new Set(r.brandIds)]; r.productIds = [...new Set(r.productIds)];
  return r;
}

export function checkQuote(r: Rules, q: Quote, now = Date.now()): string[] {
  const reasons: string[] = [];
  if (!r.brandIds.includes(q.brandId)) reasons.push("Roaster not approved");
  if (q.lines.some(l => !r.productIds.includes(l.productId) || !PRODUCTS.some(p => p.id === l.productId && p.brand === q.brandId))) reasons.push("Product outside approved range");
  if (q.lines.reduce((s, l) => s + l.quantity, 0) !== r.quantity) reasons.push("Quantity differs from your instruction");
  if ([q.subtotalCents, q.shippingCents, q.taxCents, q.totalCents, ...q.lines.map(l => l.unitCents)].some(x => !Number.isSafeInteger(x) || x < 0)) reasons.push("Unknown or invalid fees");
  if (q.subtotalCents !== q.lines.reduce((s, l) => s + l.unitCents * l.quantity, 0) || q.totalCents !== q.subtotalCents + q.shippingCents + q.taxCents) reasons.push("Quote does not add up");
  if (q.totalCents <= 0 || q.totalCents > r.capCents) reasons.push("Above your approved payment maximum");
  if (q.deliveryDays > r.deliveryDays) reasons.push("Arrives after your deadline");
  if (q.subscription) reasons.push("Requires a subscription");
  if (q.currency !== r.currency || q.region !== r.region) reasons.push("Currency or delivery region mismatch");
  if (!Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= now) reasons.push("Quote expired");
  return reasons;
}

/** Two explicit simulated brand agents; prices always come from catalog/floor rules. */
export function requestQuotes(r: Rules, now = Date.now()): Quote[] {
  return BRANDS.filter(b => r.brandIds.includes(b.id)).flatMap(b => {
    const products = PRODUCTS.filter(p => p.brand === b.id && r.productIds.includes(p.id) && p.stock >= r.quantity);
    if (!products.length) return [];
    const lines: Quote["lines"] = [];
    for (let n = 0; n < r.quantity; n++) {
      const p = products[n % products.length];
      const existing = lines.find(l => l.productId === p.id);
      if (existing) existing.quantity++;
      else lines.push({ productId: p.id, name: p.name, quantity: 1, unitCents: b.floorCents });
    }
    const subtotalCents = lines.reduce((s, l) => s + l.unitCents * l.quantity, 0);
    const taxCents = b.taxCentsPerBag * r.quantity;
    const q: Quote = { id: randomUUID(), brandId: b.id, brandName: b.name, connected: b.connected,
      lines, subtotalCents, taxCents, shippingCents: b.shippingCents,
      totalCents: subtotalCents + taxCents + b.shippingCents,
      referenceTotalCents: lines.reduce((s, l) => s + PRODUCTS.find(p => p.id === l.productId)!.priceCents * l.quantity, 0) + taxCents + b.shippingCents,
      referenceAt: new Date(now).toISOString(), source: "simulated-brand-agent", currency: "USD", region: "US-CA",
      deliveryDays: b.deliveryDays, subscription: false, issuedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + 30 * 60_000).toISOString(), reasons: [], qualifies: true, meetsTarget: false,
    };
    q.reasons = checkQuote(r, q, now); q.qualifies = !q.reasons.length; q.meetsTarget = q.totalCents <= r.targetCents;
    return [q];
  });
}

export class RestockService {
  private busy = new Set<string>();
  constructor(readonly store: RestockStore, private paypal: PayPalClient, private origin: string) {}
  private async locked<T>(id: string, action: () => Promise<T>): Promise<T> {
    if (this.busy.has(id)) throw new RestockError("This task is processing. Check its status before trying again.");
    this.busy.add(id); try { return await action(); } finally { this.busy.delete(id); }
  }
  private get(id: string) { const t = this.store.get(id); if (!t) throw new RestockError("Task not found"); return t; }
  private trace(t: Task, actor: string, text: string) { t.trace.push({ at: new Date().toISOString(), actor, text }); }
  create(owner: string, rules: Rules) {
    const now = new Date().toISOString();
    const t: Task = { id: randomUUID(), owner, rules: validateRules(rules), status: "ready", createdAt: now, updatedAt: now,
      callbackState: randomUUID(), quotes: [], trace: [] };
    this.trace(t, "You", "Confirmed products, roasters, quantity, all-in maximum and one-time purchase mode.");
    return this.store.put(t);
  }
  async consent(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "awaiting_consent") return t;
    if (t.status !== "ready" || t.rules.mode !== "auto") throw new RestockError("Consent is only available before starting an automatic task.");
    if (!t.rules.brandIds.includes("morrow")) throw new RestockError("Only Morrow's demo merchant is connected. Use confirm mode for simulated quotes.");
    const suffix = `?task=${t.id}&state=${t.callbackState}`;
    const s = await this.paypal.createSetup({ reference: `${t.id}-setup`, returnUrl: this.origin + "/paypal/vault-return" + suffix, cancelUrl: this.origin + "/paypal/cancel" + suffix });
    t.setupTokenId = s.id; t.consentUrl = s.links?.find((l: any) => l.rel === "approve")?.href;
    if (!t.consentUrl) throw new RestockError("PayPal did not provide an approval URL.");
    t.status = "awaiting_consent";
    this.trace(t, "PayPal", "Merchant-scoped sandbox consent requested. No hold or purchase has been made.");
    return this.store.put(t);
  }); }
  async finishConsent(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.vaultId) return t;
    if (t.status !== "awaiting_consent" || !t.setupTokenId) throw new RestockError("No active consent request");
    const setup = await this.paypal.getSetup(t.setupTokenId);
    if (setup.status !== "APPROVED") throw new RestockError("PayPal consent has not been approved.");
    const token = await this.paypal.exchangeSetup(t.setupTokenId, `${t.id}-vault`);
    if (!token.id) throw new RestockError("PayPal did not return a saved payment token.");
    t.vaultId = token.id; t.vaultMerchantId = "morrow"; t.status = "ready";
    delete t.consentUrl;
    this.trace(t, "PayPal", "Consent saved for the connected demo merchant only. This app permits one purchase for this task.");
    return this.store.put(t);
  }); }
  async scan(id: string) { return this.locked(id, async () => {
    let t = this.get(id);
    if (t.status !== "ready") throw new RestockError("This task has already requested quotes or has ended.");
    if (t.rules.mode === "auto" && !t.vaultId) throw new RestockError("Approve the merchant-scoped PayPal consent before automatic buying.");
    this.trace(t, "Buyer agent", `Sent one structured request to ${t.rules.brandIds.length} approved demo roaster(s). No real brand was contacted.`);
    t.quotes = requestQuotes(t.rules);
    for (const q of t.quotes) this.trace(t, `${q.brandName} agent · simulated`, `Returned a one-time, all-in quote from stock, price-floor and delivery rules. Valid until ${q.expiresAt}.`);
    const qualified = t.quotes.filter(q => q.qualifies).sort((a, b) => a.totalCents - b.totalCents || a.deliveryDays - b.deliveryDays || a.brandId.localeCompare(b.brandId));
    const winner = qualified.find(q => q.meetsTarget);
    if (!qualified.length) { t.status = "no_offer"; this.trace(t, "Buyer agent", "No qualifying quote. No payment attempted; no full-price fallback."); }
    else {
      t.status = "quote_ready"; t.selectedQuoteId = (winner ?? qualified[0]).id;
      this.trace(t, "Buyer agent", winner ? "Found a quote meeting your target and all approved rules. No need to wait for a future lowest price." : "An eligible offer is above your target. Recommendation only; explicit confirmation is required.");
    }
    t = this.store.put(t);
    if (winner && t.rules.mode === "auto" && winner.connected && t.vaultMerchantId === winner.brandId) return this.beginPayment(t, winner, true);
    return t;
  }); }
  async checkout(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "awaiting_payment" && t.approveUrl) return t;
    if (t.status !== "quote_ready") throw new RestockError("This task is not ready for a new payment.");
    const q = t.quotes.find(q => q.id === t.selectedQuoteId);
    if (!q) throw new RestockError("No selected quote");
    return this.beginPayment(t, q, false);
  }); }
  private async beginPayment(t: Task, q: Quote, offSession: boolean): Promise<Task> {
    const reasons = checkQuote(t.rules, q);
    if (reasons.length) throw new RestockError(reasons.join("; "));
    if (!q.connected || q.brandId !== "morrow") throw new RestockError("This brand is quote-only. Its payments are not connected.");
    if (offSession && (!t.vaultId || t.vaultMerchantId !== q.brandId || !q.meetsTarget)) throw new RestockError("No applicable one-time automatic authorization.");
    t.status = "creating_payment"; t.offSession = offSession; this.store.put(t);
    try {
      const suffix = `?task=${t.id}&state=${t.callbackState}`;
      const order = await this.paypal.createDirectOrder({ reference: t.id, cents: q.totalCents,
        description: `${q.brandName} DEMO — ${t.rules.quantity} coffee bags, one-time, tax & shipping included`,
        returnUrl: this.origin + "/paypal/return" + suffix, cancelUrl: this.origin + "/paypal/cancel" + suffix,
        requestId: `${t.id}-order`, vaultId: offSession ? t.vaultId : undefined });
      t.paymentOrderId = order.id; t.expectedPayeeId = order.purchase_units?.[0]?.payee?.merchant_id;
      t.approveUrl = order.links?.find((l: any) => ["payer-action", "approve"].includes(l.rel))?.href;
      t.status = t.approveUrl ? "awaiting_payment" : "verifying";
      this.trace(t, "PayPal", "Created a direct order with the connected demo merchant as payee. No platform collection or payout.");
      this.store.put(t);
      if (!t.approveUrl) return this.finishPaymentUnlocked(t);
      if (offSession) { t.offSession = false; this.trace(t, "PayPal", "Additional buyer approval required. Automatic payment was not completed."); }
      return this.store.put(t);
    } catch {
      t.status = "needs_review"; t.problem = "Payment outcome needs checking. No second order will be created. Use Check PayPal status.";
      return this.store.put(t);
    }
  }
  private validateOrder(t: Task, order: any) {
    const q = t.quotes.find(q => q.id === t.selectedQuoteId)!;
    const unit = order.purchase_units?.[0];
    if (!unit || order.id !== t.paymentOrderId || unit.custom_id !== t.id || unit.amount?.currency_code !== "USD" || usdToCents(unit.amount.value) !== q.totalCents || !unit.payee?.merchant_id || (t.expectedPayeeId && unit.payee.merchant_id !== t.expectedPayeeId)) throw new RestockError("PayPal order does not match approved quote and payee.");
  }
  private async finishPaymentUnlocked(t: Task) {
    if (!t.paymentOrderId) throw new RestockError("No known PayPal order; manual reconciliation is required before retrying.");
    let order = await this.paypal.getOrder(t.paymentOrderId);
    this.validateOrder(t, order);
    if (order.status === "APPROVED") {
      const q = t.quotes.find(q => q.id === t.selectedQuoteId)!;
      const reasons = checkQuote(t.rules, q);
      if (reasons.length) throw new RestockError(reasons.join("; "));
      t.status = "capturing"; this.store.put(t);
      await this.paypal.captureOrder(t.paymentOrderId, `${t.id}-capture`);
      order = await this.paypal.getOrder(t.paymentOrderId);
      this.validateOrder(t, order);
    }
    const captures = order.purchase_units?.[0]?.payments?.captures ?? [];
    const completed = captures.find((c: any) => c.status === "COMPLETED");
    t.paypalStatus = order.status;
    if (order.status === "COMPLETED" && completed) {
      const q = t.quotes.find(q => q.id === t.selectedQuoteId)!;
      if (captures.length !== 1 || completed.amount?.currency_code !== "USD" || usdToCents(completed.amount.value) !== q.totalCents) throw new RestockError("Captured amount needs reconciliation.");
      t.status = "purchased"; t.captureId = completed.id; t.paidCents = q.totalCents;
      t.payeeId = order.purchase_units[0].payee.merchant_id; t.verifiedAt = new Date().toISOString();
      delete t.problem; delete t.approveUrl; delete t.vaultId;
      this.trace(t, "PayPal", "Capture COMPLETED and independently read back. Task closed; no repeat purchase or subscription.");
    } else if (order.status === "COMPLETED" || captures.length) {
      t.status = "verifying"; t.problem = "Payment is not confirmed completed. No new charge will be attempted.";
    } else {
      t.status = "awaiting_payment"; t.problem = "Waiting for PayPal buyer approval. Nothing has been marked as paid.";
    }
    return this.store.put(t);
  }
  async finishPayment(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "purchased") return t;
    if (!["awaiting_payment", "verifying", "capturing", "needs_review"].includes(t.status)) throw new RestockError("No active payment to complete.");
    try { return await this.finishPaymentUnlocked(t); }
    catch { t.status = "needs_review"; t.problem = "Could not confirm payment. Check PayPal status; do not create another order."; return this.store.put(t); }
  }); }
  async cancel(id: string) { return this.locked(id, async () => {
    const t = this.get(id);
    if (t.status === "cancelled") return t;
    if (["purchased", "creating_payment", "capturing", "verifying", "needs_review"].includes(t.status)) throw new RestockError("Payment has started or its outcome is uncertain. Check its status before cancelling.");
    if (t.paymentOrderId) {
      const order = await this.paypal.getOrder(t.paymentOrderId);
      if (order.status === "COMPLETED" || order.purchase_units?.[0]?.payments?.captures?.length) return this.finishPaymentUnlocked(t);
    }
    t.status = "cancelled"; delete t.vaultId; delete t.consentUrl; delete t.approveUrl;
    this.trace(t, "You", "Task cancelled. No further purchases will be initiated.");
    return this.store.put(t);
  }); }
}

/** The only message a roaster's agent receives. No name, email, payment maximum or target is shared. */
export function quoteRequestFor(r: Rules, brandId: string) {
  return { type: "quote_request", purchase: "one_time", subscription: false, marketingConsent: false,
    buyer: "anonymous until an order is placed",
    productIds: PRODUCTS.filter(p => p.brand === brandId && r.productIds.includes(p.id)).map(p => p.id),
    quantity: r.quantity, deliverWithinDays: r.deliveryDays, region: r.region, currency: r.currency };
}

export function publicTask(t: Task) {
  const { owner, callbackState, setupTokenId, vaultId, vaultMerchantId, expectedPayeeId, ...view } = t;
  const exchange = t.quotes.map(q => {
    const b = BRANDS.find(b => b.id === q.brandId)!;
    return { brandName: q.brandName, simulated: true, request: quoteRequestFor(t.rules, q.brandId),
      roasterRule: `One-time offer floor ${(b.floorCents / 100).toFixed(2)} USD per bag (list ${(PRODUCTS.find(p => p.brand === b.id)!.priceCents / 100).toFixed(2)}), shipping ${(b.shippingCents / 100).toFixed(2)}, tax ${(b.taxCentsPerBag / 100).toFixed(2)} per bag, ships in ${b.deliveryDays} days, only while stock covers the order.`,
      reply: { type: "quote", lines: q.lines, subtotalCents: q.subtotalCents, shippingCents: q.shippingCents, taxCents: q.taxCents,
        totalCents: q.totalCents, currency: q.currency, deliveryDays: q.deliveryDays, subscription: q.subscription, expiresAt: q.expiresAt } };
  });
  return { ...view, exchange, consentSaved: Boolean(vaultId), environment: "sandbox", notification: "In-app receipt only; no push or marketing email integration" };
}
