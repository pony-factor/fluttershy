# Fluttershy ✦

A **self-hosted flight concierge** with preference-aware flight search, encrypted traveler profiles and loyalty numbers, cash-versus-points comparison, persistent price watches, and a consent-gated booking flow. The browser app uses direct flight distribution APIs where possible rather than brittle third-party website automation.

## Current capabilities

- **Live cash fares:** Duffel offer requests with adult travelers, one-way or return trips, cabin classes, connection limits and operating-carrier disclosure. Results are ranked by cheapest, fastest, fewest stops or balanced score. Block airlines by IATA code; Frontier (`F9`) is blocked by default, alongside a configurable budget-carrier exclusion.
- **Persistent background search:** encrypted watchlists, cached recent searches (5 minutes), deduplicated concurrent searches and periodic re-searches (default: 30 minutes). Watches run only while the service is running; no auto-purchase. Watch matching is currency-specific and price changes must be rechecked before any order.
- **Traveler vault:** AES-256-GCM encrypted local data including saved traveler identity, loyalty numbers, linked-account token references and payment-provider **token references only**. Airline passwords, raw payment card numbers and CVVs are not accepted. Token references are **not** payment instruments until a compatible provider integration is implemented. Vault never sends raw saved values back to the browser.
- **Cash booking:** server-side fresh-offer retrieval, optional loyalty-profile enrichment and repricing, review quote expiring after five minutes, exact-price acknowledgement and a separate explicit confirmation. A persisted submission marker prevents accidental duplicate orders after ambiguous provider errors. Uses the **Duffel balance** payment method only. Disabled unless `ENABLE_LIVE_BOOKING=true`.
- **Miles comparison:** import verified award-availability quotes manually and compare taxes + (miles × user-selected cents per mile) against available USD cash fares. No invented points availability. **Award searches, miles transfers, award bookings, online card charges and airline-account OAuth are not implemented.** They require contracted APIs, booking permissions and/or payment partners.

## Requirements and setup

Node.js 22+ and a [Duffel API token](https://duffel.com/docs/guides/getting-started-with-flights). Duffel airline participation and live-mode access vary. A test token permits safe sandbox searches and sandbox orders. Bookings through Duffel balance require the appropriate Duffel account, funds and commercial eligibility. Do not put credentials in code or GitHub.

```sh
# Use two distinct random 32-byte hex values (keep both securely out of git).
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
export DATA_ENCRYPTION_KEY='first-generated-value'
export API_TOKEN='second-generated-value'
export DUFFEL_ACCESS_TOKEN='duffel_test_...'
npm start
```

Visit http://127.0.0.1:3434, enter `API_TOKEN` in the connect panel and create a saved traveler. Use `npm test` for the offline tests. The app binds to loopback by default. It does **not** implement account registration, external OAuth redirects, passkeys, role-based authorization, hosted checkout or multi-user isolation. Do not expose it on the public internet as-is; a production deployment needs HTTPS, managed authentication, KMS/secrets handling, audit logs, rate limits and a durable transactional database/queue. The single-process encrypted JSON store is intentionally an initial implementation.

### Enable booking explicitly

Only after testing with a Duffel test token and validating your supplier agreements, use `ENABLE_LIVE_BOOKING=true` to enable the booking endpoint. Confirm the traveler data and fare restrictions before proceeding. The booking checkout creates an instant **Duffel-balance** order; saved payment token references are **not charged**. A provider failure can be ambiguous; when status is `requires_reconciliation`, manually check Duffel orders before doing anything else. Avoid running more than one process against the same `DATA_FILE`.

## JSON API

Send `Authorization: Bearer <API_TOKEN>` with all `/api/*` requests. Browser interface files are public but cannot read or modify data without the API token.

| Method | Route | Function |
| --- | --- | --- |
| GET | `/api/health`, `/api/state` | Connectivity, masked saved preferences and statuses |
| PUT | `/api/profile` | Save optimization, carrier exclusions, points valuation |
| PUT / DELETE | `/api/travelers/:id` | Create/delete encrypted adult traveler and frequent-flyer numbers |
| PUT / DELETE | `/api/payment-tokens/:id` | Save/delete provider token **reference** (not PAN/CVV) |
| PUT / DELETE | `/api/accounts/:id` | Save/delete external account token **reference** (not passwords or live OAuth connection) |
| POST | `/api/search` | Fresh or cached Duffel cash fare search |
| POST | `/api/watches` | Add persistent periodic price watch |
| POST / DELETE | `/api/watches/:id/refresh`, `/api/watches/:id` | Force re-search or delete a watch |
| POST / GET | `/api/awards`, `/api/compare?origin=JFK&destination=LAX&departure_date=YYYY-MM-DD` | User-entered award quote and cost comparison |
| POST | `/api/bookings/quote` | Verify fare, apply saved loyalty identifiers, issue short-lived approval phrase |
| POST | `/api/bookings/confirm` | Check approval phrase + fare terms, reprice and create one Duffel instant order |
| GET | `/api/bookings/:quote_id/calendar.ics` | Export confirmed trip date-only calendar events |

Example:

```sh
curl -H "Authorization: Bearer $API_TOKEN" -H 'Content-Type: application/json' \
  -d '{"origin":"JFK","destination":"LAX","departure_date":"2026-11-19","adults":1,"cabin_class":"economy","max_connections":1}' \
  http://127.0.0.1:3434/api/search
```

### Design notes

- Discounts from airline loyalty programs may require updating individual offer passengers and fetching the offer again; the quote flow does both when loyalty accounts are saved.
- The operating **carrier**, not just the marketing brand, is included for each segment, as required in flight offer displays.
- Mixed-currency cash prices are deliberately **not** compared against USD budgets as if FX were 1:1. A currency adapter is needed for a true global optimization.
- A miles valuation estimate is **not** guaranteed award availability. Award quotes are user-supplied and are not bookable through this Duffel integration.
- Flight offers are time-limited and can change; the checkout rejects changed totals or itineraries instead of silently paying more.
- Refundability, baggage, government fees, ticketing rules and cancellation terms vary by ticket. Before production checkout, add explicit fare-condition disclosure fetched from the supplier for each booked offer and a compliant customer payment collection flow.
- Confirmed bookings can be exported as `.ics` calendar files from the browser. Events are **date-only** to avoid assigning an incorrect timezone to airport-local departure times; exact local flight times are included in the event description. Google Calendar OAuth sync remains planned, not currently connected.

### Relevant primary API references

- [Duffel flight search / offer requests](https://duffel.com/docs/api/v2/offer-requests)
- [Duffel current offer / passenger loyalty accounts](https://duffel.com/docs/api/v2/offers)
- [Duffel orders and payments](https://duffel.com/docs/api/v2/orders)
- [Duffel getting started with flights](https://duffel.com/docs/guides/getting-started-with-flights)
- [Duffel loyalty programme accounts](https://duffel.com/docs/guides/adding-loyalty-programme-accounts)
