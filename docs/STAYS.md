# Stays: design notes

Product decisions for the hotel demo, with what is built and what is assumed. Hotels and offers are simulated.

## Decisions

| Topic | Decision | Status |
|---|---|---|
| What the numbers mean | The target and the maximum cover the whole stay, all nights plus taxes. The form shows the per-night equivalent as you type, and every offer cell says "total for N nights with taxes". | Built |
| Which offer the buyer can take | Any offer in the latest round that passes every rule. Pip preselects the lowest total; the buyer can click another. | Built |
| Offers that fail a rule | An offer above the maximum or missing a must-have can't be booked. The buyer would have to change the rule in a new request. Raising a limit is never done silently. | Built |
| Waiting once | "Wait and ask again" moves the demo clock and asks one round. | Built |
| Automatic watching | "Watch daily for me" asks once a day and stops at the first offer that meets the target, or on the buyer's stop day. It never books. | Built on the demo clock. A real scheduler is not built. |
| Whether waiting pays | It can go either way. A hotel with soft demand lowers its private rate toward check-in. A hotel with strong demand raises it, up to 15% above its public rate. One of the three demo hotels has strong demand. | Built as a simulation |
| Help deciding | Each cell shows the move since the last round, a sentence counts how many hotels went down or up, and a watched request shows the best passing offer day by day. | Built |
| Market price history | A reference such as "typical price for these dates" would help the wait-or-book decision. | Not built. See below. |

## Does a hotel's price really fall near the date?

Often, not always. **[verified by search, 13 Nov 2026; the main sources sell bookings, so treat them as directional]**

- Expedia's 2026 Hotel Price Index reports last-minute bookers saved 23% on average against booking four or more months ahead.
- KAYAK says the lowest hotel prices tend to appear in the week of the stay.
- RatePunk's tracking found the opposite for resorts: in about 70% of cases the price was lowest six to seven months ahead and rose toward check-in.
- The driver is demand. Peak season, popular places and local events push prices up near the date, and waiting risks finding no room.

So the demo models both directions, and Pip describes waiting as a bet, not as a saving.

## Where a real price reference could come from

**[verified by search, 13 Nov 2026]**

- Google Hotels rates a price as low, typical or high against its history, but offers no public export of that history.
- Google's Hotel Prices API is for hotel partners' own reporting, not consumer price history.
- Third parties (SerpApi, Apify actors, DataForSEO, ScrapingBee) expose Google Hotels prices; storing results over time builds a history. Terms of use and cost would need checking before use.

## Assumptions still untested

- That hotels would answer agent requests with private rates. Hotels already give hidden rates to closed groups, which suggests willingness, but no hotel has been asked.
- That buyers will set a target and wait. The automatic watch exists because most buyers won't check daily.
