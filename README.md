# Morrow: deals without the inbox

A one-time coffee restock agent. You say what you drink and set your limits. Your buyer agent asks roasters'
agents for a private one-time offer, checks every term in code, and pays the roaster through PayPal. No mailing
list, no subscription, one purchase, then the task closes.

Built for the Devpost hackathon "Build What's Next with PayPal and AI".

## What is real and what is simulated

| Part | Status |
|---|---|
| PayPal order, buyer approval, capture and read-back | Real PayPal **sandbox** API calls. No live money. |
| Who receives the payment | The one sandbox merchant account connected to this app, standing in for the roaster "Morrow Roasters". The app never collects the money and forwards it. |
| AI reading of the request | Real Claude API call (`claude-opus-5-5`) when `ANTHROPIC_API_KEY` is set. It extracts cups per day, stock left and taste, and picks matching catalog products. Code turns that into bags and a delivery limit. The AI never proposes a price, target or maximum, and the buyer confirms everything. Without a key the app says so and the buyer fills in the card by hand. |
| Roasters (Morrow Roasters, Daybreak Coffee), their products and prices | Fictional and simulated. Daybreak only quotes and has no payment connection. |
| Roaster quotes | Produced by fixed rules (stock, price floor, tax, shipping, delivery days), not by a language model. |
| Buying with the buyer absent | The app can ask PayPal to save a payment method for the connected merchant. See "Known limits". |
| Roaster console (`/roaster.html`) | Simulated. Anyone can edit the two fictional roasters' offer rules and see the anonymous requests their agents received. A real console would need a roaster sign-in. |
| Waiting and asking again | The buyer can ask the roasters again in a new round; the request is the same and the target and maximum are never sent. Automatic daily re-asking is not built. |
| Notifications | In-app receipt only. No push, no email. |
| Coffee | None is shipped. |

There are no real customers and no real merchants. See [docs/DESIGN.md](docs/DESIGN.md) for the product
decisions and what is unverified.

## How it works

1. The buyer describes the restock and confirms a short rule card: products, bags, roasters, a good-deal target,
   a hard maximum including tax and shipping, a delivery deadline, and one-time only.
2. The buyer agent sends one structured request to each approved roaster agent.
3. Each roaster agent answers with one all-in quote.
4. Code checks every quote: approved roaster and product, quantity, arithmetic, maximum, delivery date, no
   subscription, currency and region, not expired. The cheapest qualifying total is selected.
5. PayPal: an order is created with the roaster's merchant account as the receiver. The buyer approves it in
   PayPal, the app captures it, then reads the order back and compares amount, currency and receiver with the quote
   before showing a receipt.
6. The task closes. It can't buy twice.

Money rules live in code. Amounts are integer cents. Each PayPal request carries a unique request ID so a retry
can't charge twice.

## Run it locally

Requires Node.js 20.12 or newer and a PayPal sandbox app (free at https://developer.paypal.com/dashboard/).

```bash
npm install
cp .env.example .env.sandbox   # then paste your sandbox client ID and secret, and a Claude API key, into .env.sandbox
npm start
```

Open http://localhost:4030. To pay, sign in on PayPal's page with a **sandbox personal (buyer) account** from the
same developer dashboard. Never use a real PayPal login or live credentials.

```bash
npm test          # unit tests
npm run typecheck
```

## Known limits

- Automatic buying is not claimed as verified. The sandbox accepted the request to start saving a payment
  method, but a charge with the buyer absent has to be proven per account, and a saved method belongs to one
  merchant. A real multi-roaster product needs PayPal's platform onboarding.
- PayPal's agentic commerce services need an access request and are not used here.
- Refunds, disputes and delivery problems are not built.
- One region and currency (California, USD), 1 to 8 bags, delivery within 1 to 30 days, a $200 demo maximum.

## License

MIT. See [LICENSE](LICENSE).
