/**
 * Append-only record of intents, stored as JSON lines. Each change appends a
 * full record, and the newest record for an id wins when the file is read back.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export type IntentStatus =
  | "awaiting_approval" // PayPal order created, buyer hasn't approved it
  | "held" // funds held up to the cap
  | "capture_requested" // about to charge; safe to retry with the same request id
  | "captured" // buyer charged the final price
  | "payout_requested" // about to pay the merchant; never resent automatically
  | "paid_out" // merchant payout accepted by PayPal
  | "voided" // no deal; the hold was released
  | "needs_review"; // outcome unknown; a person must check PayPal before any retry

export interface Intent {
  id: string;
  createdAt: string;
  updatedAt: string;
  status: IntentStatus;
  description: string;
  capCents: number;
  orderId: string;
  approveUrl: string;
  authorizationId?: string;
  finalCents?: number;
  captureId?: string;
  merchantEmail?: string;
  merchantPayoutCents?: number;
  payoutBatchId?: string;
  reviewReason?: string;
}

export class IntentStore {
  private readonly intents = new Map<string, Intent>();

  constructor(private readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const intent = JSON.parse(line) as Intent;
        this.intents.set(intent.id, intent);
      } catch {
        console.warn(`[store] skipped an unreadable line in ${path}`);
      }
    }
    // Otherwise the next record would be glued onto a half-written line.
    if (text && !text.endsWith("\n")) appendFileSync(path, "\n");
  }

  put(intent: Intent): Intent {
    const saved = { ...intent, updatedAt: new Date().toISOString() };
    appendFileSync(this.path, JSON.stringify(saved) + "\n");
    this.intents.set(saved.id, saved);
    return saved;
  }

  get = (id: string) => this.intents.get(id);

  findByOrder(orderId: string) {
    for (const intent of this.intents.values()) if (intent.orderId === orderId) return intent;
    return undefined;
  }
}
