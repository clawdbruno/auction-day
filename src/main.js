import * as THREE from 'three';
import { LISTINGS } from './listings.js';
import { buildWorld, buildPerson, buildCar, HOUSE_DIMS } from './world.js';
import { Player } from './player.js';
import { Auction } from './auction.js';
import { Ambience } from './ambience.js';
import {
  fmt, round1k, settlement, maxPurchase, monthlyRepayment, borrowingPower,
  LENDERS, EXPENSES, CARD_LIMITS, SOLICITORS, LOAN_TYPES,
  REPORT_COST, OC_RECORDS_COST, DEPOSIT_PCT, COOLING_OFF_PENALTY,
  FHOG_AMOUNT, FHOG_PRICE_CAP, FHBG_PRICE_CAP, FHBG_INCOME_CAP,
} from './finance.js';

// ---------- game state ----------

const game = {
  phase: 'start', // start | explore | auction | settled | over
  week: 1,
  savings: 180000,
  preApproval: 0,
  lender: null,
  rate: 0,
  income: 0,
  household: 'couple',
  solicitor: SOLICITORS[1],
  schemes: { fhbg: false, fhbgWhy: '' },
  loanType: LOAN_TYPES[0],
  fhb: true,
  heat: 'balanced',
  soldTo: {},            // listingId -> 'you' | 'rival'
  reports: new Set(),    // building & pest purchased
  reviews: new Set(),    // contract review engaged
  reviewMissed: new Set(), // budget conveyancer waved it through
  ocRead: new Set(),     // owners corp records inspected
  ownedId: null,
  auction: null,
  pendingContract: null, // { listing, price, method, stf }
  offerRound: 0,
  fhbgCapWarned: false,
  guarantor: false,
  marketGrowth: 1.015,
  marketIndex: 1,
  rateRiseDone: false,
  rateRisePending: false,
  purchase: null, // filled at settlement, feeds the epilogue
  agentNotes: {},  // listingId -> { questionId: short note } — what you sussed out
  asked: {},       // listingId -> Set of question ids this conversation-lifetime
};

const listings = LISTINGS.map((l) => ({ ...l }));
const byId = Object.fromEntries(listings.map((l) => [l.id, l]));

const kfmt = (n) => n >= 1000000 ? `$${(n / 1e6).toFixed(2)}m` : `$${Math.round(n / 1000)}k`;
const signTextFor = (l) => l.saleType === 'auction'
  ? `${kfmt(l.guide[0])} – ${kfmt(l.guide[1])}`
  : fmt(l.asking);
const settleOpts = (l) => ({
  conveyancing: game.solicitor.conveyancing,
  fhbg: game.schemes.fhbg,
  fhog: !!(l?.isNew) && game.fhb,
  guarantor: game.guarantor,
});
const playerMax = (l = null) => maxPurchase(game.savings, game.preApproval, game.fhb, {
  fhbg: game.schemes.fhbg,
  conveyancing: game.solicitor.conveyancing,
  fhog: !!(l?.isNew) && game.fhb,
  guarantor: game.guarantor,
});

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
const ambience = new Ambience();

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
function toast(msg, ms = 4200) {
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
    el.innerHTML = `${item.label}<small>${item.note ?? ''}</small>`;
    el.dataset.idx = i;
    el.addEventListener('click', () => {
      row.querySelectorAll('.choice').forEach((c) => c.classList.remove('sel'));
      el.classList.add('sel');
      hide($('letter')); hide($('start-btn')); // re-apply after changes
    });
    row.appendChild(el);
  });
}
chipRow('expense-row', EXPENSES, 1);
chipRow('card-row', CARD_LIMITS.map((x) => ({ ...x, note: x.value ? '−' + fmt(x.value * 3.8) + ' capacity' : 'lenders love this' })), 0);
chipRow('lender-row', [
  { label: '🏦 ' + LENDERS.bank.name, note: (LENDERS.bank.rate * 100).toFixed(2) + '% · ~3 wks — ' + LENDERS.bank.blurb },
  { label: '🤝 ' + LENDERS.broker.name, note: (LENDERS.broker.rate * 100).toFixed(2) + '% · ~1 wk — ' + LENDERS.broker.blurb },
], 1);
chipRow('solicitor-row', SOLICITORS.map((s) => ({
  label: s.name,
  note: `${fmt(s.conveyancing)} + ${fmt(s.review)}/contract review — ${s.blurb}`,
})), 1);

$('hecs-chip').addEventListener('click', () => {
  $('hecs-chip').classList.toggle('sel');
  hide($('letter')); hide($('start-btn'));
});
document.querySelectorAll('#partner-row .choice').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#partner-row .choice').forEach((c) => c.classList.remove('sel'));
    el.classList.add('sel');
    $('partner-field').classList.toggle('hidden', el.dataset.partner !== 'couple');
    hide($('letter')); hide($('start-btn'));
  });
});
for (const id of ['income-you', 'income-partner']) {
  $(id).addEventListener('input', () => { hide($('letter')); hide($('start-btn')); });
}
$('guarantor-chip').addEventListener('click', () => {
  $('guarantor-chip').classList.toggle('sel');
  hide($('letter')); hide($('start-btn'));
});
$('ask-schemes').addEventListener('change', () => { hide($('letter')); hide($('start-btn')); });
document.querySelectorAll('#difficulty-row .choice').forEach((el) => {
  el.addEventListener('click', () => {
    document.querySelectorAll('#difficulty-row .choice').forEach((c) => c.classList.remove('sel'));
    el.classList.add('sel');
  });
});

const selIdx = (rowId) => Number($(rowId).querySelector('.choice.sel')?.dataset.idx ?? 0);

const readIncome = (id) => Math.max(0, Math.min(2000000, Math.round(Number($(id).value) || 0)));

