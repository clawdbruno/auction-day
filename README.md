# Auction Day

A 3D browser game that simulates the *entire* process of buying your first home in
Australia — not just auction day, but everything the real process throws at a first
home buyer.

## The process (the game IS the lesson)

1. **Finance first.** Pick your household profile (income, expenses, HECS, credit
   card limit) and choose a Big Four bank or a mortgage broker. Borrowing power is
   computed the way lenders roughly do it — card *limits* cost you ~3.8× in
   capacity, HECS trims serviceability, the broker stretches further at a sharper
   rate. You get a pre-approval letter; nothing happens without it.
2. **Research.** Walk Banksia Street and *enter every house* — interiors are real
   floor plans that match the advertised beds/baths, with labelled rooms and
   dimensions. Order a building & pest report ($550) to learn true value and
   defects; pay a solicitor ($350) to review the contract & Section 32, which
   surfaces special conditions (easements, as-is clauses, executor terms).
3. **Buy.** Three homes go to auction (unconditional — the game warns you why),
   three are private sales: make offers, cop counters and "best and final" rival
   buyers, and choose whether to include a subject-to-finance clause.
4. **Sign.** An actual Contract of Sale with your clauses, a squiggle signature,
   10% deposit, and (private sales only) a 3-day cooling-off period — which
   vanishes if you buy within 3 days of an auction (s31, correctly).
5. **Settle.** The bank *values the property* before lending. Overpay without a
   finance clause and you either bridge the gap in cash or forfeit the deposit.
   Settlement itemises stamp duty (VIC brackets + FHB concession), LMI by LVR band,
   conveyancing, known repairs — and surprise costs if you skipped the homework.

Underquoted guides, vendor bids, pass-in negotiations, and 1.5%/week market growth
all included. Verdict scored against true market value.

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
- Bid/offer/sign through the UI panels

## Debug hooks (headless testing)

`window.__game`: `state()`, `listings()`, `preapprove()`, `start(difficulty, fhb)`,
`teleport(x, z)`, `openPanel(id)`, `startAuction(id)` (bypasses the solicitor
warning), `offer(id, amount, stf)`, `clickDialog(labelSubstring)`,
`signContract()`, `bid(increment)`, `skip(seconds)` (fast-forward auction time),
`collectKeys()`, `frame(dt)` (forces one update+render — required where
`requestAnimationFrame` is throttled), plus `_raw`, `_scene`, `_houses`,
`_player`, `_camera`, `_renderer`, `_solids`, `_THREE` for inspection.

Collision is AABB-based (`_solids`): walls, fences (with gate gaps), and large
furniture. Doorway gaps are ≥1.2 m wide against a 0.3 m player radius.

Notes for headless work: the renderer guards 0×0 `innerWidth` resizes (they NaN
the projection matrix); ceilings are MeshBasicMaterial and the fascia sits 1 cm
above the ceiling plane — both were z-fighting/hemisphere-tint lessons.

## Stack

Three.js + Vite, no other dependencies. All geometry procedural; signs and room
labels are canvas textures (`alphaTest: 0.01` on mapped shadow-casting materials,
per the three.js r166 shared-depth-material shadow bug).
