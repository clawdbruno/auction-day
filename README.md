# Auction Day

A 3D browser game that simulates the *entire* end-to-end process of buying your
first home in Australia — built to help people who've never bought property
understand what actually happens, in order, with real-ish numbers.

## The journey (the game IS the lesson)

1. **Finance first.** Pick a household profile (income, expenses, HECS, credit
   card limit — lenders assess the *limit*, not the balance) and choose a Big Four
   bank or a mortgage broker. Serviceability is stress-tested (APRA buffer),
   approval takes real time (bank ~3 weeks, broker ~1) and **prices rise while you
   wait**. The broker raises government schemes automatically; the bank only
   answers what you ask — tick the box or miss the First Home Guarantee.
2. **Government schemes, correctly.**
   - *First Home Guarantee*: 5% deposit with **no LMI**, income caps
     ($125k/$200k) and an $800k property cap — bid past the cap at auction and LMI
     snaps back.
   - *First Home Owner Grant*: $10k, **new homes ≤ $750k only** (the brand-new
     apartment is listed at $749,000, one dollar under the cap, as agents do).
     Established homes don't qualify, no matter what your uncle reckons.
   - Stamp duty FHB exemption ≤ $600k, concession to $750k (VIC brackets).
3. **Pick your legal team.** Budget online conveyancer ($780, 50% chance a
   special condition sails through "reviewed", 40% chance of a late settlement),
   local solicitor ($1,500, reads every page), or boutique firm ($2,400, catches
   everything and negotiates a price allowance for what it finds).
4. **Research.** Walk into every house — interiors match the advertised
   beds/baths with labelled rooms. Building & pest reports reveal true value and
   defects. Contract & Section 32 reviews surface special conditions. For the
   apartment: **owners corporation records** ($300) reveal quarterly fees, a thin
   sinking fund, and a looming special levy you'll otherwise meet as a surprise.
5. **Buy.** Three auctions (unconditional — the game explains why that's
   dangerous) and three private sales with offers, vendor counters, "best and
   final" rival buyers, and the subject-to-finance decision.
6. **Sign.** A real Contract of Sale: 10% deposit, cooling-off (voided within 3
   days of an auction, per s31), OC clause if applicable — and you choose the
   loan structure (variable + offset / fixed / split) with the monthly repayment
   spelled out before you sign.
7. **Settle.** Bank valuation first (shortfall → bridge the gap, escape via the
   finance clause, or forfeit the deposit). Then the **final inspection** (missing
   dishwasher, anyone?), **settlement day on PEXA** with a statement of
   adjustments (prorated rates/water), penalty interest if your cheap conveyancer
   misses the booking — and finally the keys, a full cost breakdown, and a verdict
   against true market value.

## Run

```sh
npm install
npm run dev   # http://localhost:5291
```

Or via the shared launch config: server name `auction-day`.

## Controls

- **WASD** move, **mouse** look (click to capture cursor, ESC to release)
- Walk through the front gate and open front door to inspect interiors
- **E** or click a house — open the listing
- Everything else happens through the UI panels

## Debug hooks (headless testing)

`window.__game`: `state()`, `listings()`, `preapprove()`, `selectChip(rowId, idx)`,
`start(difficulty, fhb)`, `teleport(x, z)`, `openPanel(id)`, `startAuction(id)`,
`offer(id, amount, stf)`, `clickDialog(labelSubstring)`, `signContract()`,
`bid(increment)`, `skip(seconds)`, `collectKeys()`, `frame(dt)` (forces one
update+render — required where `requestAnimationFrame` is throttled), plus
`_raw`, `_scene`, `_houses`, `_player`, `_camera`, `_renderer`, `_solids`,
`_THREE`. Rig randomness via `_raw` (e.g. `_raw.reviewMissed.add(id)`,
`_raw.solicitor = {...s, delayChance: 1}`).

Headless notes: guard 0×0 `innerWidth` resizes (NaN projection = blank scene);
ceilings are MeshBasicMaterial and the fascia sits clear of the ceiling plane
(z-fight); new-home listings are exempt from weekly price growth so the FHOG cap
demo survives the approval wait.

## Stack

Three.js + Vite, no other dependencies. All geometry procedural; signs and room
labels are canvas textures (`alphaTest: 0.01` on mapped shadow-casting materials).

*Rates, duties, caps and scheme rules are close to real (c. 2025, VIC) but
simplified — it's a game, not financial or legal advice.*
