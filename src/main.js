import * as THREE from 'three';
import { LISTINGS } from './listings.js';
import { buildWorld, buildPerson } from './world.js';
import { Player } from './player.js';
import { Auction } from './auction.js';
import {
  fmt, round1k, settlement, maxPurchase, monthlyRepayment, borrowingPower,
  LENDERS, INCOMES, EXPENSES, CARD_LIMITS,
  REPORT_COST, REVIEW_COST, DEPOSIT_PCT, COOLING_OFF_PENALTY,
} from './finance.js';

// ---------- game state ----------

const game = {
  phase: 'start', // start | explore | auction | settled | over
  week: 1,
  savings: 180000,
  preApproval: 0,
  lender: null,
  rate: 0,
  fhb: true,
  heat: 'balanced',
  soldTo: {},          // listingId -> 'you' | 'rival'
  reports: new Set(),  // building & pest purchased
  reviews: new Set(),  // solicitor contract review purchased
  ownedId: null,
  auction: null,
  pendingContract: null, // { listing, price, method, stf }
  offerRound: 0,
};

const listings = LISTINGS.map((l) => ({ ...l }));
const byId = Object.fromEntries(listings.map((l) => [l.id, l]));

const kfmt = (n) => n >= 1000000 ? `$${(n / 1e6).toFixed(2)}m` : `$${Math.round(n / 1000)}k`;
const signTextFor = (l) => l.saleType === 'auction'
  ? `${kfmt(l.guide[0])} – ${kfmt(l.guide[1])}`
  : fmt(l.asking);
const playerMax = () => maxPurchase(game.savings, game.preApproval, game.fhb);

// ---------- three.js scene ----------

const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
const viewW = () => innerWidth > 0 ? innerWidth : 1280;
const viewH = () => innerHeight > 0 ? innerHeight : 720;
renderer.setSize(viewW(), viewH());
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9ec8e8);
scene.fog = new THREE.Fog(0x9ec8e8, 90, 220);

const camera = new THREE.PerspectiveCamera(72, viewW() / viewH(), 0.1, 400);

scene.add(new THREE.HemisphereLight(0xcfe5ff, 0x5e7a44, 0.85));
const sun = new THREE.DirectionalLight(0xfff2d8, 1.4);
sun.position.set(12, 80, 45);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -80, right: 80, top: 100, bottom: -100, far: 250 });
scene.add(sun);

const { houses, solids } = buildWorld(scene, listings, signTextFor);
const player = new Player(camera, renderer.domElement);
player.solids = solids;

addEventListener('resize', () => {
  if (innerWidth <= 0 || innerHeight <= 0) return; // headless/hidden windows fire 0×0 resizes
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------- tiny sounds ----------

let audioCtx = null;
function blip(freq = 660, dur = 0.08, type = 'square', gain = 0.05) {
  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(gain, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + dur);
  } catch { /* audio optional */ }
}
const gavel = () => { blip(180, 0.15, 'triangle', 0.12); setTimeout(() => blip(140, 0.2, 'triangle', 0.1), 90); };

// ---------- DOM helpers ----------

const $ = (id) => document.getElementById(id);
const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

let toastTimer = null;
function toast(msg, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.style.opacity = '1';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.opacity = '0'; }, ms);
}

function freeze() { player.enabled = false; player.releaseLock(); }
function unfreeze() {
  if (game.phase === 'explore' || game.phase === 'settled') {
    player.enabled = true;
    player.requestLock();
  }
}

// generic dialog
function dialog(title, bodyHTML, buttons) {
  freeze();
  $('dlg-title').textContent = title;
  $('dlg-body').innerHTML = bodyHTML;
  const wrap = $('dlg-btns');
  wrap.innerHTML = '';
  for (const b of buttons) {
    const btn = document.createElement('button');
    btn.className = 'btn' + (b.secondary ? ' secondary' : '') + (b.danger ? ' danger' : '');
    btn.textContent = b.label;
    if (b.disabled) btn.disabled = true;
    btn.addEventListener('click', () => { hide($('dialog-panel')); b.onClick?.(); });
    wrap.appendChild(btn);
  }
  show($('dialog-panel'));
}

function updateHUD() {
  $('hud-week').textContent = `Week ${game.week} · Banksia St, Wattlebrook`;
  $('hud-savings').textContent = fmt(game.savings);
  $('hud-loan').textContent = game.preApproval ? fmt(game.preApproval) : '—';
  $('hud-max').textContent = game.preApproval ? fmt(playerMax()) : '—';
  $('hud-homes').textContent = String(listings.filter((l) => !game.soldTo[l.id]).length);

  const researched = game.reports.size >= 1 && game.reviews.size >= 1;
  const steps = {
    finance: game.preApproval > 0 ? 'done' : 'now',
    research: game.ownedId ? 'done' : (researched ? 'done' : (game.preApproval ? 'now' : '')),
    buy: game.ownedId ? 'done' : (researched ? 'now' : ''),
    settle: game.phase === 'settled' ? 'done' : '',
  };
  document.querySelectorAll('#journey .step').forEach((el) => {
    el.className = 'step ' + (steps[el.dataset.step] || '');
  });
}

