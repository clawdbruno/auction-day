// Victorian-flavoured property maths. Rates are close to real but simplified —
// this is a game, not conveyancing advice.

export const CONVEYANCING = 1800;      // conveyancer/solicitor to settle the purchase
export const REPORT_COST = 550;        // building & pest inspection
export const REVIEW_COST = 350;        // solicitor pre-purchase contract & Section 32 review
export const DEPOSIT_PCT = 0.10;       // payable on signing
export const COOLING_OFF_PENALTY = 0.002; // 0.2% to walk away during cooling-off (VIC, private sale)

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
    blurb: 'Walk into the branch you’ve banked with since you were 8. Conservative servicing, one product shelf, free branded stress ball.',
  },
  broker: {
    name: 'Mortgage broker',
    rate: 0.0589,
    factor: 5.65,
    blurb: 'Compares ~30 lenders and is paid commission by whoever wins. Sharper rate, stretchier servicing — and they chase the paperwork for you.',
  },
};

export const INCOMES = [
  { label: 'Solo — teacher', value: 88000 },
  { label: 'Couple — teacher + sparky', value: 152000 },
  { label: 'Couple — two professionals', value: 198000 },
];
export const EXPENSES = [
  { label: 'Frugal', note: 'rice, beans, one streaming service', factor: 1.0 },
  { label: 'Average', note: 'the HEM benchmark shrugs', factor: 0.955 },
  { label: 'Lifestyle', note: 'brunch is non-negotiable', factor: 0.90 },
];
export const CARD_LIMITS = [
  { label: 'No credit card', value: 0 },
  { label: '$6k limit', value: 6000 },
  { label: '$20k limit', value: 20000 },
];

// Lenders assess ~3.8x your card LIMIT (not balance) against you; HECS trims
// capacity roughly like another expense. All approximate, directionally honest.
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

// ---------- taxes & insurance ----------

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
// price and its valuation (valCap) — the gap between the two is yours to find.
export function settlement(price, savings, preApproval, firstHomeBuyer, valCap = null) {
  const secured = Math.min(price, valCap ?? price);
  const loan = Math.min(preApproval, Math.floor(secured * 0.95));
  const duty = stampDuty(price, firstHomeBuyer);
  const insurance = lmi(loan, secured);
  const cashNeeded = price - loan + duty + insurance + CONVEYANCING;
  return {
    price, loan, duty, lmi: insurance,
    conveyancing: CONVEYANCING,
    deposit: price - loan,
    cashNeeded,
    cashLeft: savings - cashNeeded,
    lvr: loan / price,
    affordable: cashNeeded <= savings && price - loan >= price * 0.05,
  };
}

// Highest price the player can settle on, given cash + pre-approval (assumes the
// bank's valuation matches the price — at auction you wear that risk).
export function maxPurchase(savings, preApproval, firstHomeBuyer) {
  let lo = 0, hi = 3000000;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (settlement(mid, savings, preApproval, firstHomeBuyer).affordable) lo = mid;
    else hi = mid;
  }
  return Math.floor(lo / 1000) * 1000;
}
