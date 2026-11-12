# Payment design: Pip Buy

How money moves in Pip Buy, why each choice was made, and what is proven. Hotels, roasters and their offers are
simulated. Every PayPal call is a real sandbox call. There are no real customers or merchants.

## The rules that never change

1. **The merchant is the receiver.** The PayPal order names the hotel's or roaster's merchant account. Pip Buy never
   collects the buyer's money and forwards it. An earlier design held funds and paid merchants through Payouts; that
   made the platform the seller, with the refund and dispute duties that come with it, so it was dropped.
2. **Stating a need is not permission to pay.** Three numbers stay separate: the merchant's public price, the buyer's
   good-deal target, and the buyer's maximum. The target and maximum are never sent to a merchant.
3. **AI reads, code decides.** Claude turns the request into nights, guests and must-haves. Every amount, every rule
   check and every payment step is code, in integer cents.
4. **One of each payment action per booking.** Each PayPal request carries a fixed request ID
   (`<booking>-order`, `-authorize`, `-capture`, `-void`, `-refund`), so a retry returns the first result instead of
   repeating the action.
5. **Read back before believing.** After every action the app fetches the authorization or capture from PayPal and
   compares status and amount before it records the step as verified.
6. **Unknown outcome means stop.** A failed or unclear payment step puts the booking in "needs review". Nothing is
   retried automatically and no second order is ever created.

## Stays: which payment path, and why

PayPal honors a hold (an authorization) for 3 days. After that a capture is no longer guaranteed. **[from PayPal's
documentation as read earlier in this project; not re-verified today]** So the path depends on how far away check-in is.

| When booked | Path | At booking | At check-in |
|---|---|---|---|
| 3 days or less before check-in | Hold now, pay at check-in | Full amount held, nothing charged | Hold captured |
| More than 3 days before check-in | Pay at booking, refundable | Held, then captured at once | No payment action |

## Stays: what a cancellation does

"Free" means the guest cancels on or before the hotel's free-cancellation deadline, or the hotel cancels.

| Booking state | Free cancellation | Late cancellation by the guest |
|---|---|---|
| Held | Hold voided. Charged $0. | First night captured as a final capture. The rest of the hold is released. |
| Paid | Full refund. | Refund of the total less the first night. |

## Booking states

`open` → `awaiting_approval` → `held` or `paid` → `completed`, `voided`, `fee_captured` or `refunded`.
`needs_review` can follow any payment step. `cancelled` ends a request that never reached payment.

## What is proven, and how

| Claim | Evidence |
|---|---|
| Coffee: buyer-approved order captured once, receipt matches PayPal | **Live sandbox**, 12 Nov 2026: $36.00, order and capture COMPLETED, read independently |
| Stays: order with intent AUTHORIZE is created for the offer total | **Live sandbox**, 12 Nov 2026: order created, waiting for buyer approval |
| Stays: hold, capture at check-in, void, late fee, full and partial refund, hotel-initiated refund | **Unit tests** with a stand-in for PayPal (13 tests). **Not yet run live**: each needs a buyer to approve in PayPal's sandbox |
| A declined charge never causes a second order or charge | **Unit tests**, both flows |
| Buying with the buyer absent | **Not proven**. Needs PayPal saved payment methods and platform onboarding |

## Known gaps

- A booking made more than 3 days out is charged at once. A real product could instead save the payment method and
  charge at check-in; that needs PayPal's vault with platform onboarding.
- No webhooks. The app learns about payment changes only when it asks PayPal.
- Disputes, chargebacks, currency conversion and tax handling are out of scope.
- The hotel dashboard has no sign-in, so anyone using the demo can press the hotel's buttons.