// ---------- start screen: finance wizard ----------

function chipRow(rowId, items, selIdx = 0) {
  const row = $(rowId);
  row.innerHTML = '';
  items.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'choice' + (i === selIdx ? ' sel' : '');
    el.innerHTML = `${item.label}<small>${item.note ?? (item.value !== undefined && rowId === 'income-row' ? fmt(item.value) + '/yr' : item.note ?? '')}</small>`;
    el.dataset.idx = i;
    el.addEventListener('click', () => {
      row.querySelectorAll('.choice').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
      hide($('letter')); hide($('start-btn')); // re-apply after changes
    });
    row.appendChild(el);
  });
}
chipRow('income-row', INCOMES.map((x) => ({ ...x, note: fmt(x.value) + ' / yr' })), 1);
chipRow('expense-row', EXPENSES, 1);
chipRow('card-row', CARD_LIMITS.map((x) => ({ ...x, note: x.value ? '−' + fmt(x.value * 3.8) + ' capacity' : 'lenders love this' })), 0);
chipRow('lender-row', [
  { label: '🏦 ' + LENDERS.bank.name, note: (LENDERS.bank.rate * 100).toFixed(2) + '% — ' + LENDERS.bank.blurb },
  { label: '🤝 ' + LENDERS.broker.name, note: (LENDERS.broker.rate * 100).toFixed(2) + '% — ' + LENDERS.broker.blurb },
], 1);

$('hecs-chip').addEventListener('click', () => {
  $('hecs-chip').classList.toggle('sel');
  hide($('letter')); hide($('start-btn'));
});
document.querySelectorAll('#difficulty-row .choice').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#difficulty-row .choice').forEach((c) => c.classList.remove('sel'));
    el.classList.add('sel');
  });
});

const selIdx = (rowId) => Number($(rowId).querySelector('.choice.sel')?.dataset.idx ?? 0);

function applyForPreApproval() {
  const lender = selIdx('lender-row') === 0 ? 'bank' : 'broker';
  const income = INCOMES[selIdx('income-row')].value;
  const expenseFactor = EXPENSES[selIdx('expense-row')].factor;
  const cardLimit = CARD_LIMITS[selIdx('card-row')].value;
  const hecs = $('hecs-chip').classList.contains('sel');

  const power = borrowingPower({ lender, income, expenseFactor, hecs, cardLimit });
  game.preApproval = power;
  game.lender = lender;
  game.rate = LENDERS[lender].rate;

  const L = LENDERS[lender];
  const repay = monthlyRepayment(power, L.rate);
  $('letter').innerHTML = `
    <div class="lh">📄 Conditional pre-approval — ${L.name}</div>
    You may borrow up to <span class="big">${fmt(power)}</span><br>
    at ${(L.rate * 100).toFixed(2)}% p.a. — about <b>${fmt(repay)}/month</b> over 30 years if fully drawn.
    ${cardLimit ? `<br>Your ${fmt(cardLimit)} credit card limit cost you ~${fmt(cardLimit * 3.8)} of borrowing power — lenders assess the limit, not the balance.` : ''}
    ${hecs ? `<br>HECS trimmed your capacity too — repayments count as an expense.` : ''}
    <div class="fine">Valid 90 days. Conditional on a satisfactory valuation of the property you buy — remember that at auction.</div>`;
  show($('letter'));
  show($('start-btn'));
}
$('preapprove-btn').addEventListener('click', applyForPreApproval);

function startGame() {
  if (!game.preApproval) return;
  game.heat = document.querySelector('#difficulty-row .choice.sel')?.dataset.diff ?? 'balanced';
  game.fhb = $('fhb-check').checked;
  game.phase = 'explore';
  hide($('start-screen'));
  show($('hud'));
  show($('crosshair'));
  show($('hint'));
  updateHUD();
  player.enabled = true;
  player.requestLock();
}
$('start-btn').addEventListener('click', startGame);

// ---------- listing panel ----------

let panelListing = null;

