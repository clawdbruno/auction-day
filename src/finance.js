// Victorian-flavoured property maths. Rates and caps are close to real (c. 2025)
// but simplified — this is a game, not financial or legal advice.

export const REPORT_COST = 550;           // building & pest inspection
export const OC_RECORDS_COST = 300;       // owners corporation certificate & records
export const DEPOSIT_PCT = 0.10;          // payable on signing
export const COOLING_OFF_PENALTY = 0.002; // 0.2% to walk during cooling-off (VIC private sale)
export const FHOG_AMOUNT = 10000;         // First Home Owner Grant — NEW homes ≤ $750k (VIC)
export const FHOG_PRICE_CAP = 750000;
export const FHBG_PRICE_CAP = 800000;     // First Home Guarantee property cap (VIC metro)
export const FHBG_INCOME_CAP = { single: 125000, couple: 200000 };
export const SETTLEMENT_ADJUSTMENTS = 620; // prorated council rates + water at settlement

const fmtAUD = new Intl.NumberFormat('en-AU', {
  style: 'currency', currency: 'AUD', maximumFractionDigits: 0,
});
export const fmt = (n) => fmtAUD.format(Math.round(n));
export const round1k = (n) => Math.round(n / 1000) * 1000;

// ---------- getting the loan ----------

export const LENDERS = {
  bank: {
    name: 'Big Four bank',
    rate: 0.0609,
    factor: 5.15,
    approvalWeeks: 3,
    blurb: 'Walk into the branch you’ve banked with since you were 8. Conservative servicing, one product shelf, ~3 weeks to approve — and they only mention government schemes if you ask.',
  },
  broker: {
    name: 'Mortgage broker',
    rate: 0.0589,
    factor: 5.65,
    approvalWeeks: 1,
    blurb: 'Compares ~30 lenders, paid commission by whoever wins. Sharper rate, stretchier servicing, ~1 week — and they’ll bring up every grant and guarantee you qualify for.',
  },
};

export const INCOMES = [
  { label: 'Solo — teacher', value: 88000, household: 'single' },
  { label: 'Couple — teacher + sparky', value: 152000, household: 'couple' },
  { label: 'Couple — two professionals', value: 205000, household: 'couple' },
];
export const EXPENSES = [
  { label: 'Frugal', note: 'rice, beans, one streaming service', factor: 1.0 },
  { label: 'Average', note: 'the HEM benchmark shrugs', factor: 0.955 },
  { label: 'Lifestyle', note: '47 Uber Eats orders on your statements', factor: 0.90 },
];
export const CARD_LIMITS = [
  { label: 'No credit card', value: 0 },
  { label: '$6k limit', value: 6000 },
  { label: '$20k limit', value: 20000 },
];

export const SOLICITORS = [
  {
    id: 'budget', name: 'ClickConvey — online conveyancer',
    review: 190, conveyancing: 780, missChance: 0.5, delayChance: 0.4,
    blurb: '$780 fixed fee, chatbot first, humans eventually. Contract "reviews" are a checklist. Settlements sometimes… slip.',
  },
  {
    id: 'local', name: 'Wattlebrook Legal — local solicitor',
    review: 350, conveyancing: 1500, missChance: 0, delayChance: 0.08,
    blurb: 'Knows every agent in the suburb, picks up the phone, reads every page of every Section 32.',
  },
  {
    id: 'boutique', name: 'Harbour & Wren — property law firm',
    review: 520, conveyancing: 2400, missChance: 0, delayChance: 0,
    blurb: 'Partner review within 24 hours. Negotiates special conditions before you sign. Has never missed a settlement.',
  },
];

// Lenders assess ~3.8x your card LIMIT (not balance) against you; HECS trims
// capacity like another expense; everything is stress-tested ~3% above the
// actual rate (the APRA buffer). Approximate, directionally honest.
export function borrowingPower({ lender, income, expenseFactor, hecs, cardLimit }) {
  const L = LENDERS[lender];
  let power = income * L.factor * expenseFactor;
  if (hecs) power *= 0.93;
  power -= cardLimit * 3.8;
  return Math.max(0, round1k(power));
}

