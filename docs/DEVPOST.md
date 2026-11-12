# Devpost submission text (draft, paste into the form)

## Project name
Morrow: deals without the inbox

## Tagline
Tell an agent what coffee you need. It gets a private one-time offer from roasters and pays through PayPal. No
mailing list, no subscription.

## Inspiration
I drink one or two cups a day and I wait for discounts before I restock. To hear about a roaster's sale I have to
join its mailing list or start a subscription, and I want neither. I only want one bag of the right coffee at a fair
price before I run out. Brands reach buyers through lists. I wanted to turn that around: let the buyer's real,
ready-to-pay need reach the brand.

## What it does
- You describe the restock in plain words and confirm a short rule card: products, bags, roasters, a good-deal
  target, a hard maximum including tax and shipping, and a delivery deadline.
- Your buyer agent sends one structured request to each approved roaster's agent.
- Each roaster agent answers with one all-in, one-time quote.
- Code checks every term and selects the cheapest quote that passes.
- PayPal handles the payment, with the roaster's merchant account as the receiver. The app then reads the order
  back from PayPal and compares it with the quote before showing a receipt.
- The task closes after one purchase.

## How I built it
- TypeScript and Express, with a plain HTML, CSS and JavaScript front end.
- PayPal Orders v2 in the sandbox: create order, buyer approval, capture, and a read-back check. Every request
  carries a unique request ID so a retry can't charge twice.
- PayPal's save-payment-method endpoints (Vault v3 setup tokens) for the "buy once automatically" mode.
- AI reads the buyer's request and explains results. All amounts and rule checks are code, in integer cents.

## What is real and what is simulated
- Real: PayPal sandbox API calls for the order, approval, capture and read-back.
- Simulated: both roasters, their products, prices and quotes. One sandbox merchant account stands in for one
  roaster. No coffee ships. There are no real customers or merchants.
- Not claimed: buying with the buyer absent across several roasters. That needs PayPal's platform onboarding.

## Challenges
- The first design held the buyer's money and paid the merchant later through Payouts. That made the platform the
  seller, which was the wrong relationship, so I rebuilt it around paying the roaster directly.
- A saved PayPal payment method belongs to one merchant, so "buy from any roaster while I'm away" can't be faked
  with one account. The app shows the limit instead of hiding it.

## What I learned
Stating a need is not permission to pay. The design keeps three numbers apart: the roaster's public price, the
buyer's good-deal target, and the maximum the buyer approved.

## What's next
- PayPal platform onboarding so each roaster is paid on its own account, and PayPal's agentic commerce services.
- Letting the agent suggest verified roasters the buyer doesn't know yet, confirmed once by the buyer.
- A real roaster pilot to test whether private one-time offers are worth it for them.

## Built with
TypeScript, Node.js, Express, PayPal Orders API v2, PayPal Vault API v3, PayPal sandbox, Claude API

## Testing instructions (Devpost field, not public)
Paste here: the repository's run steps, and the email and password of a PayPal **sandbox buyer** account.