function openPanel(id) {
  const l = byId[id];
  if (!l || game.soldTo[id] || game.phase !== 'explore') return;
  panelListing = l;
  freeze();
  $('lp-address').textContent = l.address;
  $('lp-style').textContent = l.style;
  const pill = $('lp-guide');
  pill.textContent = l.saleType === 'auction' ? `Guide ${signTextFor(l)} · Auction` : `${fmt(l.asking)} · Private sale`;
  pill.className = 'pricepill' + (l.saleType === 'private' ? ' private' : '');
  $('lp-features').innerHTML =
    `<span>🛏 <b>${l.beds}</b> bed</span><span>🛁 <b>${l.baths}</b> bath</span>` +
    `<span>🚗 <b>${l.cars}</b> car</span><span>📐 <b>${l.land} m²</b></span>`;
  $('lp-desc').textContent = `“${l.desc}”`;

  if (game.reports.has(id)) {
    $('lp-report-body').textContent = l.report.replace('{val}', fmt(l.trueValue));
    show($('lp-report'));
    $('lp-report-btn').textContent = 'B&P report ✓';
    $('lp-report-btn').disabled = true;
  } else {
    hide($('lp-report'));
    $('lp-report-btn').textContent = `Building & pest report (${fmt(REPORT_COST)})`;
    $('lp-report-btn').disabled = game.savings < REPORT_COST;
  }

  if (game.reviews.has(id)) {
    $('lp-review-body').innerHTML = l.specialCondition
      ? `⚠ <b>Special condition found:</b> ${l.specialCondition.clause}`
      : 'Contract and Section 32 are clean — standard conditions, clear title, no easements or notices of note.';
    show($('lp-review'));
    $('lp-review-btn').textContent = 'Contract reviewed ✓';
    $('lp-review-btn').disabled = true;
  } else {
    hide($('lp-review'));
    $('lp-review-btn').textContent = `Solicitor contract review (${fmt(REVIEW_COST)})`;
    $('lp-review-btn').disabled = game.savings < REVIEW_COST;
  }

  $('lp-buy-btn').textContent = l.saleType === 'auction' ? '🔨 Attend the auction' : '✉️ Make an offer';
  show($('listing-panel'));
}

function closePanel() {
  hide($('listing-panel'));
  panelListing = null;
  unfreeze();
}

$('lp-close-btn').addEventListener('click', closePanel);
$('lp-report-btn').addEventListener('click', () => {
  if (!panelListing || game.reports.has(panelListing.id)) return;
  game.savings -= REPORT_COST;
  game.reports.add(panelListing.id);
  updateHUD();
  blip(880, 0.1, 'sine');
  openPanel(panelListing.id);
});
$('lp-review-btn').addEventListener('click', () => {
  if (!panelListing || game.reviews.has(panelListing.id)) return;
  game.savings -= REVIEW_COST;
  game.reviews.add(panelListing.id);
  updateHUD();
  blip(880, 0.1, 'sine');
  openPanel(panelListing.id);
});
$('lp-buy-btn').addEventListener('click', () => {
  if (!panelListing) return;
  const l = panelListing;
  hide($('listing-panel'));
  panelListing = null;
  if (l.saleType === 'auction') maybeStartAuction(l);
  else openOfferModal(l);
});

// ---------- private sale: offers ----------

let offerListing = null;

function openOfferModal(l, roundNote = '') {
  offerListing = l;
  freeze();
  $('offer-title').textContent = `Offer on ${l.address}`;
  $('offer-sub').innerHTML = `Asking ${fmt(l.asking)}. ${roundNote || 'The agent will "take it to the vendor tonight". Everything is negotiable — including how long they pretend to think about it.'}`;
  const amounts = [
    { label: 'Cheeky', value: round1k(l.asking * 0.94) },
    { label: 'Fair go', value: round1k(l.asking * 0.97) },
    { label: 'Asking', value: l.asking },
    { label: 'Knockout', value: round1k(l.asking * 1.02) },
  ];
  const row = $('offer-amounts');
  row.innerHTML = '';
  const max = playerMax();
  amounts.forEach((a, i) => {
    const el = document.createElement('div');
    el.className = 'choice' + (i === 1 ? ' sel' : '');
    const over = a.value > max;
    el.innerHTML = `${a.label}<small>${fmt(a.value)}${over ? ' — beyond your ceiling' : ''}</small>`;
    if (over) { el.style.opacity = '0.4'; el.style.pointerEvents = 'none'; }
    el.dataset.value = a.value;
    el.addEventListener('click', () => {
      row.querySelectorAll('.choice').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
    });
    row.appendChild(el);
  });
  if (!row.querySelector('.choice.sel')) row.querySelector('.choice')?.classList.add('sel');
  $('offer-submit').textContent = 'Submit offer';
  show($('offer-panel'));
}

$('offer-cancel').addEventListener('click', () => { hide($('offer-panel')); offerListing = null; unfreeze(); });
$('offer-submit').addEventListener('click', () => {
  const l = offerListing;
  const amount = Number($('offer-amounts').querySelector('.choice.sel')?.dataset.value ?? 0);
  const stf = $('offer-stf').checked;
  if (!l || !amount) return;
  hide($('offer-panel'));
  offerListing = null;
  submitOffer(l, amount, stf);
});

