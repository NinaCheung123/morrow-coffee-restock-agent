/**
 * The money lifecycle of one intent: hold, then either charge and pay the
 * merchant, or release the hold. How a winning quote is chosen lives elsewhere.
 */
import { randomUUID } from "node:crypto";
import { assertCents } from "./money.js";
import type { PayPalClient } from "./paypal.js";
import type { Intent, IntentStatus, IntentStore } from "./store.js";

export class SettlementError extends Error {}

export class Settlement {
  constructor(
    private readonly store: IntentStore,
    private readonly paypal: PayPalClient,
    private readonly publicUrl: string,
  ) {}

  private require(id: string, ...allowed: IntentStatus[]): Intent {
    const intent = this.store.get(id);
    if (!intent) throw new SettlementError(`unknown intent: ${id}`);
    if (!allowed.includes(intent.status)) throw new SettlementError(`intent is ${intent.status}, expected ${allowed.join(" or ")}`);
    return intent;
  }

  async open(input: { description: string; capCents: number }): Promise<Intent> {
    assertCents(input.capCents);
    if (input.capCents === 0) throw new SettlementError("the cap must be above zero");
    const id = randomUUID();
    const { orderId, approveUrl } = await this.paypal.createHoldOrder({
      reference: id,
      capCents: input.capCents,
      description: input.description,
      returnUrl: `${this.publicUrl}/paypal/return`,
      cancelUrl: `${this.publicUrl}/paypal/cancel`,
      requestId: `${id}-order`,
    });
    const now = new Date().toISOString();
    return this.store.put({
      id,
      createdAt: now,
      updatedAt: now,
      status: "awaiting_approval",
      description: input.description,
      capCents: input.capCents,
      orderId,
      approveUrl,
    });
  }

  /** Called once the buyer has approved. Repeating it for a held intent changes nothing. */
  async hold(id: string): Promise<Intent> {
    const current = this.store.get(id);
    if (current?.status === "held") return current;
    const intent = this.require(id, "awaiting_approval");
    const { authorizationId, amountCents } = await this.paypal.authorizeOrder(intent.orderId, `${id}-authorize`);
    if (amountCents !== intent.capCents) throw new SettlementError("PayPal held a different amount from the cap");
    return this.store.put({ ...intent, status: "held", authorizationId });
  }

  /**
   * Charges the final price, then pays the merchant. If this stops partway, it
   * can be called again: the charge reuses its request id, so PayPal won't
   * repeat it, and an uncertain payout goes to a person instead of being resent.
   */
  async closeMatched(id: string, input: { finalCents: number; merchantEmail: string; merchantPayoutCents: number }): Promise<Intent> {
    let intent = this.require(id, "held", "capture_requested", "captured", "payout_requested");
    if (intent.status === "payout_requested") {
      return this.store.put({ ...intent, status: "needs_review", reviewReason: "payout outcome unknown; check PayPal before resending" });
    }

    assertCents(input.finalCents);
    assertCents(input.merchantPayoutCents);
    if (input.finalCents === 0) throw new SettlementError("the final price must be above zero");
    if (input.finalCents > intent.capCents) throw new SettlementError("the final price is above the buyer's cap");
    if (input.merchantPayoutCents > input.finalCents) throw new SettlementError("the payout is above what the buyer paid");
    if (intent.finalCents !== undefined && intent.finalCents !== input.finalCents) throw new SettlementError("the final price can't change once charging has started");

    if (intent.status !== "captured") {
      intent = this.store.put({ ...intent, status: "capture_requested", finalCents: input.finalCents });
      const capture = await this.paypal.captureAuthorization(intent.authorizationId!, input.finalCents, `${id}-capture`);
      if (capture.amountCents !== input.finalCents) {
        return this.store.put({ ...intent, status: "needs_review", captureId: capture.captureId, reviewReason: "PayPal charged a different amount" });
      }
      intent = this.store.put({ ...intent, status: "captured", captureId: capture.captureId });
    }

    intent = this.store.put({
      ...intent,
      status: "payout_requested",
      merchantEmail: input.merchantEmail,
      merchantPayoutCents: input.merchantPayoutCents,
    });
    try {
      const payout = await this.paypal.createPayout({
        senderBatchId: `${id}-payout`,
        senderItemId: `${id}-item`,
        receiverEmail: input.merchantEmail,
        cents: input.merchantPayoutCents,
        note: "Payment for a winning quote",
      });
      return this.store.put({ ...intent, status: "paid_out", payoutBatchId: payout.payoutBatchId });
    } catch (error) {
      return this.store.put({ ...intent, status: "needs_review", reviewReason: `payout failed: ${(error as Error).message}` });
    }
  }

  /** No acceptable quote: release the buyer's funds. */
  async closeUnmatched(id: string): Promise<Intent> {
    const intent = this.require(id, "held");
    await this.paypal.voidAuthorization(intent.authorizationId!, `${id}-void`);
    return this.store.put({ ...intent, status: "voided" });
  }
}
