// Auction state machine. Driven by update(dt) from the main loop; emits events
// via onEvent(type, data). Types: log, bid, call, onMarket, vendorBid, sold, passedIn.

const RIVAL_NAMES = [
  'Young couple', 'Investor in a vest', "Buyer's advocate", 'Bloke on the phone',
  'Downsizer duo', 'Developer in RM Williams',
];

const round1k = (n) => Math.round(n / 1000) * 1000;

export class Auction {
  constructor(listing, { playerMax, heat, onEvent }) {
    this.listing = listing;
    this.playerMax = playerMax;
    this.onEvent = onEvent;
    this.t = 0;
    this.state = 'intro';
    this.currentBid = 0;
    this.leader = null;          // 'you' | rival name | 'vendor'
    this.lastRealBidder = null;  // excludes vendor bid
    this.lastBidAt = 0;
    this.openAsk = round1k(listing.guide[0] * 0.85);
    this.vendorBidUsed = false;
    this.onMarket = false;
    this.callsAnnounced = 0;
    this.done = false;

    // rival bidders — hidden limits clustered around true value, scaled by market heat
    const heatFactor = { cooling: 0.94, balanced: 1.0, hot: 1.07 }[heat];
    const baseCount = { cooling: 1, balanced: 2, hot: 3 }[heat];
    const extra = listing.id === 'mcmansion' || listing.id === 'townhouse' ? 1 : 0;
    const count = Math.min(4, baseCount + extra + (Math.random() < 0.5 ? 1 : 0));
    const names = [...RIVAL_NAMES].sort(() => Math.random() - 0.5);
    this.rivals = Array.from({ length: count }, (_, i) => ({
      name: names[i],
      limit: round1k(listing.trueValue * heatFactor * (0.86 + Math.random() * 0.22)),
      aggression: 0.4 + Math.random() * 0.6,
      nextAt: 0,
    }));
  }

  emit(type, data = {}) { this.onEvent(type, data); }
  log(msg, cls = 'system') { this.emit('log', { msg, cls }); }

  start() {
    this.log(`Ladies and gentlemen, welcome to ${this.listing.address}. A magnificent opportunity — all the paperwork's in order, and we're selling today!`, 'auctioneer');
    this.log(`${this.rivals.length} registered bidder${this.rivals.length === 1 ? '' : 's'} beside you. Auctioneer seeks an opening bid.`, 'system');
  }

  scheduleRivals() {
    for (const r of this.rivals) {
      r.nextAt = this.t + 1.2 + Math.random() * 3.2 * (1.4 - r.aggression);
    }
  }

  rivalIncrement(r) {
    const gap = r.limit - this.currentBid;
    if (gap > 60000) return Math.random() < 0.4 ? 25000 : 10000;
    if (gap > 25000) return Math.random() < 0.5 ? 10000 : 5000;
    if (gap > 8000) return 5000;
    return 1000;
  }

  placeBid(amount, who, isVendor = false) {
    this.currentBid = amount;
    this.leader = who;
    if (!isVendor) { this.lastRealBidder = who; this.lastRealBid = amount; }
    this.lastBidAt = this.t;
    this.callsAnnounced = 0;
    this.scheduleRivals();
    this.emit('bid', { amount, who });
    if (!this.onMarket && this.currentBid >= this.listing.reserve) {
      this.onMarket = true;
      this.log("We're ON THE MARKET, ladies and gentlemen — this property will be sold!", 'auctioneer');
      this.emit('onMarket', {});
    }
  }

  playerBid(increment) {
    if (this.done || this.state === 'intro') return { ok: false, reason: 'Not yet.' };
    if (this.leader === 'you') return { ok: false, reason: "It's with you already." };
    const amount = this.currentBid === 0 ? this.openAsk : this.currentBid + increment;
    if (amount > this.playerMax) {
      return { ok: false, reason: `The bank won't stretch past ${this.playerMax.toLocaleString()}.` };
    }
    this.placeBid(amount, 'you');
    this.log(`You bid $${amount.toLocaleString()}.`, 'you');
    this.log(Math.random() < 0.5 ? "It's with you now." : 'The bid is yours — well placed.', 'auctioneer');
    return { ok: true, amount };
  }

  resolve() {
    this.done = true;
    this.state = 'ended';
    if (this.currentBid >= this.listing.reserve && this.leader && this.leader !== 'vendor') {
      this.log(`SOLD! For $${this.currentBid.toLocaleString()} — congratulations!`, 'auctioneer');
      this.emit('sold', { winner: this.leader, price: this.currentBid });
    } else {
      this.log('The property is passed in.', 'auctioneer');
      this.emit('passedIn', {
        highestRealBidder: this.lastRealBidder,
        amount: this.lastRealBid ?? 0,
      });
    }
  }

  update(dt) {
    if (this.done) return;
    this.t += dt;

    if (this.state === 'intro') {
      if (this.t > 2.5) {
        this.state = 'open';
        this.lastBidAt = this.t;
        this.log(`Who'll start me at $${this.openAsk.toLocaleString()}?`, 'auctioneer');
        this.scheduleRivals();
      }
      return;
    }

    // rival bids
    for (const r of this.rivals) {
      if (this.leader === r.name || this.t < r.nextAt) continue;
      const amount = this.currentBid === 0
        ? this.openAsk
        : this.currentBid + this.rivalIncrement(r);
      if (amount <= r.limit) {
        this.placeBid(amount, r.name);
        this.log(`${r.name} bids $${amount.toLocaleString()}.`, 'rival');
      } else {
        r.nextAt = Infinity; // they're out
      }
    }

    // auctioneer calls on idle
    const idle = this.t - this.lastBidAt;
    const noBidsYet = this.currentBid === 0;
    const callDelays = noBidsYet ? [8, 13, 18] : [6, 10, 14];

    if (this.callsAnnounced === 0 && idle > callDelays[0]) {
      this.callsAnnounced = 1;
      this.log(noBidsYet ? "Don't be shy — she won't bite." : `Going once at $${this.currentBid.toLocaleString()}…`, 'auctioneer');
      this.emit('call', { stage: 1 });
    } else if (this.callsAnnounced === 1 && idle > callDelays[1]) {
      this.callsAnnounced = 2;
      // vendor bid: protect the reserve, once, only if there's been real interest
      if (!this.vendorBidUsed && !noBidsYet && this.currentBid < this.listing.reserve) {
        this.vendorBidUsed = true;
        const vb = Math.min(round1k(this.listing.reserve * 0.97), this.currentBid + 10000);
        this.placeBid(vb, 'vendor', true);
        this.log(`I'll exercise a vendor bid — $${vb.toLocaleString()}.`, 'auctioneer');
        this.emit('vendorBid', { amount: vb });
        return;
      }
      this.log(noBidsYet ? 'Last chance to open, ladies and gents…' : 'Going twice… are we all done?', 'auctioneer');
      this.emit('call', { stage: 2 });
    } else if (this.callsAnnounced === 2 && idle > callDelays[2]) {
      this.callsAnnounced = 3;
      this.log(noBidsYet ? 'No bids today.' : 'Third and final call…', 'auctioneer');
      this.emit('call', { stage: 3 });
    } else if (this.callsAnnounced === 3 && idle > callDelays[2] + 2.5) {
      this.resolve();
    }
  }
}