function submitOffer(l, amount, stf, isBestAndFinal = false) {
  game.offerRound += 1;
  // rival buyer swoops on soft offers in a warm market
  if (!isBestAndFinal && game.offerRound === 1 && amount < l.asking * 0.99 && game.heat !== 'cooling' && Math.random() < 0.35) {
    const rival = round1k(amount * 1.013 + 3000);
    const matchAmt = round1k(rival + 3000);
    dialog('The agent calls back', `“Look, awkward timing — another party has just put in <b>${fmt(rival)}</b>. The vendor's asked for best and final by 5pm. Where do you want to land?”`, [
      { label: `Go to ${fmt(matchAmt)}`, disabled: matchAmt > playerMax(), onClick: () => submitOffer(l, matchAmt, stf, true) },
      { label: 'Let it go', secondary: true, onClick: () => { loseListing(l, `You blinked. ${l.address} went to the other buyer for ${fmt(rival)}.`); } },
    ]);
    return;
  }

  const effective = amount * (stf ? 0.995 : 1); // conditions make an offer slightly less attractive
  if (effective >= l.vendorMin * 1.015 || amount >= l.asking) {
    dialog('Offer accepted 🎉', `“Congratulations — the vendor has accepted <b>${fmt(amount)}</b>. I'll send the contract through tonight.”<br><br>Next step: sign the Contract of Sale and pay the deposit.`, [
      { label: 'Review & sign the contract', onClick: () => showContract(l, amount, 'private', { stf }) },
    ]);
  } else if (effective >= l.vendorMin * 0.965 && game.offerRound <= 3) {
    const counter = round1k(Math.min(l.asking, Math.max(l.vendorMin * 1.02, (amount + l.asking) / 2)));
    dialog('Vendor counters', `“They appreciate the offer but they're firm — they'd sign tonight at <b>${fmt(counter)}</b>.”`, [
      { label: `Accept ${fmt(counter)}`, disabled: counter > playerMax(), onClick: () => showContract(l, counter, 'private', { stf }) },
      { label: 'Improve my offer', secondary: true, onClick: () => openOfferModal(l, `They countered at ${fmt(counter)}. Round ${game.offerRound + 1} — sharpen the pencil or walk.`) },
      { label: 'Walk away', secondary: true, onClick: () => { game.offerRound = 0; toast('You walked. The house stays on the market — for now.'); unfreeze(); } },
    ]);
  } else {
    dialog('Offer rejected', `“The vendor didn't get out of bed for that one, mate.” ${game.offerRound > 3 ? 'They\'ve stopped taking your calls this week.' : 'You can try again with a sharper number.'}`, [
      { label: 'Fair enough', secondary: true, onClick: () => { game.offerRound = 0; unfreeze(); } },
    ]);
  }
}

function loseListing(l, msg) {
  game.offerRound = 0;
  game.soldTo[l.id] = 'rival';
  houses[l.id].sign.userData.updateSign(signTextFor(l), 'rival');
  advanceWeek();
  toast(msg, 5200);
  backToStreet();
}

// ---------- contract ----------

function drawSignature() {
  const c = $('sig-canvas');
  const g = c.getContext('2d');
  g.clearRect(0, 0, c.width, c.height);
  g.strokeStyle = '#1a2f6e';
  g.lineWidth = 2.2;
  g.lineCap = 'round';
  g.beginPath();
  let x = 18, y = 42;
  g.moveTo(x, y);
  for (let i = 0; i < 7; i++) {
    const cx1 = x + 8 + Math.random() * 14, cy1 = 10 + Math.random() * 20;
    const cx2 = x + 16 + Math.random() * 16, cy2 = 34 + Math.random() * 22;
    x = Math.min(222, x + 24 + Math.random() * 8);
    y = 34 + Math.random() * 14;
    g.bezierCurveTo(cx1, cy1, cx2, cy2, x, y);
  }
  g.stroke();
}

function showContract(l, price, method, opts = {}) {
  freeze();
  game.pendingContract = { listing: l, price, method, stf: !!opts.stf };
  const deposit = Math.round(price * DEPOSIT_PCT);
  const settleDays = l.id === 'bungalow' ? 30 : 60;
  $('contract-rows').innerHTML = `
    <div class="crow"><span>Property</span><b>${l.address}, Wattlebrook</b></div>
    <div class="crow"><span>Purchase price</span><b>${fmt(price)}</b></div>
    <div class="crow"><span>Deposit (10%, payable on signing)</span><b>${fmt(deposit)}</b></div>
    <div class="crow"><span>Settlement</span><b>${settleDays} days</b></div>
    <div class="crow"><span>Vendor's agent</span><b>Ray Wight — Wattlebrook</b></div>`;

  let clauses = '';
  if (method === 'auction') {
    clauses += `<div class="clause danger"><b>Sold at public auction:</b> this contract is unconditional. No cooling-off period, no finance clause. The fall of the hammer was the point of no return.</div>`;
  } else if (method === 'post-auction') {
    clauses += `<div class="clause danger"><b>Bought within 3 clear business days of a public auction:</b> the cooling-off period does not apply. (Yes, really — check s31 of the Sale of Land Act.)</div>`;
  } else {
    clauses += game.pendingContract.stf
      ? `<div class="clause"><b>Subject to finance:</b> if your lender declines or the valuation falls short, you may end this contract and recover the deposit.</div>`
      : `<div class="clause danger"><b>No finance clause:</b> you offered unconditionally. If the bank's valuation comes in low, the shortfall — or the deposit — is your problem.</div>`;
    clauses += `<div class="clause"><b>Cooling-off:</b> 3 clear business days, penalty 0.2% of the price (${fmt(price * COOLING_OFF_PENALTY)}).</div>`;
  }
  if (game.reviews.has(l.id) && l.specialCondition) {
    clauses += `<div class="clause"><b>Special condition (flagged by your solicitor):</b> ${l.specialCondition.clause}</div>`;
  } else if (!game.reviews.has(l.id)) {
    clauses += `<div class="clause">…followed by 42 pages of special conditions nobody has read on your behalf.</div>`;
  }
  $('contract-clauses').innerHTML = clauses;
  $('sig-canvas').getContext('2d').clearRect(0, 0, 240, 64);
  $('contract-title').textContent = method === 'auction' ? 'Contract of Sale — sign here, no takesies-backsies' : 'Contract of Sale';
  show($('contract-panel'));
}