export function monthlyRepayment(loan, rate) {
  const r = rate / 12, n = 360; // 30 years P&I
  return loan * r / (1 - Math.pow(1 + r, -n));
}

export const LOAN_TYPES = [
  { id: 'variable', label: 'Variable + offset', rateDelta: 0, note: 'your savings sit in the offset trimming interest' },
  { id: 'fixed', label: '2yr fixed', rateDelta: -0.002, note: 'cheaper today; no offset, break fees if life changes' },
  { id: 'split', label: '50/50 split', rateDelta: -0.001, note: 'a bet each way — half fixed, half variable' },
];

// ---------- taxes, insurance, schemes ----------

// General VIC transfer duty brackets.
function baseDuty(price) {
  if (price <= 25000) return price * 0.014;
  if (price <= 130000) return 350 + (price - 25000) * 0.024;
  if (price <= 960000) return 2870 + (price - 130000) * 0.06;
  if (price <= 2000000) return price * 0.055;
  return 110000 + (price - 2000000) * 0.065;
}

// First home buyer: exempt to $600k, concession phasing out to $750k (approximated linearly).
export function stampDuty(price, firstHomeBuyer) {
  const duty = baseDuty(price);
  if (!firstHomeBuyer) return duty;
  if (price <= 600000) return 0;
  if (price <= 750000) return duty * ((price - 600000) / 150000);
  return duty;
}

// Rough LMI premium by LVR band, as a % of the loan.
export function lmi(loan, price) {
  if (loan <= 0) return 0;
  const lvr = loan / price;
  if (lvr <= 0.8) return 0;
  if (lvr <= 0.85) return loan * 0.010;
  if (lvr <= 0.90) return loan * 0.018;
  return loan * 0.030;
}

// Full cost breakdown for buying at `price`. The bank lends against the LESSER of
// price and its valuation (valCap). Scheme flags:
//   fhbg — First Home Guarantee: LMI waived (govt guarantees above 80% LVR), price ≤ cap
//   fhog — First Home Owner Grant: $10k cash toward a NEW home ≤ $750k
export function settlement(price, savings, preApproval, firstHomeBuyer, valCap = null, opts = {}) {
  const conveyancing = opts.conveyancing ?? 1500;
  const fhbg = !!opts.fhbg && price <= FHBG_PRICE_CAP;
  const fhog = !!opts.fhog && price <= FHOG_PRICE_CAP;
  const secured = Math.min(price, valCap ?? price);
  const loan = Math.min(preApproval, Math.floor(secured * 0.95));
  const duty = stampDuty(price, firstHomeBuyer);
  const insurance = (fhbg || opts.guarantor) ? 0 : lmi(loan, secured);
  const grant = fhog ? FHOG_AMOUNT : 0;
  const cashNeeded = price - loan + duty + insurance + conveyancing + SETTLEMENT_ADJUSTMENTS - grant;
  return {
    price, loan, duty, lmi: insurance, grant, fhbg, fhog,
    conveyancing,
    adjustments: SETTLEMENT_ADJUSTMENTS,
    deposit: price - loan,
    cashNeeded,
    cashLeft: savings - cashNeeded,
    lvr: loan / price,
    affordable: cashNeeded <= savings && price - loan >= price * 0.05,
  };
}

// Highest price the player can settle on. With the First Home Guarantee available,
// affordability is the better of the two regimes (guarantee below its cap, LMI above).
export function maxPurchase(savings, preApproval, firstHomeBuyer, opts = {}) {
  const ok = (p) =>
    settlement(p, savings, preApproval, firstHomeBuyer, null, { ...opts, fhbg: false, fhog: false }).affordable ||
    (opts.fhbg && p <= FHBG_PRICE_CAP &&
      settlement(p, savings, preApproval, firstHomeBuyer, null, { ...opts, fhog: false }).affordable);
  let lo = 0, hi = 3000000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo / 1000) * 1000;
}