function applyForPreApproval() {
  const lender = selIdx('lender-row') === 0 ? 'bank' : 'broker';
  const household = document.querySelector('#partner-row .choice.sel')?.dataset.partner === 'couple' ? 'couple' : 'single';
  const you = readIncome('income-you');
  const partner = household === 'couple' ? readIncome('income-partner') : 0;
  const expenseMult = EXPENSES[selIdx('expense-row')].mult;
  const cardLimit = CARD_LIMITS[selIdx('card-row')].value;
  const hecs = $('hecs-chip').classList.contains('sel');
  const askedSchemes = $('ask-schemes').checked;
  game.fhb = $('fhb-check').checked;

  const bp = borrowingPower({ lender, you, partner, household, expenseMult, hecs, cardLimit });
  if (bp.power < 50000) {
    $('letter').innerHTML = `<div class="lh">📄 Application declined — ${LENDERS[lender].name}</div>
      On ${fmt(bp.gross)} gross (${fmt(bp.netMonthly)}/month after tax), assessed living costs of
      ${fmt(bp.expenses)}/month${hecs ? ', HECS repayments' : ''}${cardLimit ? ', and that credit card limit' : ''}
      leave <b>${fmt(bp.surplus)}/month</b> to service a loan at ${(bp.assessRate * 100).toFixed(2)}% (rate + APRA buffer).
      That services a gym membership, not a mortgage. Adjust the inputs and try again.`;
    show($('letter'));
    hide($('start-btn'));
    game.preApproval = 0;
    return;
  }

  const power = bp.power;
  game.preApproval = power;
  game.lender = lender;
  game.rate = LENDERS[lender].rate;
  game.income = bp.gross;
  game.household = household;
  game.solicitor = SOLICITORS[selIdx('solicitor-row')];

  game.guarantor = $('guarantor-chip').classList.contains('sel');

  // First Home Guarantee: income caps, someone has to raise it, and it doesn't stack with a guarantor
  const incomeOk = bp.gross <= FHBG_INCOME_CAP[household];
  const raised = lender === 'broker' || askedSchemes;
  game.schemes.fhbg = game.fhb && incomeOk && raised && !game.guarantor;
  game.schemes.fhbgWhy = !game.fhb ? ''
    : game.guarantor ? `Not used — you're going the family-guarantee route instead. The two don't combine; LMI is waived either way, the difference is whose house carries the risk.`
    : !incomeOk ? `Household income ${fmt(bp.gross)} exceeds the ${fmt(FHBG_INCOME_CAP[household])} ${household} cap — not eligible.`
    : !raised ? `You were eligible, but nobody mentioned it. The teller answered exactly what you asked. (Tick “ask about government schemes”, or use a broker.)`
    : `Eligible ✓ — buy at or under ${fmt(FHBG_PRICE_CAP)} with just 5% deposit and NO lenders mortgage insurance. Go over the cap and LMI comes straight back.`;

  const L = LENDERS[lender];
  const repay = monthlyRepayment(power, L.rate);
  const growth = ((Math.pow(1.015, L.approvalWeeks) - 1) * 100).toFixed(1);
  $('letter').innerHTML = `
    <div class="lh">📄 Conditional pre-approval — ${L.name}</div>
    After ${L.approvalWeeks} week${L.approvalWeeks > 1 ? 's' : ''} of payslips, bank statements and one awkward
    phone call about your spending, you may borrow up to <span class="big">${fmt(power)}</span><br>
    at ${(L.rate * 100).toFixed(2)}% p.a. — about <b>${fmt(repay)}/month</b> over 30 years if fully drawn.<br><br>
    <b>The assessor's working:</b> ${fmt(bp.gross)} gross${household === 'couple' ? ' combined' : ''} →
    ${fmt(bp.netMonthly)}/mo after tax − ${fmt(bp.expenses)}/mo living costs
    (HEM${bp.expenses <= bp.hem * 1.01 ? ' floor — banks don\'t believe anyone spends less' : '-based'})${hecs ? ` − ${fmt(bp.hecsMonthly)}/mo HECS` : ''}${cardLimit ? ` − ${fmt(bp.cardMonthly)}/mo assessed against your card LIMIT (not the balance)` : ''}
    = <b>${fmt(bp.surplus)}/mo surplus</b>, stress-tested at ${(bp.assessRate * 100).toFixed(2)}% — the rate plus the 3% APRA buffer.
    ${bp.dtiCapped ? `<br>⚠ Then capped at ${lender === 'broker' ? '6.5' : '6'}× gross income — the regulator watches debt-to-income even when your surplus doesn't.` : ''}
    <br><br><b>First Home Guarantee:</b> ${game.schemes.fhbgWhy || 'n/a (not a first home buyer).'}
    ${game.guarantor ? `<br><b>Family guarantee:</b> in place ✓ — your parents' equity secures the top slice of the loan, so LMI is waived at any LVR. They signed after independent legal advice (the bank insists). Their home is exposed until your equity passes ~20%.` : ''}
    <br><b>First Home Owner Grant:</b> $10,000 — but only for a NEW home under ${fmt(FHOG_PRICE_CAP)}. Established houses don't qualify, no matter what your uncle reckons.
    <div class="fine">Valid 90 days. Conditional on a satisfactory valuation of the property you buy.
    While you waited, Banksia Street's prices moved roughly +${growth}%. The market doesn't wait for paperwork.</div>`;
  show($('letter'));
  show($('start-btn'));
}
$('preapprove-btn').addEventListener('click', applyForPreApproval);

function startGame() {
  if (!game.preApproval) return;
  game.heat = document.querySelector('#difficulty-row .choice.sel')?.dataset.diff ?? 'balanced';
  // buyer interest per listing — the thing worth sussing out of the agent
  const baseInterest = { cooling: 0, balanced: 1, hot: 2 }[game.heat];
  for (const l of listings) {
    l.interest = Math.min(3, baseInterest
      + (l.id === 'mcmansion' || l.id === 'townhouse' ? 1 : 0)
      + (Math.random() < 0.4 ? 1 : 0));
  }
  game.phase = 'explore';
  // the weeks you spent getting approved — the market moved without you
  for (let i = 0; i < LENDERS[game.lender].approvalWeeks; i++) advanceWeek();
  hide($('start-screen'));
  show($('hud'));
  show($('crosshair'));
  show($('hint'));
  updateHUD();
  toast(`Pre-approved after ${LENDERS[game.lender].approvalWeeks} week${LENDERS[game.lender].approvalWeeks > 1 ? 's' : ''}. Prices rose while you waited — welcome to week ${game.week}.`, 5200);
  spawnAllOpenHomes();
  ambience.start();
  saveGame();
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
  $('lp-style').textContent = l.style + (l.ownersCorp ? ` · OC fees ${fmt(l.ownersCorp.feesQtr)}/qtr` : '');
  const pill = $('lp-guide');
  pill.textContent = l.saleType === 'auction'
    ? `Guide ${signTextFor(l)} · Auction`
    : `${fmt(l.asking)} · Private sale${l.isNew ? ' · NEW — FHOG eligible' : ''}`;
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
    const missed = game.reviewMissed.has(id);
    $('lp-review-body').innerHTML = (l.specialCondition && !missed)
      ? `⚠ <b>Special condition found:</b> ${l.specialCondition.clause}`
      : missed
        ? `“All good — standard contract, nothing unusual. Any other questions, the chatbot is available 24/7 👍” <i>(That was fast. Suspiciously fast.)</i>`
        : 'Contract and Section 32 are clean — standard conditions, clear title, no easements or notices of note.';
    show($('lp-review'));
    $('lp-review-btn').textContent = 'Contract reviewed ✓';
    $('lp-review-btn').disabled = true;
  } else {
    hide($('lp-review'));
    $('lp-review-btn').textContent = `${game.solicitor.name.split(' — ')[0]}: contract review (${fmt(game.solicitor.review)})`;
    $('lp-review-btn').disabled = game.savings < game.solicitor.review;
  }

  if (l.ownersCorp) {
    show($('lp-oc-btn'));
    if (game.ocRead.has(id)) {
      $('lp-oc-body').textContent = l.ownersCorp.records;
      show($('lp-oc'));
      $('lp-oc-btn').textContent = 'OC records ✓';
      $('lp-oc-btn').disabled = true;
    } else {
      hide($('lp-oc'));
      $('lp-oc-btn').textContent = `Owners corp records (${fmt(OC_RECORDS_COST)})`;
      $('lp-oc-btn').disabled = game.savings < OC_RECORDS_COST;
    }
  } else {
    hide($('lp-oc'));
    hide($('lp-oc-btn'));
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
  saveGame();
  blip(880, 0.1, 'sine');
  openPanel(panelListing.id);
});
$('lp-review-btn').addEventListener('click', () => {
  if (!panelListing || game.reviews.has(panelListing.id)) return;
  game.savings -= game.solicitor.review;
  game.reviews.add(panelListing.id);
  if (Math.random() < game.solicitor.missChance) game.reviewMissed.add(panelListing.id);
  updateHUD();
  saveGame();
  blip(880, 0.1, 'sine');
  openPanel(panelListing.id);
});
$('lp-oc-btn').addEventListener('click', () => {
  if (!panelListing?.ownersCorp || game.ocRead.has(panelListing.id)) return;
  game.savings -= OC_RECORDS_COST;
  game.ocRead.add(panelListing.id);
  updateHUD();
  saveGame();
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

// what "asking" means for an auction campaign taken off-market: the vendor's number
const effAsking = (l) => l.asking ?? round1k(l.reserve * 1.03);
const effVendorMin = (l) => l.vendorMin ?? Math.round(l.reserve * 0.985);

function openOfferModal(l, roundNote = '') {
  offerListing = l;
  freeze();
  const asking = effAsking(l);
  const preAuction = l.saleType === 'auction';
  $('offer-title').textContent = preAuction ? `Pre-auction offer — ${l.address}` : `Offer on ${l.address}`;
  $('offer-sub').innerHTML = (preAuction
    ? `The agent reckons the vendor would sign tonight for the right number — guide ${signTextFor(l)}, but the reserve is the reserve. <b>No cooling-off this close to an advertised auction (s31).</b> `
    : `Asking ${fmt(asking)}. `)
    + `${roundNote || 'The agent will "take it to the vendor tonight". Everything is negotiable — including how long they pretend to think about it.'}`
    + (l.isNew ? `<br>⚠ FHOG only applies at or under ${fmt(FHOG_PRICE_CAP)} — mind the cap.` : '');
  const amounts = [
    { label: 'Cheeky', value: round1k(asking * 0.94) },
    { label: 'Fair go', value: round1k(asking * 0.97) },
    { label: 'Asking', value: asking },
    { label: 'Knockout', value: round1k(asking * 1.02) },
  ];
  const row = $('offer-amounts');
  row.innerHTML = '';
  const max = playerMax(l);
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
  // pre-auction contracts run on auction terms — no finance clause to hide behind
  $('offer-stf-label').style.display = preAuction ? 'none' : '';
  $('offer-submit').textContent = preAuction ? 'Put it to them tonight' : 'Submit offer';
  show($('offer-panel'));
}

$('offer-cancel').addEventListener('click', () => { hide($('offer-panel')); offerListing = null; unfreeze(); });
$('offer-submit').addEventListener('click', () => {
  const l = offerListing;
  const amount = Number($('offer-amounts').querySelector('.choice.sel')?.dataset.value ?? 0);
  const stf = l.saleType === 'auction' ? false : $('offer-stf').checked; // auction terms: unconditional
  if (!l || !amount) return;
  hide($('offer-panel'));
  offerListing = null;
  submitOffer(l, amount, stf);
});

function submitOffer(l, amount, stf, isBestAndFinal = false) {
  game.offerRound += 1;
  const asking = effAsking(l);
  const vendorMin = effVendorMin(l);
  const method = l.saleType === 'auction' ? 'post-auction' : 'private';
  // real interest drives real competition — what the agent told you was the tell
  const rivalChance = 0.15 * (l.interest ?? 2);
  if (!isBestAndFinal && game.offerRound === 1 && amount < asking * 0.99 && Math.random() < rivalChance) {
    const rival = round1k(amount * 1.013 + 3000);
    const matchAmt = round1k(rival + 3000);
    dialog('The agent calls back', `“Look, awkward timing — another party has just put in <b>${fmt(rival)}</b>. The vendor's asked for best and final by 5pm. Where do you want to land?”`, [
      { label: `Go to ${fmt(matchAmt)}`, disabled: matchAmt > playerMax(l), onClick: () => submitOffer(l, matchAmt, stf, true) },
      { label: 'Let it go', secondary: true, onClick: () => { loseListing(l, `You blinked. ${l.address} went to the other buyer for ${fmt(rival)}.`); } },
    ]);
    return;
  }

  const effective = amount * (stf ? 0.995 : 1);
  if (effective >= vendorMin * 1.015 || amount >= asking) {
    dialog('Offer accepted 🎉', `“Congratulations — the vendor has accepted <b>${fmt(amount)}</b>. I'll send the contract through tonight.”<br><br>Next step: sign the Contract of Sale and pay the deposit.`, [
      { label: 'Review & sign the contract', onClick: () => showContract(l, amount, method, { stf: method === 'private' && stf }) },
    ]);
  } else if (effective >= vendorMin * 0.965 && game.offerRound <= 3) {
    const counter = round1k(Math.min(asking, Math.max(vendorMin * 1.02, (amount + asking) / 2)));
    dialog('Vendor counters', `“They appreciate the offer but they're firm — they'd sign tonight at <b>${fmt(counter)}</b>.”`, [
      { label: `Accept ${fmt(counter)}`, disabled: counter > playerMax(l), onClick: () => showContract(l, counter, method, { stf: method === 'private' && stf }) },
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
  removeOpenHome(l.id);
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

function refreshLoanTypeRow(price) {
  const row = $('loantype-row');
  row.innerHTML = '';
  LOAN_TYPES.forEach((t) => {
    const el = document.createElement('div');
    el.className = 'choice' + (game.loanType.id === t.id ? ' sel' : '');
    el.innerHTML = `${t.label}<small>${((game.rate + t.rateDelta) * 100).toFixed(2)}% — ${t.note}</small>`;
    el.addEventListener('click', () => {
      game.loanType = t;
      refreshLoanTypeRow(price);
    });
    row.appendChild(el);
  });
  const l = game.pendingContract?.listing;
  const s = settlement(price, game.savings, game.preApproval, game.fhb, null, settleOpts(l));
  $('loan-repay').innerHTML = `Repayments on the ${fmt(s.loan)} loan: <b style="color: var(--gold)">${fmt(monthlyRepayment(s.loan, game.rate + game.loanType.rateDelta))}/month</b> for 30 years. Say it out loud once before signing.`;
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
    <div class="crow"><span>Your representative</span><b>${game.solicitor.name}</b></div>
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
  if (l.ownersCorp) {
    clauses += `<div class="clause"><b>Owners corporation:</b> lot is subject to OC rules and fees (${fmt(l.ownersCorp.feesQtr)}/quarter). An OC certificate is attached${game.ocRead.has(l.id) ? ' — you read it.' : ' — 60 pages, unread.'}</div>`;
  }
  if (game.reviews.has(l.id) && !game.reviewMissed.has(l.id) && l.specialCondition) {
    clauses += `<div class="clause"><b>Special condition (flagged by ${game.solicitor.name.split(' — ')[0]}):</b> ${l.specialCondition.clause}</div>`;
  } else if (!game.reviews.has(l.id) || game.reviewMissed.has(l.id)) {
    clauses += `<div class="clause">…followed by 42 pages of special conditions ${game.reviewMissed.has(l.id) ? 'your conveyancer "reviewed" in 11 minutes' : 'nobody has read on your behalf'}.</div>`;
  }
  $('contract-clauses').innerHTML = clauses;
  $('sig-canvas').getContext('2d').clearRect(0, 0, 240, 64);
  $('contract-title').textContent = method === 'auction' ? 'Contract of Sale — sign here, no takesies-backsies' : 'Contract of Sale';
  refreshLoanTypeRow(price);
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
    if (wasAuction && price > l.trueValue) toast('The valuer sucked their teeth, but your numbers held. Loan approved — formally, this time.', 4600);
    finalInspection(l, price, null);
    return;
  }
  const s = settlement(price, game.savings, game.preApproval, game.fhb, l.trueValue, settleOpts(l));
  if (s.cashNeeded <= game.savings) {
    dialog('Valuation shortfall', `The bank's valuer says the place is worth <b>${fmt(l.trueValue)}</b> — not the ${fmt(price)} you're paying. The bank lends against <i>their</i> number, so you must find an extra <b>${fmt(Math.round(price - l.trueValue))}</b> in cash to bridge the gap.<br><br>You can cover it. It'll hurt.`, [
      { label: 'Cover the gap and settle', onClick: () => finalInspection(l, price, l.trueValue) },
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

// ---------- final inspection & settlement day ----------

function finalInspection(l, price, valCap) {
  const issue = Math.random() < 0.35;
  if (!issue) {
    dialog('Final inspection', `The day before settlement you walk through ${l.address} one last time. Everything's as it was on contract day: fixtures present, oven intact, garden not on fire.<br><br><i>Always do the final inspection. Today it's boring. That's the good outcome.</i>`, [
      { label: 'On to settlement', onClick: () => settlementDay(l, price, valCap, 0) },
    ]);
  } else {
    dialog('Final inspection — a problem', `Walking through ${l.address} you find the vendor has left a garage full of junk, and the dishwasher — <i>which was on the fixtures list</i> — is gone.<br><br>Your rights: the property must be in the same condition as contract day.`, [
      { label: 'Have your solicitor demand it be fixed', onClick: () => {
        dialog('Sorted', `${game.solicitor.name.split(' — ')[0]} fires off a letter. The junk vanishes, a dishwasher reappears, settlement proceeds. This is what the final inspection is FOR.`, [
          { label: 'On to settlement', onClick: () => settlementDay(l, price, valCap, 0) },
        ]);
      } },
      { label: 'Let it slide (skip the fuss, wear ~$900)', secondary: true, onClick: () => settlementDay(l, price, valCap, 900) },
    ]);
  }
}

function settlementDay(l, price, valCap, inspectionCost) {
  const delayed = Math.random() < game.solicitor.delayChance;
  const penalty = delayed ? 580 : 0;
  const body = `Settlement happens on <b>PEXA</b> — an online workspace where your solicitor, your lender, and the vendor's side exchange the money and the title at a booked time. You don't attend; you just wait for the call.<br><br>` +
    `A <b>statement of adjustments</b> splits council rates and water at settlement day (${fmt(620)} your share${l.ownersCorp ? `, plus prorated OC fees` : ''}).` +
    (delayed ? `<br><br>⚠ ${game.solicitor.name.split(' — ')[0]} missed the booking slot — the vendor's side charged <b>penalty interest ${fmt(penalty)}</b> and you settled 4 days late. Cheap conveyancing has a price.` : `<br><br>${game.solicitor.name.split(' — ')[0]} settles on time, first attempt. The agent texts: “keys at the office 🎉”.`);
  dialog(delayed ? 'Settlement day (…and a bit)' : 'Settlement day', body, [
    { label: 'Get the keys 🔑', onClick: () => settle(l, price, valCap, { inspectionCost, penalty }) },
  ]);
}

// ---------- talking to the agent ----------
// Every answer is spin with a signal inside. The signal is real: interest level
// drives who turns up on auction day and whether rival offers appear.

let chatListing = null;

const INTEREST_SPIN = [
  { line: 'Honestly? It\'s been… boutique. A few through the opens, nothing on paper. Between you and me, the vendor\'s getting twitchy.', note: 'agent hints interest is DEAD' },
  { line: 'Steady. Genuine buyers, second inspections booked. Nothing frantic — the right home finds the right buyer, as we say.', note: 'agent: interest is lukewarm' },
  { line: 'Strong. Two contracts requested this week and a building inspection\'s been done — someone\'s serious. I\'d be organised.', note: 'agent: strong interest — expect company' },
  { line: 'Enormous. Forty groups through, four contracts out, my phone hasn\'t stopped. I\'d have your ducks in a row, and your ducks\' ducks.', note: 'agent: RED HOT — a crowd is coming' },
];

function agentAnswer(l, qid) {
  const firstHalf = (a, b) => l.interest <= 1 ? a : b;
  switch (qid) {
    case 'interest':
      return { text: INTEREST_SPIN[l.interest].line, note: INTEREST_SPIN[l.interest].note };
    case 'price': {
      if (l.saleType === 'auction') {
        const stretch = l.reserve > l.guide[1] * 1.02;
        return stretch
          ? { text: 'Look, the guide\'s the guide. But if you\'re asking where the vendor\'s head is at… I\'d want to see the <b>top of the range, and then daylight</b>. You didn\'t hear that from me.', note: 'agent tipped: reserve is ABOVE the guide' }
          : { text: 'The range is honest on this one — the vendor\'s a realist. On the day it\'s their call, but I don\'t see silly numbers here.', note: 'agent tipped: guide is roughly honest' };
      }
      const soft = l.vendorMin <= l.asking * 0.96;
      return soft
        ? { text: 'Between us? There\'s a <b>conversation to be had</b>. Put something sensible in writing and I\'ll walk it in tonight.', note: 'agent hinted vendor will move on price' }
        : { text: 'They\'re firm. I\'ve put two offers to them already and they didn\'t blink. The price is the price — I\'d spend your energy elsewhere in the negotiation.', note: 'agent says vendor is FIRM on price' };
    }
    case 'why':
      return { text: l.agentWhy + (l.id === 'bungalow' || l.id === 'weatherboard' || l.id === 'reno' || l.id === 'townhouse' ? ' <span class="tell">A motivated vendor is a negotiable vendor. File that away.</span>' : ''), note: 'why selling: ' + l.agentWhy.split('.')[0] };
    case 'time': {
      const weeks = l.listedWeeks + (game.week - 1);
      const stale = weeks >= 8;
      return {
        text: `${weeks} weeks now.` + (stale
          ? ' <span class="tell">He says it quickly, the way you\'d mention a rash.</span> Look — the vendor\'s been "recalibrating expectations", if you follow me.'
          : ' Fresh to market. The first fortnight is when the real buyers show up — that\'s now.'),
        note: `${weeks} weeks on market${stale ? ' — STALE, leverage' : ''}`,
      };
    }
    case 'offers':
      return {
        text: firstHalf(
          'There\'s interest.” <span class="tell">A beat too long before "interest".</span> “Nothing I can disclose. But if an offer landed tonight I don\'t think it\'d be a long meeting.',
          'I have one buyer at contract-request stage and another circling. I\'m not allowed to invent urgency — but I\'m not inventing this. Move or don\'t.'
        ),
        note: firstHalf('agent has NO real offers — leverage', 'agent claims live competing buyers'),
      };
    case 'prior':
      return {
        text: 'Officially, the vendor\'s committed to auction.” <span class="tell">He glances up the street, then lowers his voice.</span> “Unofficially — bring me a strong number tonight and I\'ll put it to them. Worth knowing: within three business days either side of an advertised auction there\'s <b>no cooling-off</b>. Same rules as the day itself.',
        note: 'vendor would consider a PRE-AUCTION offer',
        unlock: true,
      };
    default:
      return { text: 'No worries. You\'ve got my number — it\'s on the board, the flag, and the pen you\'re holding.', note: null };
  }
}

function chatQuestions(l) {
  const qs = [
    { id: 'interest', label: 'How much interest has there been?' },
    { id: 'price', label: l.saleType === 'auction' ? 'Where do you really see it landing?' : 'Any movement on the price?' },
    { id: 'why', label: 'Why are they selling?' },
    { id: 'time', label: 'How long has it been on the market?' },
  ];
  if (l.saleType === 'private') qs.push({ id: 'offers', label: 'Any other offers on the table?' });
  if (l.saleType === 'auction' && l.interest <= 1 && (game.asked[l.id]?.has('interest')))
    qs.push({ id: 'prior', label: 'Would they look at an offer before auction day?' });
  return qs;
}

function chatBubble(text, who) {
  const div = document.createElement('div');
  div.className = `bubble ${who}`;
  div.innerHTML = text;
  const log = $('chat-log');
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function renderChatQuestions(l) {
  const wrap = $('chat-questions');
  wrap.innerHTML = '';
  const asked = game.asked[l.id] ??= new Set();
  for (const q of chatQuestions(l)) {
    const btn = document.createElement('button');
    btn.className = 'btn secondary';
    btn.textContent = (asked.has(q.id) ? '↻ ' : '') + q.label;
    btn.addEventListener('click', () => askAgent(l, q));
    wrap.appendChild(btn);
  }
  if (l.saleType === 'auction' && game.agentNotes[l.id]?.prior) {
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = '✉️ Make a pre-auction offer';
    btn.addEventListener('click', () => { closeChat(true); openOfferModal(l); });
    wrap.appendChild(btn);
  }
  const bye = document.createElement('button');
  bye.className = 'btn secondary';
  bye.style.opacity = '0.75';
  bye.textContent = '“Thanks — just looking.”';
  bye.addEventListener('click', () => closeChat());
  wrap.appendChild(bye);
}

function askAgent(l, q) {
  const asked = game.asked[l.id] ??= new Set();
  chatBubble(q.label, 'you');
  if (asked.has(q.id)) {
    chatBubble('As I said — ' + agentAnswer(l, q.id).text.charAt(0).toLowerCase() + agentAnswer(l, q.id).text.slice(1), 'agent');
  } else {
    asked.add(q.id);
    const a = agentAnswer(l, q.id);
    chatBubble('“' + a.text + '”', 'agent');
    if (a.note) {
      (game.agentNotes[l.id] ??= {})[q.id] = a.note;
      saveGame();
    }
  }
  blip(520 + Math.random() * 120, 0.06, 'sine', 0.03);
  renderChatQuestions(l);
}

function openChat(l, viaPhone = false) {
  if (game.soldTo[l.id] || (game.phase !== 'explore')) return;
  chatListing = l;
  freeze();
  $('chat-sub').innerHTML = `${l.address} · ${l.saleType === 'auction' ? 'auction campaign' : 'private sale'}` +
    (viaPhone ? ' · <i>you dial the number on the board</i>' : ' · <i>he clocks you coming up the path and straightens his lanyard</i>');
  $('chat-log').innerHTML = '';
  chatBubble(viaPhone
    ? '“Ray Wight. …Ah, the buyer from the open! Good sign, calling. What do you want to know?”'
    : '“G\'day! Ray. Beautiful home, isn\'t it? The light in that living room — I mean. Anyway. Ask me anything.”', 'agent');
  renderChatQuestions(l);
  show($('chat-panel'));
}

function closeChat(silent = false) {
  hide($('chat-panel'));
  chatListing = null;
  if (!silent) unfreeze();
}

$('lp-call-btn').addEventListener('click', () => {
  if (!panelListing) return;
  const l = panelListing;
  hide($('listing-panel'));
  panelListing = null;
  openChat(l, true);
});

// ---------- open homes: the competition, visible ----------

// house-local (x, z) -> world, accounting for lot rotation and the 3.5 setback
function houseLocalToWorld(l, x, z) {
  const lz = z - 3.5;
  return l.lot.facing === 1
    ? new THREE.Vector3(l.lot.x + lz, 0, l.lot.z - x)
    : new THREE.Vector3(l.lot.x - lz, 0, l.lot.z + x);
}

const openHomes = {}; // listingId -> { group, buyers: [...], agent }
const BUYER_COLORS = [0x7d5a8a, 0x4f7d6b, 0xb0704a, 0x5a6e8c, 0x8c5a5a, 0x6e7d4f];

function spawnOpenHome(l) {
  if (openHomes[l.id] || game.soldTo[l.id]) return;
  const group = new THREE.Group();
  const rooms = houses[l.id].rooms;
  const [, d] = HOUSE_DIMS[l.id];
  const buyers = [];
  const n = 1 + Math.floor(Math.random() * 2);
  for (let i = 0; i < n; i++) {
    const p = buildPerson(BUYER_COLORS[Math.floor(Math.random() * BUYER_COLORS.length)]);
    const room = rooms[Math.floor(Math.random() * rooms.length)];
    p.position.copy(houseLocalToWorld(l, room.cx, room.cz));
    p.position.y = 0.13;
    group.add(p);
    buyers.push({
      person: p, listing: l,
      room, path: [], idleUntil: performance.now() + Math.random() * 3000,
    });
  }
  // the agent, planted at the front door with a smile that never moves
  const agent = buildPerson(0x1f2937);
  agent.position.copy(houseLocalToWorld(l, 0.9, d / 2 + 1.5));
  const street = houseLocalToWorld(l, 0.9, d / 2 + 8);
  agent.lookAt(street.x, 0, street.z);
  group.add(agent);
  scene.add(group);
  openHomes[l.id] = { group, buyers, agent };
}

function removeOpenHome(id) {
  const oh = openHomes[id];
  if (!oh) return;
  scene.remove(oh.group);
  delete openHomes[id];
}

function spawnAllOpenHomes() {
  for (const l of listings) if (!game.soldTo[l.id]) spawnOpenHome(l);
}

// walk room -> hallway -> hallway -> room so nobody ghosts through a wall
function planPath(b) {
  const l = b.listing;
  const rooms = houses[l.id].rooms;
  let target = rooms[Math.floor(Math.random() * rooms.length)];
  if (rooms.length > 1) {
    while (target === b.room) target = rooms[Math.floor(Math.random() * rooms.length)];
  }
  b.path = [
    houseLocalToWorld(l, 0, b.room.cz),
    houseLocalToWorld(l, 0, target.cz),
    houseLocalToWorld(l, target.cx, target.cz),
  ];
  b.room = target;
}

function updateOpenHomes(dt) {
  const now = performance.now();
  for (const id in openHomes) {
    for (const b of openHomes[id].buyers) {
      if (now < b.idleUntil) {
        b.person.rotation.y += dt * 0.4; // having a good look at the cornices
        continue;
      }
      if (!b.path.length) { planPath(b); continue; }
      const targetPos = b.path[0];
      const p = b.person.position;
      const dx = targetPos.x - p.x, dz = targetPos.z - p.z;
      const dist = Math.hypot(dx, dz);
      if (dist < 0.15) {
        b.path.shift();
        if (!b.path.length) b.idleUntil = now + 2500 + Math.random() * 4000;
        continue;
      }
      const step = Math.min(dist, 1.1 * dt);
      p.x += (dx / dist) * step;
      p.z += (dz / dist) * step;
      b.person.rotation.y = Math.atan2(dx, dz);
    }
  }
}

// ---------- arm raises (bids, in the flesh) ----------

const armAnims = []; // { pivot, until }

function raiseArm(person, ms = 1500) {
  if (!person?.userData.rightArm) return;
  armAnims.push({ pivot: person.userData.rightArm, until: performance.now() + ms });
}

function updateArms(dt) {
  const now = performance.now();
  for (let i = armAnims.length - 1; i >= 0; i--) {
    const a = armAnims[i];
    const target = now < a.until ? -2.7 : 0.14;
    a.pivot.rotation.z += (target - a.pivot.rotation.z) * Math.min(1, dt * 12);
    if (now > a.until && Math.abs(a.pivot.rotation.z - 0.14) < 0.02) armAnims.splice(i, 1);
  }
}

// ---------- auction ----------

let crowd = null;
let rivalActors = {}; // rival name -> crowd person

function maybeStartAuction(l) {
  if (!game.reviews.has(l.id)) {
    dialog('Before you raise your hand…', `Bidding at auction is <b>unconditional</b>: no cooling-off, no finance clause, 10% deposit on the spot if you win. Nobody has checked this contract or the Section 32 for you.<br><br>A review by ${game.solicitor.name.split(' — ')[0]} is ${fmt(game.solicitor.review)}.`, [
      { label: `Review the contract first (${fmt(game.solicitor.review)})`, disabled: game.savings < game.solicitor.review, onClick: () => {
        game.savings -= game.solicitor.review;
        game.reviews.add(l.id);
        if (Math.random() < game.solicitor.missChance) game.reviewMissed.add(l.id);
        updateHUD();
        const missed = game.reviewMissed.has(l.id);
        const found = (l.specialCondition && !missed)
          ? `⚠ Your solicitor rings an hour later: “${l.specialCondition.clause}”`
          : missed
            ? '“All good — standard contract 👍” (The reply came back in 11 minutes. Hm.)'
            : 'Your solicitor rings back: contract is clean. Bid with confidence — up to your limit, not past it.';
        dialog('Contract review', found, [{ label: 'To the auction', onClick: () => startAuction(l.id) }]);
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
  crowd.userData.people = [];
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
    crowd.userData.people.push(p);
  }
  const auctioneer = buildPerson(0xffcd00);
  auctioneer.position.copy(frontPos.clone().addScaledVector(toHouse, 4.6));
  auctioneer.lookAt(frontPos.x, 0, frontPos.z);
  crowd.add(auctioneer);
  crowd.userData.auctioneer = auctioneer;
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
  game.fhbgCapWarned = false;
  freeze();

  const house = houses[id];
  removeOpenHome(id); // the lookers make way for the bidders
  const back = house.frontPos.clone().sub(house.centre).normalize().multiplyScalar(2.5);
  player.teleport(house.frontPos.x + back.x, house.frontPos.z + back.z);
  player.lookAt(house.centre);
  spawnCrowd(house);

  $('auction-addr').textContent = `${l.address} · guide ${signTextFor(l)}`;
  $('auction-log').innerHTML = '';
  $('current-bid').textContent = '—';
  $('bid-leader').textContent = 'Waiting for an opening bid…';
  $('bid-leader').classList.remove('you');
  $('max-note').innerHTML = `Your absolute ceiling: <b>${fmt(playerMax(l))}</b> — the bank, not the heart, sets it.` +
    (game.schemes.fhbg ? `<br>First Home Guarantee holds to ${fmt(FHBG_PRICE_CAP)} — past that, LMI is back.` : '');
  show($('auction-panel'));

  game.auction = new Auction(l, {
    playerMax: playerMax(l),
    heat: game.heat,
    interest: l.interest,
    onEvent: (type, data) => onAuctionEvent(l, type, data),
  });
  // each rival gets a body in the crowd; their bids raise that arm
  rivalActors = {};
  game.auction.rivals.forEach((r, i) => {
    rivalActors[r.name] = crowd.userData.people[i * 2] ?? crowd.userData.people[i];
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
      if (game.schemes.fhbg && !game.fhbgCapWarned && data.amount > FHBG_PRICE_CAP) {
        game.fhbgCapWarned = true;
        toast(`⚠ You've bid past the ${fmt(FHBG_PRICE_CAP)} First Home Guarantee cap — LMI is back on the table.`, 5000);
      }
    } else {
      leader.textContent = data.who === 'vendor' ? 'Vendor bid (protecting the reserve)' : `Leading bid: ${data.who}`;
      leader.classList.remove('you');
      blip(430, 0.09, 'sine', 0.05);
      raiseArm(data.who === 'vendor' ? crowd?.userData.auctioneer : rivalActors[data.who]);
    }
  }
  if (type === 'call') {
    if (data.stage >= 2) raiseArm(crowd?.userData.auctioneer, 900); // gavel hand hovering
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
      const affordable = asking <= playerMax(l);
      dialog('Passed in — you hold the highest bid', `Your ${fmt(data.amount)} was the best genuine bid, but the reserve wasn't met. Inside, over lukewarm instant coffee, the agent says the vendor will sign tonight at <b>${fmt(asking)}</b>.${affordable ? '' : `<br><br>⚠ That's beyond your ceiling of ${fmt(playerMax(l))}.`}<br><br><i>Buying within 3 business days of an auction still means no cooling-off.</i>`, [
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
  saveGame();
  unfreeze();
}

function advanceWeek() {
  game.week += 1;
  const g = game.marketGrowth;
  game.marketIndex *= g;
  for (const l of listings) {
    if (game.soldTo[l.id]) continue;
    if (l.isNew) continue; // the developer's price list doesn't move week to week
    l.guide = [Math.round(l.guide[0] * g), Math.round(l.guide[1] * g)];
    l.trueValue = Math.round(l.trueValue * g);
    l.reserve = Math.round(l.reserve * g);
    if (l.asking) l.asking = round1k(l.asking * g);
    if (l.vendorMin) l.vendorMin = Math.round(l.vendorMin * g);
    houses[l.id].sign.userData.updateSign(signTextFor(l), null);
  }
  if (!game.rateRiseDone && !game.ownedId && game.week >= 5) game.rateRisePending = true;
}

// ---------- the RBA does not care about your Saturday plans ----------

function noOverlaysOpen() {
  return ['dialog-panel', 'contract-panel', 'result-panel', 'listing-panel', 'offer-panel', 'summary-panel', 'chat-panel']
    .every((id) => !$(id) || $(id).classList.contains('hidden'));
}

function fireRateRise() {
  game.rateRiseDone = true;
  game.rateRisePending = false;
  const oldRate = game.rate, oldPre = game.preApproval;
  game.rate += 0.005;
  game.preApproval = round1k(game.preApproval * 0.95);
  game.marketGrowth = 1.008; // hot air comes out of the market a little
  const oldRepay = monthlyRepayment(oldPre, oldRate);
  const newRepay = monthlyRepayment(game.preApproval, game.rate);
  updateHUD();
  saveGame();
  dialog('📈 The RBA moves — cash rate up 0.50%', `Tuesday, 2:30pm. The Reserve Bank lifts the cash rate half a percent and every lender passes it on by Friday.<br><br>
    <b>Your rate:</b> ${(oldRate * 100).toFixed(2)}% → <b>${(game.rate * 100).toFixed(2)}%</b><br>
    <b>Your pre-approval:</b> ${fmt(oldPre)} → <b>${fmt(game.preApproval)}</b> — the lender reassessed your serviceability at the higher rate. Nobody rings to tell you; you find out when you ask.<br>
    <b>Repayments on a maxed loan:</b> ${fmt(oldRepay)}/mo → <b>${fmt(newRepay)}/mo</b><br><br>
    Every variable-rate borrower in the country just got the same news. Auction crowds thin out a touch — but the house you could afford last month, you might not afford now.`, [
    { label: 'Recalculate and carry on', onClick: unfreeze },
  ]);
}

document.querySelectorAll('.bidbtns .btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (!game.auction) return;
    const res = game.auction.playerBid(Number(btn.dataset.inc));
    if (!res.ok) toast(res.reason, 2500);
  });
});

// ---------- settlement & endings ----------

function settle(l, price, valCap = null, extras = {}) {
  game.phase = 'settled';
  game.ownedId = l.id;
  game.offerRound = 0;
  game.soldTo[l.id] = 'you';
  houses[l.id].sign.userData.updateSign(signTextFor(l), 'you');
  removeOpenHome(l.id);

  const s = settlement(price, game.savings, game.preApproval, game.fhb, valCap, settleOpts(l));
  const missed = game.reviewMissed.has(l.id);
  const surprise = ((!game.reviews.has(l.id) || missed) && l.specialCondition) ? l.specialCondition : null;
  const surpriseCost = surprise ? surprise.surpriseCost : 0;
  // boutique firms negotiate an allowance for special conditions they catch before signing
  const allowance = (game.solicitor.id === 'boutique' && game.reviews.has(l.id) && !missed && l.specialCondition)
    ? Math.round(l.specialCondition.surpriseCost * 0.5) : 0;
  const levy = l.ownersCorp ? l.ownersCorp.levy : 0;
  const inspectionCost = extras.inspectionCost ?? 0;
  const penalty = extras.penalty ?? 0;

  game.savings = Math.max(0, Math.round(
    s.cashLeft - l.repairCost - surpriseCost - levy - inspectionCost - penalty + allowance
  ));

  const position = l.trueValue - price - surpriseCost - levy + allowance + s.grant;
  let verdictCls, verdictText;
  if (position >= 20000) {
    verdictCls = 'good';
    verdictText = `🏆 All in, you're ${fmt(position)} ahead of market value. An absolute win — this one's going straight to the pool room.`;
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

  const repay = monthlyRepayment(s.loan, game.rate + game.loanType.rateDelta);
  $('res-title').textContent = `🎉 SETTLED — ${l.address} is yours`;
  $('res-sub').innerHTML = `${l.style} · week ${game.week} · ${game.loanType.label} at ${((game.rate + game.loanType.rateDelta) * 100).toFixed(2)}% via ${LENDERS[game.lender].name} — <b>${fmt(repay)}/month</b> from here on` +
    (l.ownersCorp ? ` · plus OC fees ${fmt(l.ownersCorp.feesQtr)}/quarter, forever` : '');
  const v = $('res-verdict');
  v.className = `verdict ${verdictCls}`;
  v.textContent = verdictText;
  show(v);

  const dutyLabel = game.fhb && s.duty === 0 ? 'Stamp duty (FHB exempt 🎉)' : 'Stamp duty';
  const lmiLabel = s.fhbg ? 'LMI (waived — First Home Guarantee 🎉)'
    : (game.guarantor && s.lmi === 0 && s.lvr > 0.8) ? 'LMI (waived — family guarantee 🙏)'
    : `Lenders mortgage insurance${s.lmi === 0 ? ' (LVR ≤ 80%)' : ''}`;
  const rows = [
    ['Purchase price', fmt(s.price)],
    [`Loan drawn (LVR ${(s.lvr * 100).toFixed(0)}%${valCap ? ', against the bank\'s valuation' : ''})`, '−' + fmt(s.loan)],
    ['Deposit + gap from savings', fmt(s.deposit)],
    [dutyLabel, fmt(s.duty)],
    [lmiLabel, fmt(s.lmi)],
    [`Conveyancing — ${game.solicitor.name.split(' — ')[0]}`, fmt(s.conveyancing)],
    ['Statement of adjustments (rates, water)', fmt(s.adjustments)],
  ];
  if (s.grant) rows.push(['First Home Owner Grant (new home)', '−' + fmt(s.grant)]);
  rows.push([game.reports.has(l.id) ? 'Repairs (as per your report)' : '⚠ Surprise repairs (no report ordered…)', fmt(l.repairCost)]);
  if (levy) rows.push([game.ocRead.has(l.id) ? 'OC special levy (you saw it coming)' : '⚠ Surprise OC special levy (never read the records)', fmt(levy)]);
  if (surprise) rows.push([`⚠ ${surprise.surprise} ${missed ? '(your conveyancer "reviewed" it in 11 minutes)' : '(unreviewed contract)'}`, fmt(surpriseCost)]);
  if (allowance) rows.push([`Allowance negotiated by ${game.solicitor.name.split(' — ')[0]}`, '−' + fmt(allowance)]);
  if (inspectionCost) rows.push(['Final-inspection issues you let slide', fmt(inspectionCost)]);
  if (penalty) rows.push(['⚠ Penalty interest (late settlement)', fmt(penalty)]);
  $('res-costs').innerHTML = `<table class="costs">
    ${rows.map(([k, val]) => `<tr><td>${k}</td><td>${val}</td></tr>`).join('')}
    <tr class="total"><td>Cash remaining</td><td>${fmt(game.savings)}</td></tr>
  </table>`;
  $('res-continue').textContent = 'Move in 🔑';
  game.purchase = { listing: l, price, loan: s.loan, fhbg: s.fhbg };
  $('res-epilogue').textContent = 'Fast-forward 5 years ⏩';
  show($('res-epilogue'));
  show($('result-panel'));
  updateHUD();
  saveGame();
}

function gameOver() {
  game.phase = 'over';
  clearSave();
  freeze();
  $('res-title').textContent = '📉 Priced out';
  $('res-sub').textContent = `Every home on Banksia Street sold to someone else. ${game.week} weeks of Saturdays, and nothing to show but sausage sizzle receipts.`;
  hide($('res-verdict'));
  $('res-costs').innerHTML = `<p class="sub" style="margin-top:10px">The market rose ${((game.marketIndex - 1) * 100).toFixed(1)}% while you watched. Classic.</p>`;
  $('res-continue').textContent = 'Try again next season';
  $('res-epilogue').textContent = 'See where 5 years of renting leads ⏩';
  show($('res-epilogue'));
  show($('result-panel'));
}

$('res-continue').addEventListener('click', () => {
  if (game.phase === 'over') { location.reload(); return; }
  hide($('result-panel'));
  $('hint').innerHTML = '🏡 It\'s yours. Walk inside and admire the castle — press <b>T</b> any time to fast-forward five years.';
  player.enabled = true;
  player.requestLock();
});
$('res-epilogue').addEventListener('click', runEpilogue);
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyT' && game.phase === 'settled' && noOverlaysOpen()) runEpilogue();
});

// ---------- five years later ----------

// Rate path over 60 months: two more hikes, then relief. Fixed loans are immune
// for 24 months, then hit the cliff onto a higher revert rate.
function epilogueRate(month) {
  let variable = game.rate;
  if (month >= 6) variable += 0.0025;
  if (month >= 12) variable += 0.0025;
  if (month >= 30) variable -= 0.0025;
  if (month >= 42) variable -= 0.0025;
  if (game.loanType.id === 'fixed') {
    return month < 24 ? game.rate + game.loanType.rateDelta : variable + 0.0015; // revert-rate spread
  }
  return variable + game.loanType.rateDelta;
}

function runEpilogue() {
  freeze();
  clearSave(); // the run is over either way
  hide($('result-panel'));
  if (game.purchase) ownedEpilogue();
  else pricedOutEpilogue();
  game.phase = 'over'; // res-continue now restarts
}

function ownedEpilogue() {
  const { listing: l, price, loan } = game.purchase;
  // amortise 60 months, repayment recalculated whenever the rate steps
  let bal = loan, interestPaid = 0, lastRate = -1, repay = 0, cliffJump = 0;
  for (let m = 0; m < 60; m++) {
    const r = epilogueRate(m);
    if (r !== lastRate) {
      const prevRepay = repay;
      repay = bal * (r / 12) / (1 - Math.pow(1 + r / 12, -(360 - m))); // recompute over remaining term
      if (game.loanType.id === 'fixed' && m === 24) cliffJump = repay - prevRepay;
      lastRate = r;
    }
    const interest = bal * lastRate / 12;
    interestPaid += interest;
    bal -= (repay - interest);
  }

  // value: houses outgrow apartments; the renovator's delight pays for the brave
  const annualGrowth = l.ownersCorp ? 0.025 : 0.04;
  const basis = l.trueValue + (l.id === 'reno' ? l.repairCost * 1.8 : l.repairCost);
  const value = Math.round(basis * Math.pow(1 + annualGrowth, 5));

  // your cash: in the offset it fights the loan rate; otherwise a term deposit
  const offset = game.loanType.id !== 'fixed';
  const cashRate = offset ? (game.rate + 0.005) : 0.04;
  let cash = Math.round(game.savings * Math.pow(1 + cashRate, 5));
  const ocDrag = l.ownersCorp ? l.ownersCorp.feesQtr * 20 + 3000 : 0; // 5yrs of fees + a small second levy
  cash = Math.max(0, cash - ocDrag);

  const equity = Math.round(value - bal);
  const renterCash = Math.round(180000 * Math.pow(1.045, 5));
  const netWorth = equity + cash;
  const delta = netWorth - renterCash;

  $('res-title').textContent = '⏩ Five years later';
  $('res-sub').innerHTML = `Rates went up twice more, then came off the boil. ` +
    (game.loanType.id === 'fixed' ? `Your fixed rate expired in year 2 — repayments jumped <b>${fmt(cliffJump)}/month</b> overnight. The fixed-rate cliff is real. ` : `Your offset savings quietly saved you interest at the loan rate the whole time. `) +
    (game.guarantor ? `Year 2: your equity passed 20% and <b>your parents' guarantee was released</b> — Christmas lunch got easier. ` : '') +
    (l.ownersCorp ? `The owners corp levied once more (small, this time) and the fees never stopped. ` : '') +
    (l.id === 'reno' ? `The renovation was dust, tears and $${Math.round(l.repairCost / 1000)}k — and it built more value than it cost. ` : '');
  const v = $('res-verdict');
  v.className = `verdict ${delta >= 40000 ? 'good' : delta >= -20000 ? 'ok' : 'bad'}`;
  v.textContent = delta >= 40000
    ? `🏆 You're ${fmt(delta)} ahead of where renting and investing would have left you. The castle delivered.`
    : delta >= -20000
      ? `👍 Roughly line-ball with renting so far (${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))}) — but your rate is falling, your rent would've kept rising, and the equity curve bends your way from here.`
      : `😬 Renting and investing would've left you ${fmt(-delta)} better off so far. Early years are the hardest — the interest-heavy end of the loan plus what you overpaid on day one.`;
  show(v);
  $('res-costs').innerHTML = `<table class="costs">
    <tr><td>${l.address} today (${(annualGrowth * 100).toFixed(1)}%/yr)</td><td>${fmt(value)}</td></tr>
    <tr><td>Loan remaining (of ${fmt(loan)})</td><td>−${fmt(Math.round(bal))}</td></tr>
    <tr><td>Interest paid over 5 years</td><td>${fmt(Math.round(interestPaid))}</td></tr>
    <tr><td>Your equity</td><td>${fmt(equity)}</td></tr>
    <tr><td>Cash & ${offset ? 'offset' : 'savings'}${ocDrag ? ' (after OC fees + levy)' : ''}</td><td>${fmt(cash)}</td></tr>
    <tr><td>If you'd rented & invested instead</td><td>${fmt(renterCash)}</td></tr>
    <tr class="total"><td>Net position vs renting</td><td>${delta >= 0 ? '+' : '−'}${fmt(Math.abs(delta))}</td></tr>
  </table>`;
  $('res-continue').textContent = 'Play again';
  hide($('res-epilogue'));
  show($('result-panel'));
}

function pricedOutEpilogue() {
  const dearest = listings.reduce((a, b) => (a.trueValue > b.trueValue ? a : b));
  const cheapest = listings.reduce((a, b) => (a.trueValue < b.trueValue ? a : b));
  const grow = (n) => Math.round(n * Math.pow(1.035, 5));
  const savingsNow = Math.round(game.savings * Math.pow(1.045, 5));
  const entry = grow(cheapest.trueValue);
  const cashNeeded = Math.round(entry * 0.05 + 25000); // 5% + duty-ish
  $('res-title').textContent = '⏩ Five years later — still renting';
  $('res-sub').textContent = 'Rent went up every February. The landlord sold once, which meant moving. You kept saving. So did the market.';
  const v = $('res-verdict');
  v.className = 'verdict bad';
  v.textContent = `📉 The market compounds. Wages don't. The homes you inspected are worth ${((Math.pow(1.035, 5) - 1) * 100).toFixed(0)}% more; your savings grew ${((Math.pow(1.045, 5) - 1) * 100).toFixed(0)}% — minus five years of rent.`;
  show(v);
  $('res-costs').innerHTML = `<table class="costs">
    <tr><td>${cheapest.address} (the one you passed on) today</td><td>${fmt(grow(cheapest.trueValue))}</td></tr>
    <tr><td>${dearest.address} today</td><td>${fmt(grow(dearest.trueValue))}</td></tr>
    <tr><td>Five years of rent, gone</td><td>${fmt(143000)}</td></tr>
    <tr><td>Your savings now</td><td>${fmt(savingsNow)}</td></tr>
    <tr class="total"><td>Still enough to get in? (need ~${fmt(cashNeeded)})</td><td>${savingsNow >= cashNeeded ? 'Just — go again' : 'Not in this suburb'}</td></tr>
  </table>`;
  $('res-continue').textContent = 'Play again';
  hide($('res-epilogue'));
  show($('result-panel'));
}

// ---------- save / resume ----------

const SAVE_KEY = 'auction-day-save-v1';

function saveGame() {
  if (game.phase !== 'explore' && game.phase !== 'settled') return;
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      v: 1,
      phase: game.phase, week: game.week, savings: game.savings,
      preApproval: game.preApproval, rate: game.rate, lender: game.lender,
      income: game.income, household: game.household,
      solicitorId: game.solicitor.id, loanTypeId: game.loanType.id,
      schemes: game.schemes, fhb: game.fhb, heat: game.heat, guarantor: game.guarantor,
      soldTo: game.soldTo, ownedId: game.ownedId,
      reports: [...game.reports], reviews: [...game.reviews],
      reviewMissed: [...game.reviewMissed], ocRead: [...game.ocRead],
      rateRiseDone: game.rateRiseDone, marketGrowth: game.marketGrowth, marketIndex: game.marketIndex,
      agentNotes: game.agentNotes,
      purchase: game.purchase ? { id: game.purchase.listing.id, price: game.purchase.price, loan: game.purchase.loan, fhbg: game.purchase.fhbg } : null,
      pos: { x: player.pos.x, z: player.pos.z, yaw: player.yaw },
      listings: Object.fromEntries(listings.map((l) => [l.id, {
        guide: l.guide, trueValue: l.trueValue, reserve: l.reserve,
        asking: l.asking ?? null, vendorMin: l.vendorMin ?? null,
        interest: l.interest ?? 1,
      }])),
    }));
  } catch { /* private browsing etc — the game just won't persist */ }
}

function clearSave() {
  try { localStorage.removeItem(SAVE_KEY); } catch { /* fine */ }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d?.v === 1 ? d : null;
  } catch { return null; }
}

function resumeGame(d) {
  Object.assign(game, {
    phase: d.phase, week: d.week, savings: d.savings,
    preApproval: d.preApproval, rate: d.rate, lender: d.lender,
    income: d.income, household: d.household,
    schemes: d.schemes, fhb: d.fhb, heat: d.heat, guarantor: d.guarantor,
    soldTo: d.soldTo, ownedId: d.ownedId,
    rateRiseDone: d.rateRiseDone, marketGrowth: d.marketGrowth, marketIndex: d.marketIndex,
  });
  game.solicitor = SOLICITORS.find((s) => s.id === d.solicitorId) ?? SOLICITORS[1];
  game.loanType = LOAN_TYPES.find((t) => t.id === d.loanTypeId) ?? LOAN_TYPES[0];
  game.reports = new Set(d.reports);
  game.reviews = new Set(d.reviews);
  game.reviewMissed = new Set(d.reviewMissed);
  game.ocRead = new Set(d.ocRead);
  game.purchase = d.purchase ? { listing: byId[d.purchase.id], price: d.purchase.price, loan: d.purchase.loan, fhbg: d.purchase.fhbg } : null;
  game.agentNotes = d.agentNotes ?? {};
  for (const [id, snap] of Object.entries(d.listings)) {
    const l = byId[id];
    if (!l) continue;
    Object.assign(l, {
      guide: snap.guide, trueValue: snap.trueValue, reserve: snap.reserve,
      interest: snap.interest ?? 1,
      ...(snap.asking != null ? { asking: snap.asking } : {}),
      ...(snap.vendorMin != null ? { vendorMin: snap.vendorMin } : {}),
    });
    houses[id].sign.userData.updateSign(signTextFor(l), game.soldTo[id] ?? null);
  }
  hide($('start-screen'));
  show($('hud'));
  show($('crosshair'));
  show($('hint'));
  if (game.phase === 'settled') $('hint').innerHTML = '🏡 It\'s yours. Press <b>T</b> any time to fast-forward five years.';
  updateHUD();
  spawnAllOpenHomes();
  ambience.start();
  player.teleport(d.pos.x, d.pos.z, d.pos.yaw);
  player.enabled = true;
  player.requestLock();
  toast(`Resumed — week ${game.week}, ${fmt(game.savings)} in savings. The hunt continues.`, 4200);
}

{
  const saved = loadSave();
  if (saved) {
    const btn = $('resume-btn');
    btn.textContent = `▶ Resume your search — week ${saved.week}, ${fmt(saved.savings)} saved`;
    show(btn);
    btn.addEventListener('click', () => resumeGame(loadSave()));
  }
}

// ---------- your notes (M) ----------

function summaryOpen() { return !$('summary-panel').classList.contains('hidden'); }

function toggleSummary() {
  if (summaryOpen()) {
    hide($('summary-panel'));
    unfreeze();
    return;
  }
  if (game.phase !== 'explore' && game.phase !== 'settled') return;
  if (!noOverlaysOpen()) return;
  freeze();
  $('summary-sub').textContent = `Week ${game.week} · savings ${fmt(game.savings)} · ceiling ${fmt(playerMax())}`;
  const rows = listings.map((l) => {
    const sold = game.soldTo[l.id];
    const status = sold === 'you' ? '<b style="color:#4cd07d">YOURS 🔑</b>'
      : sold ? '<span style="color:#ff8f8a">SOLD</span>'
      : l.saleType === 'auction' ? 'Auction' : 'Private sale';
    const price = l.saleType === 'auction' ? `${kfmt(l.guide[0])}–${kfmt(l.guide[1])}` : fmt(l.asking);
    const notes = [];
    if (game.reports.has(l.id)) notes.push(`B&P ✓ val ~${kfmt(l.trueValue)}${l.repairCost >= 20000 ? ' ⚠repairs' : ''}`);
    if (game.reviews.has(l.id)) notes.push(game.reviewMissed.has(l.id) ? 'reviewed “✓”' : (l.specialCondition ? 'contract ⚠' : 'contract ✓'));
    if (l.ownersCorp) notes.push(game.ocRead.has(l.id) ? 'OC read ⚠levy' : 'OC unread');
    if (l.isNew) notes.push('NEW·FHOG');
    for (const n of Object.values(game.agentNotes[l.id] ?? {})) notes.push(`🗣 ${n}`);
    return `<tr${sold && sold !== 'you' ? ' style="opacity:0.45"' : ''}>
      <td><b>${l.address}</b><br><span style="font-size:11.5px;color:#9fb0c8">${l.beds}bd ${l.baths}ba · ${l.land}m²</span></td>
      <td>${status}</td><td>${price}</td>
      <td style="font-size:12px">${notes.join('<br>') || '<span style="color:#8b98ab">no research yet</span>'}</td></tr>`;
  }).join('');
  $('summary-body').innerHTML = `<table class="costs" style="font-size:13px">
    <tr style="color:#9fb0c8;font-size:11px;text-transform:uppercase"><td>Home</td><td>Status</td><td>Price</td><td>Your research</td></tr>
    ${rows}</table>`;
  show($('summary-panel'));
}

$('summary-close').addEventListener('click', toggleSummary);
document.addEventListener('keydown', (e) => {
  if (e.code === 'KeyM') toggleSummary();
});

// ---------- interaction ----------

const raycaster = new THREE.Raycaster();

function nearestListing() {
  let best = null, bestD = 16;
  for (const l of listings) {
    if (game.soldTo[l.id]) continue;
    const d = Math.hypot(player.pos.x - houses[l.id].centre.x, player.pos.z - houses[l.id].centre.z);
    if (d < bestD) { best = l; bestD = d; }
  }
  return best;
}

function nearestAgent() {
  for (const id in openHomes) {
    const a = openHomes[id].agent;
    if (Math.hypot(player.pos.x - a.position.x, player.pos.z - a.position.z) < 3.4) return byId[id];
  }
  return null;
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'KeyE' || game.phase !== 'explore') return;
  if (!noOverlaysOpen()) return;
  const agent = nearestAgent();
  if (agent) return openChat(agent, false);
  const l = nearestListing();
  if (l) openPanel(l.id);
});

renderer.domElement.addEventListener('click', () => {
  if (game.phase === 'explore' || game.phase === 'settled') {
    if (!noOverlaysOpen()) return;
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
  updateOpenHomes(dt);
  updateArms(dt);

  if (game.rateRisePending && game.phase === 'explore' && noOverlaysOpen()) fireRateRise();

  const prompt = $('prompt');
  if (game.phase === 'explore' && noOverlaysOpen()) {
    const agent = nearestAgent();
    const l = agent ?? nearestListing();
    if (agent) {
      prompt.innerHTML = `<b>E</b> · chat with Ray, the agent — ${agent.address}`;
      show(prompt);
    } else if (l) {
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
    solicitor: game.solicitor.id, schemes: { ...game.schemes },
    max: game.preApproval ? playerMax() : 0,
    soldTo: { ...game.soldTo }, ownedId: game.ownedId,
    reports: [...game.reports], reviews: [...game.reviews],
    reviewMissed: [...game.reviewMissed], ocRead: [...game.ocRead],
    pos: { x: +player.pos.x.toFixed(1), z: +player.pos.z.toFixed(1) },
    auction: game.auction ? {
      currentBid: game.auction.currentBid, leader: game.auction.leader,
      state: game.auction.state, done: game.auction.done,
      reserve: game.auction.listing.reserve,
      rivals: game.auction.rivals.map((r) => ({ name: r.name, limit: r.limit })),
    } : null,
  }),
  listings: () => listings.map((l) => ({
    id: l.id, saleType: l.saleType, isNew: !!l.isNew, guide: l.guide, asking: l.asking ?? null,
    trueValue: l.trueValue, reserve: l.reserve, vendorMin: l.vendorMin ?? null,
    interest: l.interest ?? null,
    ownersCorp: l.ownersCorp ?? null, sold: game.soldTo[l.id] ?? null,
  })),
  chat: (id, phone = false) => openChat(byId[id], phone),
  ask: (qid) => {
    if (!chatListing) return false;
    askAgent(chatListing, chatQuestions(chatListing).find((q) => q.id === qid) ?? { id: qid, label: qid });
    return true;
  },
  closeChat: () => closeChat(),
  preapprove: () => applyForPreApproval(),
  setIncome: (you, partner = null) => {
    $('income-you').value = you;
    const chips = document.querySelectorAll('#partner-row .choice');
    if (partner != null) { chips[1].click(); $('income-partner').value = partner; }
    else chips[0].click();
  },
  start: (diff, fhb) => {
    if (diff) document.querySelector(`#difficulty-row .choice[data-diff="${diff}"]`)?.click();
    if (fhb !== undefined) $('fhb-check').checked = fhb;
    if (!game.preApproval) applyForPreApproval();
    startGame();
  },
  selectChip: (rowId, idx) => $(rowId)?.querySelectorAll('.choice')[idx]?.click(),
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
  forceRateRise: () => fireRateRise(),
  epilogue: () => runEpilogue(),
  toggleSummary: () => toggleSummary(),
  save: () => saveGame(),
  clearSave: () => clearSave(),
  openHomes: () => Object.fromEntries(Object.entries(openHomes).map(([id, oh]) => [id, oh.buyers.length])),
  frame: (dt = 0.016) => {
    player.update(dt);
    game.auction?.update(dt);
    updateOpenHomes(dt);
    updateArms(dt);
    if (game.rateRisePending && game.phase === 'explore' && noOverlaysOpen()) fireRateRise();
    renderer.render(scene, camera);
  },
  _scene: scene, _houses: houses, _player: player, _renderer: renderer, _camera: camera,
  _raw: game, _solids: solids, _THREE: THREE,
};