$('contract-sign').addEventListener('click', () => {
  const pc = game.pendingContract;
  if (!pc) return;
  drawSignature();
  blip(520, 0.12, 'sine', 0.06);
  setTimeout(() => {
    hide($('contract-panel'));
    afterSigning(pc);
  }, 700);
});

function afterSigning(pc) {
  const { listing: l, price, method, stf } = pc;
  game.pendingContract = null;
  if (method === 'private') {
    dialog('Cooling-off period', `Three business days tick by. The deposit's paid, the contract's signed — but in a VIC private sale you can still walk for a ${fmt(price * COOLING_OFF_PENALTY)} penalty (0.2%).<br><br>Second thoughts?`, [
      { label: 'Stay the course', onClick: () => valuationCheck(l, price, stf) },
      { label: `Cool off (forfeit ${fmt(price * COOLING_OFF_PENALTY)})`, danger: true, onClick: () => {
        game.savings -= Math.round(price * COOLING_OFF_PENALTY);
        game.offerRound = 0;
        updateHUD();
        toast(`You cooled off. ${fmt(price * COOLING_OFF_PENALTY)} lighter, but free. The vendor relists.`, 5000);
        unfreeze();
      } },
    ]);
  } else {
    valuationCheck(l, price, stf, method === 'auction');
  }
}

// The bank still has to value the place before it hands over the loan.
function valuationCheck(l, price, stf, wasAuction = false) {
  const overpaid = price > l.trueValue * 1.045;
  if (!overpaid) {
    if (wasAuction && price > l.trueValue) toast('The valuer sucked their teeth, but your numbers held. Loan approved.', 4200);
    settle(l, price);
    return;
  }
  const s = settlement(price, game.savings, game.preApproval, game.fhb, l.trueValue);
  if (s.cashNeeded <= game.savings) {
    dialog('Valuation shortfall', `The bank's valuer says the place is worth <b>${fmt(l.trueValue)}</b> — not the ${fmt(price)} you're paying. The bank lends against <i>their</i> number, so you must find an extra <b>${fmt(Math.round(price - l.trueValue))}</b> in cash to bridge the gap.<br><br>You can cover it. It'll hurt.`, [
      { label: 'Cover the gap and settle', onClick: () => settle(l, price, l.trueValue) },
    ]);
  } else if (stf) {
    dialog('Saved by the finance clause', `The valuation came in at <b>${fmt(l.trueValue)}</b> and the bank cut your loan. You can't bridge the gap — but your <b>subject-to-finance clause</b> lets you end the contract and take the deposit home.<br><br>This is why the clause exists.`, [
      { label: 'Withdraw with deposit intact', onClick: () => { loseListing(l, 'Contract ended under the finance clause. Deposit returned. Lesson: banked.'); } },
    ]);
  } else {
    const forfeit = Math.round(price * DEPOSIT_PCT);
    dialog('💥 The unconditional trap', `Valuation: <b>${fmt(l.trueValue)}</b>. Your loan shrank, you can't fund the gap, and you signed with <b>no finance clause</b>. You cannot complete the purchase.<br><br>The vendor keeps your deposit: <b>${fmt(forfeit)}</b>.`, [
      { label: 'Hand over the deposit', danger: true, onClick: () => {
        game.savings = Math.max(0, game.savings - forfeit);
        updateHUD();
        loseListing(l, `Deposit forfeited: ${fmt(forfeit)}. An expensive way to learn what "unconditional" means.`);
      } },
    ]);
  }
}

// ---------- auction ----------

let crowd = null;

