# Design: one-time coffee restock agent ("deals without the inbox")

Status: written Thu 12 Nov 2026, 19:20 Zurich. Hackathon: "Build What's Next with PayPal and AI" (Devpost).
Every claim is tagged **[verified]**, **[assumed]** or **[simulated]**. Nothing here has real customers or real merchants.

## One-line pitch

Tell the agent what coffee you need. It asks roasters for a private one-time offer and buys once through PayPal,
with no mailing list and no subscription.

## The human need

> "I drink one or two cups of coffee every morning. I like medium-dark roast and want to try something new now and
> then, but nothing flavoured or sweetened. I liked my last bag and it will last two more weeks. Check these
> roasters' own shops and buy once if there is a good price. I don't want to sign up for emails or a subscription."

Today a brand reaches a buyer by putting them on a mailing list. Here the buyer's real, ready-to-pay need goes to the
brand, and the brand answers with a private one-time offer. The brand gets a sale without a public markdown, and the
buyer gets the deal without the inbox. **[assumed: not tested with any real roaster or buyer]**

## Locked decisions

| # | Decision | Locked choice |
|---|---|---|
| 1 | First customer and category | A daily coffee drinker (1 to 2 cups) restocking whole beans bought directly from roasters. They have time flexibility because they order before the current bag runs out. **[assumed]** |
| 2 | Why a roaster quotes | A private one-time price needs no public discount; roasted beans lose value within weeks; a new customer may reorder. **[assumed]** |
| 3 | Waiting and holds | No long hold of the buyer's money. The task stays open until a quote qualifies or the buyer cancels. The first qualifying quote closes the task. |
| 4 | Winner rule | Code only. A quote qualifies if it matches the approved products, arrives before the beans run out, and its total (tax and shipping included) is under the approved cap and at least 10% below the roaster's official one-time price. If several qualify at once, the lowest total wins. The rule is shown to the buyer before approval. No promise of the lowest future price. |
| 5 | Quote format | One round of structured request and quote between the buyer's agent and each roaster's agent. No haggling, no sealed auction. |
| 6 | Substitutes | The buyer approves a product range (roast level, no added flavouring or sugar, bag size). Anything outside it needs the buyer's confirmation. "Natural chocolate notes" is not added flavouring. Unknown ingredients are never treated as verified. |
| 7 | Platform fee | None in the MVP (minimum viable product). A fee paid by the roaster on completed sales is the likely real model. **[assumed]** |
| 8 | Who the seller is | The roaster. The PayPal order names the roaster as the receiver. The platform never collects the buyer's money and never uses Payouts to forward it. |
| 9 | Refunds and delivery failures | Out of the MVP. The roaster is the seller, so its own returns policy and PayPal's buyer protections apply. **[assumed: protections not checked for this flow]** |
| 10 | Which roasters | Roasters the buyer approved, plus new roasters of a similar level that the agent suggests. A suggested roaster must be a verified genuine seller, and the buyer confirms it once before any purchase. Never an unknown third-party reseller. In the MVP the "verified" mark is **[simulated]**. |
| 11 | Two modes | "Find it, then ask me" is the real, demonstrated payment. "Buy once automatically" is shown only if a charge without the buyer present is verified; otherwise it is labelled as needing PayPal's saved-payment approval. |
| 12 | Money rules | Three separate numbers: the roaster's official one-time price (a reference, with source and time), the "good price" rule (10% below reference), and the approved maximum total. Stating a need is not permission to pay. Going over the cap always asks the buyer. |
| 13 | AI versus code | AI reads the request, talks to the roaster agents and explains the result. Code sets every amount and enforces every rule. Roaster quotes come from fixed rules (stock, price floor, delivery days), not from a language model. |

## MVP scope

- Coffee only, one region and currency (US, USD).
- One buyer agent and two roaster agents: Morrow Roasters and Daybreak Coffee. Both brands are fictional. **[simulated]**
- Morrow is connected to one PayPal sandbox merchant. Daybreak has no payment connection and only quotes. **[simulated quotes, real sandbox payment for Morrow]**
- Chat request, approval card, one round of quotes, rule check, one PayPal sandbox payment, receipt, task closed.
- Safety floor: no double charge (each payment request carries a unique key), the PayPal order is read back and checked against the quote before the receipt is shown, cancelling stops the task, and a closed task never buys again.
- Notifications are in-app only and labelled as such.

## What is verified about payment

