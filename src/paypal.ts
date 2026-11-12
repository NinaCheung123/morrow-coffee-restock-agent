/** Thin client for the PayPal sandbox calls this project uses. */
import { centsToUsd, usdToCents } from "./money.js";

export const SANDBOX_BASE = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly errorName: string | undefined,
    readonly issue: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

export interface PayPalConfig {
  clientId: string;
  clientSecret: string;
  base?: string;
  fetchFn?: typeof fetch;
}

export class PayPalClient {
  private token?: { value: string; expiresAt: number };
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly config: PayPalConfig) {
    this.base = config.base ?? SANDBOX_BASE;
    if (this.base !== SANDBOX_BASE) throw new Error("This application only supports the PayPal sandbox");
    this.fetchFn = config.fetchFn ?? fetch;
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.fetchFn(`${this.base}/v1/oauth2/token`, {
      method: "POST",
      redirect: "error", signal: AbortSignal.timeout(25_000),
      headers: { authorization: `Basic ${basic}`, "content-type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!res.ok) throw new PayPalError(res.status, undefined, undefined, "PayPal sign-in failed");
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return data.access_token;
  }

  /** Sending the same requestId again makes PayPal return the first result, not repeat the action. */
  private async request<T>(method: string, path: string, body?: unknown, requestId?: string): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.accessToken()}`,
      "content-type": "application/json",
      prefer: "return=representation",
    };
    if (requestId) headers["paypal-request-id"] = requestId;
    const res = await this.fetchFn(this.base + path, {
      method,
      redirect: "error", signal: AbortSignal.timeout(25_000),
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = {};
    }
    if (!res.ok) {
      const issue = data.details?.[0]?.issue;
      throw new PayPalError(res.status, data.name, issue, `PayPal ${method} ${path.split("?")[0]} failed: ${res.status} ${issue ?? data.name ?? ""}`.trim());
    }
    return data as T;
  }

  /** One read-only call, used to show the deployment really reaches PayPal. */
  async ping(): Promise<void> {
    await this.accessToken();
  }

  async createSetup(input: { reference: string; returnUrl: string; cancelUrl: string }): Promise<any> {
    return this.request("POST", "/v3/vault/setup-tokens", { payment_source: { paypal: {
      description: "One coffee restock from the connected demo merchant; no subscription",
      usage_type: "MERCHANT", usage_pattern: "IMMEDIATE", customer_type: "CONSUMER",
      permit_multiple_payment_tokens: false,
      experience_context: { return_url: input.returnUrl, cancel_url: input.cancelUrl, shipping_preference: "GET_FROM_FILE" },
    } } }, input.reference);
  }

  async getSetup(id: string): Promise<any> { return this.request("GET", `/v3/vault/setup-tokens/${encodeURIComponent(id)}`); }
  async exchangeSetup(id: string, requestId: string): Promise<any> {
    return this.request("POST", "/v3/vault/payment-tokens", { payment_source: { token: { id, type: "SETUP_TOKEN" } } }, requestId);
  }

  // Direct receipt by the merchant owning these credentials. Never a platform payout.
  async createDirectOrder(input: {
    reference: string; cents: number; returnUrl: string; cancelUrl: string;
    requestId: string; vaultId?: string; description: string;
  }): Promise<any> {
    return this.request("POST", "/v2/checkout/orders", {
      intent: "CAPTURE",
      purchase_units: [{ reference_id: input.reference, custom_id: input.reference,
        description: input.description.slice(0, 127),
        amount: { currency_code: "USD", value: centsToUsd(input.cents) },
        shipping: { name: { full_name: "Sandbox Coffee Buyer" }, address: {
          address_line_1: "2211 N First Street", admin_area_2: "San Jose", admin_area_1: "CA", postal_code: "95131", country_code: "US",
        } },
      }],
      payment_source: { paypal: input.vaultId ? {
        vault_id: input.vaultId,
        stored_credential: { payment_initiator: "MERCHANT", usage: "SUBSEQUENT", usage_pattern: "IMMEDIATE" },
      } : { experience_context: {
        return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: "PAY_NOW", shipping_preference: "SET_PROVIDED_ADDRESS",
      } } },
    }, input.requestId);
  }

  async getOrder(id: string): Promise<any> { return this.request("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`); }
  async captureOrder(id: string, requestId: string): Promise<any> {
    return this.request("POST", `/v2/checkout/orders/${encodeURIComponent(id)}/capture`, {}, requestId);
  }

  async createHoldOrder(input: {
    reference: string;
    capCents: number;
    description: string;
    returnUrl: string;
    cancelUrl: string;
    requestId: string;
  }): Promise<{ orderId: string; approveUrl: string }> {
    const order = await this.request<any>(
      "POST",
      "/v2/checkout/orders",
      {
        intent: "AUTHORIZE",
        purchase_units: [
          {
            reference_id: input.reference,
            description: input.description.slice(0, 127),
            amount: { currency_code: "USD", value: centsToUsd(input.capCents) },
          },
        ],
        payment_source: {
          paypal: {
            experience_context: {
              return_url: input.returnUrl,
              cancel_url: input.cancelUrl,
              user_action: "CONTINUE",
              shipping_preference: "NO_SHIPPING",
            },
          },
        },
      },
      input.requestId,
    );
    const link = order.links?.find((l: any) => l.rel === "payer-action" || l.rel === "approve");
    if (!link) throw new Error("PayPal returned no approval link");
    return { orderId: order.id, approveUrl: link.href };
  }

  async authorizeOrder(orderId: string, requestId: string): Promise<{ authorizationId: string; amountCents: number }> {
    const order = await this.request<any>("POST", `/v2/checkout/orders/${orderId}/authorize`, {}, requestId);
    const auth = order.purchase_units[0].payments.authorizations[0];
    return { authorizationId: auth.id, amountCents: usdToCents(auth.amount.value) };
  }

  async captureAuthorization(
    authorizationId: string,
    cents: number,
    requestId: string,
  ): Promise<{ captureId: string; status: string; amountCents: number }> {
    const capture = await this.request<any>(
      "POST",
      `/v2/payments/authorizations/${authorizationId}/capture`,
      { amount: { currency_code: "USD", value: centsToUsd(cents) }, final_capture: true },
      requestId,
    );
    return { captureId: capture.id, status: capture.status, amountCents: usdToCents(capture.amount.value) };
  }

  async voidAuthorization(authorizationId: string, requestId: string): Promise<void> {
    await this.request("POST", `/v2/payments/authorizations/${authorizationId}/void`, undefined, requestId);
  }

  /** A hold on the buyer's funds with the hotel as receiver. Captured, voided or refunded later. */
  async createStayOrder(input: { reference: string; cents: number; description: string; returnUrl: string; cancelUrl: string; requestId: string }): Promise<any> {
    return this.request("POST", "/v2/checkout/orders", {
      intent: "AUTHORIZE",
      purchase_units: [{ reference_id: input.reference, custom_id: input.reference, description: input.description.slice(0, 127),
        amount: { currency_code: "USD", value: centsToUsd(input.cents) } }],
      payment_source: { paypal: { experience_context: {
        return_url: input.returnUrl, cancel_url: input.cancelUrl, user_action: "CONTINUE", shipping_preference: "NO_SHIPPING",
      } } },
    }, input.requestId);
  }

  async getAuthorization(id: string): Promise<any> { return this.request("GET", `/v2/payments/authorizations/${encodeURIComponent(id)}`); }
  async getCapture(id: string): Promise<any> { return this.request("GET", `/v2/payments/captures/${encodeURIComponent(id)}`); }

  /** Full or partial refund of a captured payment. */
  async refundCapture(captureId: string, cents: number, requestId: string, note: string): Promise<any> {
    return this.request("POST", `/v2/payments/captures/${encodeURIComponent(captureId)}/refund`,
      { amount: { currency_code: "USD", value: centsToUsd(cents) }, note_to_payer: note.slice(0, 255) }, requestId);
  }

  async createPayout(input: {
    senderBatchId: string;
    senderItemId: string;
    receiverEmail: string;
    cents: number;
    note: string;
  }): Promise<{ payoutBatchId: string; batchStatus: string }> {
    const payout = await this.request<any>("POST", "/v1/payments/payouts", {
      sender_batch_header: { sender_batch_id: input.senderBatchId, email_subject: "You have a payout" },
      items: [
        {
          recipient_type: "EMAIL",
          receiver: input.receiverEmail,
          amount: { value: centsToUsd(input.cents), currency: "USD" },
          note: input.note,
          sender_item_id: input.senderItemId,
        },
      ],
    });
    return { payoutBatchId: payout.batch_header.payout_batch_id, batchStatus: payout.batch_header.batch_status };
  }

  async getPayout(payoutBatchId: string): Promise<{ batchStatus: string; itemStatus?: string }> {
    const payout = await this.request<any>("GET", `/v1/payments/payouts/${payoutBatchId}`);
    return { batchStatus: payout.batch_header.batch_status, itemStatus: payout.items?.[0]?.transaction_status };
  }
}