function maybeStartAuction(l) {
  if (!game.reviews.has(l.id)) {
    dialog('Before you raise your hand…', `Bidding at auction is <b>unconditional</b>: no cooling-off, no finance clause, 10% deposit on the spot if you win. Nobody has checked this contract or the Section 32 for you.<br><br>A solicitor review is ${fmt(REVIEW_COST)}.`, [
      { label: `Review the contract first (${fmt(REVIEW_COST)})`, disabled: game.savings < REVIEW_COST, onClick: () => {
        game.savings -= REVIEW_COST;
        game.reviews.add(l.id);
        updateHUD();
        const found = l.specialCondition
          ? `⚠ Your solicitor rings an hour later: “${l.specialCondition.clause}”`
          : 'Your solicitor rings back: contract is clean. Bid with confidence — up to your limit, not past it.';
        dialog('Solicitor report', found, [{ label: 'To the auction', onClick: () => startAuction(l.id) }]);
      } },
      { label: 'Bid anyway (she\'ll be right)', secondary: true, onClick: () => startAuction(l.id) },
      { label: 'Back', secondary: true, onClick: unfreeze },
    ]);
    return;
  }
  startAuction(l.id);
}

function spawnCrowd(house) {
  crowd = new THREE.Group();
  const { frontPos, centre } = house;
  const toHouse = centre.clone().sub(frontPos).normalize();
  const colors = [0x3a6ea5, 0x8a4f7d, 0x577859, 0xc06636, 0x666a70, 0x9d3c3c, 0x4a6b8a, 0x7d6b4f];
  for (let i = 0; i < 8; i++) {
    const p = buildPerson(colors[i % colors.length]);
    const spread = (i - 3.5) * 1.3;
    const side = new THREE.Vector3(-toHouse.z, 0, toHouse.x);
    const pos = frontPos.clone()
      .addScaledVector(side, spread)
      .addScaledVector(toHouse, 1.8 + Math.random() * 1.6);
    p.position.copy(pos);
    p.lookAt(centre.x, 0, centre.z);
    crowd.add(p);
  }
  const auctioneer = buildPerson(0xffcd00);
  auctioneer.position.copy(frontPos.clone().addScaledVector(toHouse, 4.6));
  auctioneer.lookAt(frontPos.x, 0, frontPos.z);
  crowd.add(auctioneer);
  scene.add(crowd);
}

function clearCrowd() {
  if (crowd) { scene.remove(crowd); crowd = null; }
}

function logLine(msg, cls) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = msg;
  const log = $('auction-log');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function startAuction(id) {
  const l = byId[id];
  if (!l || game.soldTo[id] || game.phase === 'auction') return;
  hide($('listing-panel'));
  panelListing = null;
  game.phase = 'auction';
  freeze();

  const house = houses[id];
  const back = house.frontPos.clone().sub(house.centre).normalize().multiplyScalar(2.5);
  player.teleport(house.frontPos.x + back.x, house.frontPos.z + back.z);
  player.lookAt(house.centre);
  spawnCrowd(house);

  $('auction-addr').textContent = `${l.address} · guide ${signTextFor(l)}`;
  $('auction-log').innerHTML = '';
  $('current-bid').textContent = '—';
  $('bid-leader').textContent = 'Waiting for an opening bid…';
  $('bid-leader').classList.remove('you');
  $('max-note').innerHTML = `Your absolute ceiling: <b>${fmt(playerMax())}</b> — the bank, not the heart, sets it.`;
  show($('auction-panel'));

  game.auction = new Auction(l, {
    playerMax: playerMax(),
    heat: game.heat,
    onEvent: (type, data) => onAuctionEvent(l, type, data),
  });
  game.auction.start();
}

function onAuctionEvent(l, type, data) {
  if (type === 'log') logLine(data.msg, data.cls);
  if (type === 'bid') {
    $('current-bid').textContent = fmt(data.amount);
    const leader = $('bid-leader');
    if (data.who === 'you') {
      leader.textContent = 'Leading bid: YOU';
      leader.classList.add('you');
      blip(760, 0.09, 'sine', 0.07);
    } else {
      leader.textContent = data.who === 'vendor' ? 'Vendor bid (protecting the reserve)' : `Leading bid: ${data.who}`;
      leader.classList.remove('you');
      blip(430, 0.09, 'sine', 0.05);
    }
  }
  if (type === 'sold') {
    gavel();
    endAuction();
    if (data.winner === 'you') {
      advanceWeek();
      showContract(l, data.price, 'auction');
    } else {
      loseListing(l, `🔨 ${l.address} sold to ${data.winner} for ${fmt(data.price)}. Back to the hunt.`);
    }
  }
  if (type === 'passedIn') {
    endAuction();
    if (data.highestRealBidder === 'you') {
      const asking = l.reserve;
      const affordable = asking <= playerMax();
      dialog('Passed in — you hold the highest bid', `Your ${fmt(data.amount)} was the best genuine bid, but the reserve wasn't met. Inside, over lukewarm instant coffee, the agent says the vendor will sign tonight at <b>${fmt(asking)}</b>.${affordable ? '' : `<br><br>⚠ That's beyond your ceiling of ${fmt(playerMax())}.`}<br><br><i>Buying within 3 business days of an auction still means no cooling-off.</i>`, [
        { label: `Shake hands at ${fmt(asking)}`, disabled: !affordable, onClick: () => { advanceWeek(); showContract(l, asking, 'post-auction'); } },
        { label: 'Walk away', secondary: true, onClick: () => loseListing(l, `You walked. ${l.address} sold privately a week later.`) },
      ]);
    } else {
      loseListing(l, `${l.address} passed in — sold privately the following week. Not to you.`);
    }
  }
}