- **[verified, 12 Nov 18:05 UTC]** The sandbox accepted a request to start saving a PayPal payment method (HTTP 201, waiting for the buyer's consent).
- **[not verified]** A charge with the buyer absent. Until it is, no screen or sentence may call a purchase "automatic".
- **[verified, 12 Nov 18:47 UTC]** A buyer-approved sandbox order was captured once for $36.00 with the connected merchant account as receiver. An independent read of the order from PayPal matched the app's receipt on status (COMPLETED), amount, currency, receiver and capture ID.
- **[verified, 12 Nov]** The Claude API reads the request and returns structured facts; code turns them into bags and a delivery limit.
- **[assumed]** A saved payment method belongs to one merchant, so it cannot be reused across roasters without PayPal's platform onboarding.
- PayPal's agentic commerce services need an access request and are not used.

## Out of scope

Multi-round haggling, auctions, flexible budgets, target-price tracking, price-history charts, push or email
notifications, weekly digests, refunds and disputes, real roaster integrations, scraping real shops, contacting real
merchants, live payments, more than one category.

## Demo script (under 3 minutes)

1. **0:00 to 0:25, the need.** The buyer types the request above. The agent replies with what it understood and how many bags cover a month.
2. **0:25 to 0:50, the approval card.** Product range, two bags, roasters, cap including tax and shipping, deliver-by date, one-time only, mode. The buyer approves.
3. **0:50 to 1:30, agents talk.** The buyer agent sends one structured request. Each roaster agent answers from its rules. Show the roaster's side for ten seconds: "a buyer ready to pay, no email collected", and its offer rule. Label: simulated roasters.
4. **1:30 to 2:10, the payment.** The qualifying quote appears. The buyer confirms in PayPal (sandbox). The app reads the order back from PayPal and shows the receiver and amount.
5. **2:10 to 2:40, the success moment.** "Your next month of coffee is sorted. Two bags, total $36 with tax and shipping, arriving before you run out. One-time purchase, no subscription." Amounts are demo data.
6. **2:40 to 3:00, honesty slide.** What is real (PayPal sandbox payment to the roaster's account), what is simulated (roasters, quotes, verification), and what the real product needs (PayPal saved payment methods and platform onboarding).

## How judges try it

Run instructions go in the README. A sandbox buyer login goes in Devpost's testing instructions field, never in the
repository.

## How the two agents talk

- The buyer agent sends each approved roaster agent one `quote_request`: one-time purchase, no subscription, no marketing consent, approved product IDs for that roaster, quantity, deliver-within days, region and currency.
- It never sends the buyer's name, email, good-deal target or payment maximum. A roaster can't price up to a limit it can't see. **[built]**
- The roaster agent answers with one `quote`: lines, unit price, shipping, tax, total, delivery days, expiry, and `subscription: false`. It prices from its own offer rule (floor price, stock, delivery days). **[simulated: fixed rules, no real roaster]**
- The app shows both messages and the roaster's rule under "The roaster's side" on every task.
- A roaster console (`/roaster.html`) lets the simulated roaster edit its offer rule (price per bag, shipping, delivery days, on or off) and see the anonymous requests its agent received, what it answered and the outcome. **[built, simulated: no roaster sign-in]**
- A task can ask again in a new round. Each round sends the same request, and the first quote that meets the target can be paid. **[built: the buyer presses "ask again"; a daily automatic re-ask is not built]**

## Next version: waiting, second rounds and several offers (designed, not built)

**How a roaster's offer reaches the buyer agent**
1. Hosted rule (first step): the roaster sets an offer rule on a seller page (floor price, stock, dates) and the platform runs its agent. No engineering needed from a small roaster.
2. Own agent: a larger roaster connects its own endpoint that answers `quote_request` with `quote`.
3. No connection: the buyer agent reads the public shop price as a reference only. A public price is never treated as an offer, and reading a shop is not consent to receive requests.

**Waiting and second rounds**
- A task stays open until the last day an order would still arrive in time (deliver-by date minus the roaster's shipping days).
- The buyer agent asks again once a day, and a roaster may send an improved quote at any time, for example when a batch nears its roast date.
- Every round sends the same request. The buyer's target and maximum are never revealed, and the buyer agent does not haggle.
- The first quote that meets the target closes the task. Nothing is promised about a lower price later.
- If the last day arrives with quotes under the maximum but above the target, the buyer is asked once. Above the maximum is never bought.

**Several offers at once**
- Every quote passes the same code checks. Among those that pass, the lowest total including tax and shipping wins.
- Ties go to the earlier delivery, then to the fresher roast date.
- A roaster that isn't chosen is told only "not selected". It never sees another roaster's price.
- One order goes to one roaster. Splitting bags across roasters is out, because each adds its own shipping fee.

Built so far: the hosted offer rule (simulated console), manual ask-again rounds, and lowest-total selection across roasters. Still **[assumed]** design: automatic daily re-asking, roaster-pushed quotes, the last-day question, roast-date tie-breaks, and telling a roaster "not selected" in real time.