function endAuction() {
  hide($('auction-panel'));
  clearCrowd();
  game.auction = null;
  game.phase = 'explore';
}

function backToStreet() {
  game.phase = 'explore';
  updateHUD();
  if (!listings.some((l) => !game.soldTo[l.id])) return gameOver();
  unfreeze();
}

function advanceWeek() {
  game.week += 1;
  for (const l of listings) {
    if (game.soldTo[l.id]) continue;
    l.guide = [Math.round(l.guide[0] * 1.015), Math.round(l.guide[1] * 1.015)];
    l.trueValue = Math.round(l.trueValue * 1.015);
    l.reserve = Math.round(l.reserve * 1.015);
    if (l.asking) l.asking = round1k(l.asking * 1.015);
    if (l.vendorMin) l.vendorMin = Math.round(l.vendorMin * 1.015);
    houses[l.id].sign.userData.updateSign(signTextFor(l), null);
  }
}

document.querySelectorAll('.bidbtns .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!game.auction) return;
    const res = game.auction.playerBid(Number(btn.dataset.inc));
    if (!res.ok) toast(res.reason, 2500);
  });
});

// ---------- settlement & endings ----------

function settle(l, price, valCap = null) {
  game.phase = 'settled';
  game.ownedId = l.id;
  game.offerRound = 0;
  game.soldTo[l.id] = 'you';
  houses[l.id].sign.userData.updateSign(signTextFor(l), 'you');

  const s = settlement(price, game.savings, game.preApproval, game.fhb, valCap);
  const surprise = (!game.reviews.has(l.id) && l.specialCondition) ? l.specialCondition : null;
  const surpriseCost = surprise ? surprise.surpriseCost : 0;
  game.savings = Math.max(0, Math.round(s.cashLeft - l.repairCost - surpriseCost));

  const position = l.trueValue - price - surpriseCost;
  let verdictCls, verdictText;
  if (position >= 25000) {
    verdictCls = 'good';
    verdictText = `🏆 Bought ${fmt(position)} under market value. An absolute steal — this one's going straight to the pool room.`;
  } else if (position >= -15000) {
    verdictCls = 'ok';
    verdictText = `👍 Fair buy — right on market value (${fmt(l.trueValue)}). No regrets, plenty of equity ahead.`;
  } else if (position >= -60000) {
    verdictCls = 'bad';
    verdictText = `😬 All in, you're about ${fmt(-position)} behind market value (${fmt(l.trueValue)}). Adrenaline and skipped homework are expensive.`;
  } else {
    verdictCls = 'bad';
    verdictText = `🔥 That's ${fmt(-position)} under water on day one. The underbidder sends their regards.`;
  }

  $('res-title').textContent = `🎉 SETTLED — ${l.address} is yours`;
  $('res-sub').textContent = `${l.style} · ${game.lender === 'broker' ? 'financed via your broker' : 'financed by the bank'} · week ${game.week}`;
  const v = $('res-verdict');
  v.className = `verdict ${verdictCls}`;
  v.textContent = verdictText;
  show(v);

  const dutyLabel = game.fhb && s.duty === 0 ? 'Stamp duty (FHB exempt 🎉)' : 'Stamp duty';
  const rows = [
    ['Purchase price', fmt(s.price)],
    [`Loan drawn (LVR ${(s.lvr * 100).toFixed(0)}%${valCap ? ', against the bank\'s valuation' : ''})`, '−' + fmt(s.loan)],
    ['Deposit + gap from savings', fmt(s.deposit)],
    [dutyLabel, fmt(s.duty)],
    [`Lenders mortgage insurance${s.lmi === 0 ? ' (LVR ≤ 80%)' : ''}`, fmt(s.lmi)],
    ['Conveyancing & settlement', fmt(s.conveyancing)],
    [game.reports.has(l.id) ? 'Repairs (as per your report)' : '⚠ Surprise repairs (no report ordered…)', fmt(l.repairCost)],
  ];
  if (surprise) rows.push([`⚠ ${surprise.surprise} (unreviewed contract)`, fmt(surpriseCost)]);
  $('res-costs').innerHTML = `<table class="costs">
    ${rows.map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join('')}
    <tr class="total"><td>Cash remaining</td><td>${fmt(game.savings)}</td></tr>
  </table>`;
  $('res-continue').textContent = 'Collect the keys 🔑';
  show($('result-panel'));
  updateHUD();
}

function gameOver() {
  game.phase = 'over';
  freeze();
  $('res-title').textContent = '📉 Priced out';
  $('res-sub').textContent = `Every home on Banksia Street sold to someone else. ${game.week} weeks of Saturdays, and nothing to show but sausage sizzle receipts.`;
  hide($('res-verdict'));
  $('res-costs').innerHTML = `<p class="sub" style="margin-top:10px">The market rose ${((Math.pow(1.015, game.week - 1) - 1) * 100).toFixed(1)}% while you watched. Classic.</p>`;
  $('res-continue').textContent = 'Try again next season';
  show($('result-panel'));
}

$('res-continue').addEventListener('click', () => {
  if (game.phase === 'over') { location.reload(); return; }
  hide($('result-panel'));
  $('hint').innerHTML = '🏡 It\'s yours. Walk inside and admire the castle — you\'ve earned every square metre.';
  player.enabled = true;
  player.requestLock();
});

// ---------- interaction ----------

const raycaster = new THREE.Raycaster();

function nearestListing() {
  let best = null, bestD = 16;
  for (const l of listings) {
    if (game.soldTo[l.id] && game.soldTo[l.id] !== 'you') continue;
    if (game.soldTo[l.id] === 'you') continue;
    const d = Math.hypot(player.pos.x - houses[l.id].centre.x, player.pos.z - houses[l.id].centre.z);
    if (d < bestD) { best = l; bestD = d; }
  }
  return best;
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyE' || game.phase !== 'explore') return;
  if (!$('listing-panel').classList.contains('hidden')) return;
  const l = nearestListing();
  if (l) openPanel(l.id);
});

renderer.domElement.addEventListener('click', () => {
  if (game.phase === 'explore' || game.phase === 'settled') {
    if (!player.locked) { player.requestLock(); return; }
    if (game.phase !== 'explore') return;
    raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
    for (const l of listings) {
      if (game.soldTo[l.id]) continue;
      const hits = raycaster.intersectObject(houses[l.id].group, true);
      if (hits.length && hits[0].distance < 35) { openPanel(l.id); return; }
    }
  }
});

// ---------- main loop ----------

const clock = new THREE.Clock();

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  player.update(dt);
  game.auction?.update(dt);

  const prompt = $('prompt');
  if (game.phase === 'explore' && $('listing-panel').classList.contains('hidden')) {
    const l = nearestListing();
    if (l) {
      prompt.innerHTML = `<b>E</b> · listing — ${l.address} (${l.saleType === 'auction' ? 'auction' : 'private sale'})`;
      show(prompt);
    } else hide(prompt);
  } else hide(prompt);

  renderer.render(scene, camera);
}
animate();

// ---------- debug hooks ----------

window.__game = {
  state: () => ({
    phase: game.phase, week: game.week, savings: game.savings,
    preApproval: game.preApproval, lender: game.lender,
    max: game.preApproval ? playerMax() : 0,
    soldTo: { ...game.soldTo }, ownedId: game.ownedId,
    reports: [...game.reports], reviews: [...game.reviews],
    pos: { x: +player.pos.x.toFixed(1), z: +player.pos.z.toFixed(1) },
    auction: game.auction ? {
      currentBid: game.auction.currentBid, leader: game.auction.leader,
      state: game.auction.state, done: game.auction.done,
      reserve: game.auction.listing.reserve,
      rivals: game.auction.rivals.map((r) => ({ name: r.name, limit: r.limit })),
    } : null,
  }),
  listings: () => listings.map((l) => ({
    id: l.id, saleType: l.saleType, guide: l.guide, asking: l.asking ?? null,
    trueValue: l.trueValue, reserve: l.reserve, vendorMin: l.vendorMin ?? null,
    sold: game.soldTo[l.id] ?? null,
  })),
  preapprove: () => applyForPreApproval(),
  start: (diff, fhb) => {
    if (diff) document.querySelector(`#difficulty-row .choice[data-diff="${diff}"]`)?.click();
    if (fhb !== undefined) $('fhb-check').checked = fhb;
    if (!game.preApproval) applyForPreApproval();
    startGame();
  },
  teleport: (x, z) => player.teleport(x, z),
  openPanel,
  startAuction,
  offer: (id, amount, stf = true) => submitOffer(byId[id], amount, stf),
  clickDialog: (labelPart) => {
    const btn = [...document.querySelectorAll('#dlg-btns .btn')].find((b) => b.textContent.includes(labelPart));
    btn?.click();
    return !!btn;
  },
  signContract: () => $('contract-sign').click(),
  bid: (inc = 10000) => game.auction?.playerBid(inc),
  skip: (seconds = 5) => {
    for (let t = 0; t < seconds && game.auction; t += 0.1) game.auction.update(0.1);
  },
  collectKeys: () => $('res-continue').click(),
  frame: (dt = 0.016) => { player.update(dt); game.auction?.update(dt); renderer.render(scene, camera); },
  _scene: scene, _houses: houses, _player: player, _renderer: renderer, _camera: camera, _raw: game, _solids: solids, _THREE: THREE,
};
