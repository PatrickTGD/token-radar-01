// Launch Radar model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The idea: a protocol that records no token has no market price, so we price it the way the
// market prices its already-launched peers. Protocols whose token trades give, per category, a
// market-cap-to-TVL multiple. A pre-token protocol's implied value is its own TVL times its
// category's multiple, nudged by three facts from its own record: how fast its TVL moved over
// the last seven days, how many years it has run with no token, and on how many chains it runs.
//
//   implied = TVL x category_multiple x growth_factor x maturity_factor x breadth_factor
//
// Everything is derived from the snapshot's figures. No protocol is named in this file: the same
// code scores every row, and a category with too few traded peers falls back toward the market
// as a whole instead of trusting a thin sample.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's knobs, stated here once and shown on the dashboard. */
export const MODEL = {
  /** The board carries every qualifying protocol at or above this TVL. */
  board_min_tvl_usd: 10_000_000,
  /** Comp ratios are winsorised into this band before any median is taken. */
  ratio_floor: 0.01,
  ratio_cap: 10,
  /** A category needs at least this many traded peers before its own median is used at all. */
  min_comps: 3,
  /** Sparse category medians are shrunk toward the global median with this weight. */
  shrink_weight: 4,
  /** No category multiple, however strong its peers, leaves this band. */
  multiple_floor: 0.02,
  multiple_cap: 5,
  /** Seven-day growth is clamped to this band before it becomes a factor. */
  growth_floor_pct: -50,
  growth_cap_pct: 100,
  growth_weight: 0.5,
  /** Each year a protocol has run tokenless adds this much, up to the year cap. */
  maturity_per_year: 0.06,
  maturity_year_cap: 6,
  /** Each extra chain adds this much breadth, up to the chain cap. */
  breadth_per_chain: 0.02,
  breadth_chain_cap: 5,
};

/** Categories that are wrapped, staked, bridged or exchange products of a token that trades. */
const EXCLUDED_CATEGORIES: ReadonlySet<string> = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

/** A whole word wrapped, staked or staking anywhere in the name marks a derivative product. */
const DERIVATIVE_WORD = /\b(wrapped|staked|staking)\b/i;

/** A name ending in a version marker is a later pool of a protocol that already exists. */
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Names that open with an exchange's name are that exchange's own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Whether the protocol's record carries no token: both token fields are empty. */
export function recordsNoToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

/** Why a tokenless protocol is still not a launch candidate, or null when it qualifies. */
export function exclusionReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return 'category';
  if (DERIVATIVE_WORD.test(p.name)) return 'derivative-name';
  if (VERSION_SUFFIX.test(p.name)) return 'versioned-name';
  for (const prefix of EXCHANGE_PREFIXES) if (p.name.startsWith(prefix)) return 'exchange-name';
  return null;
}

/** Whether the protocol belongs on the board: tokenless, not excluded, at or above the TVL line. */
export function qualifies(p: SnapshotProtocol): boolean {
  return recordsNoToken(p) && exclusionReason(p) === null && p.tvl_usd >= MODEL.board_min_tvl_usd;
}

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** What the traded half of the snapshot says: one winsorised mcap/TVL median per category, and one overall. */
export interface CompTable {
  global_multiple: number;
  by_category: Map<string, { comps: number; median: number }>;
}

/**
 * The comparison set: every protocol whose token trades and whose record carries both a market
 * cap and a TVL. Each one's mcap/TVL ratio is winsorised so a single micro-cap cannot set a
 * whole category's price.
 */
export function compTable(snapshot: Snapshot): CompTable {
  const all: number[] = [];
  const byCategory = new Map<string, number[]>();
  for (const p of snapshot.protocols) {
    if (recordsNoToken(p)) continue;
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = clamp(p.mcap_usd / p.tvl_usd, MODEL.ratio_floor, MODEL.ratio_cap);
    all.push(ratio);
    if (p.category !== null) {
      const list = byCategory.get(p.category);
      if (list === undefined) byCategory.set(p.category, [ratio]);
      else list.push(ratio);
    }
  }
  const by_category = new Map<string, { comps: number; median: number }>();
  for (const [category, ratios] of byCategory) by_category.set(category, { comps: ratios.length, median: median(ratios) });
  return { global_multiple: median(all), by_category };
}

/** The multiple one category prices at: its own median, shrunk toward the market's, or the market's alone. */
export function categoryMultiple(category: string | null, comps: CompTable): { multiple: number; comps: number } {
  const global = comps.global_multiple;
  if (category === null) return { multiple: round4(clamp(global, MODEL.multiple_floor, MODEL.multiple_cap)), comps: 0 };
  const entry = comps.by_category.get(category);
  if (entry === undefined || entry.comps < MODEL.min_comps) {
    return { multiple: round4(clamp(global, MODEL.multiple_floor, MODEL.multiple_cap)), comps: entry?.comps ?? 0 };
  }
  const shrunk = (entry.comps * entry.median + MODEL.shrink_weight * global) / (entry.comps + MODEL.shrink_weight);
  return { multiple: round4(clamp(shrunk, MODEL.multiple_floor, MODEL.multiple_cap)), comps: entry.comps };
}

const DAY_MS = 86_400_000;

/** Whole days from a listing date to the snapshot's as_of date, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The model's reading of one protocol: every factor, so the dashboard can show its working. */
export interface ScoreBreakdown {
  category_multiple: number;
  category_comps: number;
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  age_years: number | null;
  implied_value_usd: number;
}

/** Score one qualifying protocol. The factors are rounded before use, so the shown working multiplies out. */
export function score(p: SnapshotProtocol, asOf: string, comps: CompTable): ScoreBreakdown {
  const { multiple, comps: n } = categoryMultiple(p.category, comps);
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const growth = round4(1 + (growthPct / 100) * MODEL.growth_weight);
  const days = ageDays(asOf, p.listed_at);
  const ageYears = days === null ? null : days / 365.25;
  const maturity = round4(1 + MODEL.maturity_per_year * Math.min(ageYears ?? 0, MODEL.maturity_year_cap));
  const breadth = round4(1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_chain_cap));
  const raw = p.tvl_usd * multiple * growth * maturity * breadth;
  const implied = Math.min(100_000_000_000_000, Math.max(1, Math.round(raw)));
  return {
    category_multiple: multiple,
    category_comps: n,
    growth_factor: growth,
    maturity_factor: maturity,
    breadth_factor: breadth,
    age_years: ageYears === null ? null : Math.round(ageYears * 100) / 100,
    implied_value_usd: implied,
  };
}

// ------------------------------------------------------------------ farm plans

/** The working figures a farm plan is built from: the protocol's own chains and size. */
interface FarmContext {
  name: string;
  chain: string;
  chain2: string;
  core: number;
  small: number;
  gas: string;
  weeks: number;
}

/** Position sizes from the protocol's TVL tier: bigger protocols get bigger suggested positions. */
function farmContext(p: SnapshotProtocol, ageYears: number | null): FarmContext {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const gas = chain === 'Ethereum' ? 'about $18 in gas' : chain === 'Solana' ? 'under $1 in network fees' : chain === 'Bitcoin' ? 'about $6 in network fees' : 'about $2 in gas';
  const tier = p.tvl_usd >= 1_000_000_000 ? { core: 500, small: 200 } : p.tvl_usd >= 250_000_000 ? { core: 300, small: 120 } : p.tvl_usd >= 50_000_000 ? { core: 200, small: 80 } : { core: 100, small: 40 };
  const weeks = ageYears === null ? 6 : ageYears >= 3 ? 4 : ageYears >= 1 ? 6 : 8;
  return { name: p.name, chain, chain2, core: tier.core, small: tier.small, gas, weeks };
}

type Playbook = (c: FarmContext) => string[];

const lendingPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet funded with $${c.core} of USDC plus gas money; a dedicated wallet keeps the farm separate from your main funds. Cost: ${c.gas} to fund and approve. Time: 10 minutes.`,
  `Supply the full $${c.core} of USDC into ${c.name}'s main lending market on ${c.chain} and leave it supplied; a standing supplied balance is the activity a lending launch can measure. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Borrow $${c.small} of USDC against the supply, hold it for a day, then repay in full with interest; one clean borrow-and-repay round shows the wallet used both sides of the market. Cost: roughly $1-3 of interest plus ${c.gas}. Time: 20 minutes spread over two days.`,
  `Repeat one small supply, borrow or repay action every week for ${c.weeks} weeks, so the wallet builds a history instead of a single visit. Cost: ${c.gas} per action. Time: 10 minutes a week.`,
  `Watch ${c.name}'s official announcements and its in-app rewards page for a points program or a snapshot notice; act only through links inside the app itself, never a search result. Cost: nothing to watch, and never pay anyone to claim for you. Time: 5 minutes a month.`,
];

const dexPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding $${c.core} of USDC plus gas money, kept apart from your main funds. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Swap $${c.small} of USDC into the pool's main asset on ${c.name}, then swap half of it back an hour later; two settled swaps put the wallet in the protocol's real trader set. Cost: about $1-2 of swap fees plus ${c.gas}. Time: 15 minutes.`,
  `Provide $${c.core} of liquidity, split evenly between USDC and the paired asset, in ${c.name}'s busiest pool on ${c.chain}, and keep the position open. Cost: $${c.core} of capital plus ${c.gas}. Time: 20 minutes.`,
  `Adjust the position once a week for ${c.weeks} weeks: add or remove a small slice and claim the fees the pool page shows. Cost: ${c.gas} per touch. Time: 10 minutes a week.`,
  `Follow ${c.name}'s official announcements for a points season or a snapshot post, and check the app's rewards page monthly; use only links the app itself publishes. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const yieldPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding $${c.core} of USDC plus gas money, separate from your main funds. Cost: ${c.gas} to fund and approve. Time: 10 minutes.`,
  `Deposit the $${c.core} into ${c.name}'s main vault on ${c.chain} and keep the vault shares in the same wallet; share balances held over time are what a yield launch can count. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `After the first week, harvest whatever the vault has earned and compound it straight back into the same vault, registering a second, different on-chain action. Cost: ${c.gas}. Time: 10 minutes.`,
  `Top the vault up by $${c.small} every week for ${c.weeks} weeks rather than depositing once and going quiet. Cost: $${c.small} a week plus ${c.gas}. Time: 10 minutes a week.`,
  `Check ${c.name}'s official channels monthly for a points page or a snapshot announcement, and claim only through the link inside the app. Cost: nothing to watch; never pay a third party to claim. Time: 5 minutes a month.`,
];

const derivativesPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet and fund it with $${c.core} of USDC plus gas money. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Deposit the $${c.core} as margin on ${c.name} and leave it in the account; margin that stays is the first signal a derivatives launch can see. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Open one small position of about $${c.small} notional at low leverage, hold it at least a day, then close it in full; one completed trade cycle counts for more than idle margin. Cost: roughly $2-4 of trading fees plus ${c.gas}. Time: 20 minutes spread over two days.`,
  `Trade one small position a week for ${c.weeks} weeks to build a steady volume history without chasing size. Cost: about $2-4 of fees a week plus ${c.gas}. Time: 15 minutes a week.`,
  `Watch ${c.name}'s official announcements for a trading-points season; if one starts, your existing weekly rhythm already qualifies, so change nothing and claim only in the app. Cost: nothing extra. Time: 5 minutes a month to check.`,
];

const cdpPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding collateral worth about $${c.core} plus gas money. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Deposit the collateral into ${c.name} on ${c.chain} and mint roughly half its value in the protocol's stablecoin; keep both the position and the minted coins in the wallet. Cost: $${c.core} of collateral plus ${c.gas}. Time: 20 minutes.`,
  `Use a small part of the minted stablecoin inside the same ecosystem — a swap or a deposit in a linked app — so the mint is not the wallet's only action. Cost: ${c.gas}. Time: 10 minutes.`,
  `Every week for ${c.weeks} weeks, top up the collateral or repay a slice of the debt, keeping the position active and comfortably above its liquidation line. Cost: ${c.gas} per touch. Time: 10 minutes a week.`,
  `Follow ${c.name}'s official channels for a points program or governance announcement, and claim anything only through the app's own link. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const curatorPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding $${c.core} of USDC plus gas money. Cost: ${c.gas} to fund and approve. Time: 10 minutes.`,
  `Deposit the $${c.core} into the ${c.name} vault on ${c.chain} with the most deposits, and keep the vault shares; curated vaults are where this protocol's users actually sit. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Place a second, smaller deposit of $${c.small} into another ${c.name} vault on ${c.chain2}, so the wallet appears in more than one of the curator's markets. Cost: $${c.small} plus ${c.gas}. Time: 15 minutes.`,
  `When rewards show on the vault page, claim them and redeposit into the same vault instead of cashing out. Cost: ${c.gas} per claim. Time: 10 minutes, as needed.`,
  `Repeat a small deposit or claim every week for ${c.weeks} weeks, and watch ${c.name}'s official channels for a snapshot or points announcement. Cost: ${c.gas} a week. Time: 10 minutes a week.`,
];

const rwaPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet and complete any in-app eligibility check before funding it with $${c.core} of USDC. Cost: ${c.gas} to fund. Time: 20 minutes including the check.`,
  `Mint $${c.core} of ${c.name}'s yield-bearing asset on ${c.chain} and hold it in the same wallet; a held mint is the position this kind of launch can reward. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Make one second, smaller mint of $${c.small} a week later, so the wallet shows repeat use rather than a single transaction. Cost: $${c.small} plus ${c.gas}. Time: 10 minutes.`,
  `Hold the position for at least ${c.weeks} weeks: real-world-asset launches reward duration, and redemptions can take days, so never farm this with money you may need back quickly. Cost: the $${c.core} stays invested. Time: ${c.weeks} weeks of holding.`,
  `Check ${c.name}'s official channels monthly for a holder snapshot or a points page, and act only on links inside the app. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const basisPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding $${c.core} of USDC plus gas money. Cost: ${c.gas} to fund and approve. Time: 10 minutes.`,
  `Deposit the $${c.core} into ${c.name}'s basis vault on ${c.chain} and keep the shares; the vault runs the hedge, your job is a balance that stays. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Add a second tranche of $${c.small} a week later instead of depositing everything on day one. Cost: $${c.small} plus ${c.gas}. Time: 10 minutes.`,
  `Leave the position untouched for ${c.weeks} weeks apart from one claim or top-up a week; basis returns accrue slowly and churn only costs fees. Cost: ${c.gas} a week. Time: 10 minutes a week.`,
  `Watch ${c.name}'s official announcements for a points program tied to vault shares, and claim only through the app itself. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const stakingPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding the chain's native asset worth about $${c.core}, plus gas money. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Stake the full $${c.core} worth through ${c.name} on ${c.chain} and keep the staking receipt in the same wallet; a receipt held over time is the measurable position here. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Put a small part of the receipt, about $${c.small} worth, to work in one connected app that ${c.name} links to, so the position is active rather than parked. Cost: ${c.gas}. Time: 15 minutes.`,
  `Add a small stake every week for ${c.weeks} weeks and claim staking rewards when the app offers them, restaking what you claim. Cost: ${c.gas} a week. Time: 10 minutes a week.`,
  `Follow ${c.name}'s official channels for a points conversion or snapshot announcement; staking launches usually count average balances, which your weekly rhythm already builds. Cost: nothing extra. Time: 5 minutes a month to check.`,
];

const bridgePlan: Playbook = (c) => [
  `Fund a fresh wallet with $${c.core} of USDC on ${c.chain} plus gas money on both chains you will touch. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Bridge the $${c.core} from ${c.chain} to ${c.chain2} through ${c.name} and keep the funds on the far side rather than bridging straight back. Cost: a bridge fee of roughly $1-3 plus ${c.gas}. Time: 15-30 minutes for the transfer to land.`,
  `Use the bridged funds in one app on ${c.chain2} — a swap or a small deposit — so the trip ends in real activity, not a round trip. Cost: ${c.gas}. Time: 10 minutes.`,
  `Bridge a smaller amount, about $${c.small}, across once a week for ${c.weeks} weeks, varying the direction, to build a route history. Cost: roughly $1-3 a trip plus ${c.gas}. Time: 15 minutes a week.`,
  `Watch ${c.name}'s official channels for a points program based on bridge volume or unique routes, and claim only through the app. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const predictionPlan: Playbook = (c) => [
  `Open ${c.name} from a fresh wallet and deposit $${c.core} of USDC on ${c.chain} into your account. Cost: $${c.core} plus ${c.gas}. Time: 15 minutes.`,
  `Place one position of about $${c.small} in a liquid market you genuinely follow, and let it run to settlement instead of trading in and out. Cost: $${c.small} at risk plus about $1 of fees. Time: 10 minutes.`,
  `Take one new position a week for ${c.weeks} weeks, always in markets with real volume, so the account builds a settled track record. Cost: about $${c.small} a week at risk. Time: 10 minutes a week.`,
  `Withdraw nothing until a market you hold settles; a history of settled positions is the activity a prediction launch can count. Cost: nothing. Time: no action, just patience over ${c.weeks} weeks.`,
  `Follow ${c.name}'s official announcements for a loyalty or points program, and claim only through the site itself. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const insurancePlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet, with an asset you actually hold elsewhere in mind to cover. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Buy cover from ${c.name} for about $${c.core} of that asset, choosing the shortest cover period first to learn the flow. Cost: a premium of roughly $2-5 for a small cover, plus ${c.gas}. Time: 15 minutes.`,
  `When the first period ends, renew the cover once at the same size, so the wallet shows two separate policy periods. Cost: a second premium of roughly $2-5. Time: 10 minutes.`,
  `Stake a small amount, about $${c.small}, into ${c.name}'s capital pool if it offers one, and keep it there for ${c.weeks} weeks; underwriters are the other side a cover launch can reward. Cost: $${c.small} plus ${c.gas}. Time: 15 minutes.`,
  `Watch ${c.name}'s official channels for a governance or points announcement, and claim only through the app. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const paymentsPlan: Playbook = (c) => [
  `Open ${c.name} and complete its identity check with your real details; payment products verify people, not wallets, so use your main identity here, not a fresh one. Cost: nothing. Time: 20 minutes including the check.`,
  `Load $${c.small} into ${c.name} from ${c.chain} or a bank transfer and make it your spending balance for the week. Cost: $${c.small} loaded plus ${c.gas}. Time: 10 minutes.`,
  `Make three small real payments or transfers through ${c.name} across the first week — actual usage, not test dust sent to yourself. Cost: under $2 of fees in total. Time: 5 minutes per payment.`,
  `Keep using ${c.name} for one payment a week for ${c.weeks} weeks; payment launches count retained, transacting users. Cost: under $1 of fees a week. Time: 5 minutes a week.`,
  `Watch ${c.name}'s official announcements for a rewards or token program for active users, and join only through the app. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const indexPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding $${c.core} of USDC plus gas money. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Buy $${c.core} of ${c.name}'s main index token on ${c.chain} and hold it in the same wallet; a held index balance is the position here. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Add $${c.small} more every week for ${c.weeks} weeks, building the position gradually instead of in one trade. Cost: $${c.small} a week plus ${c.gas}. Time: 10 minutes a week.`,
  `Vote with the index token if ${c.name} opens a governance vote, or delegate the vote to an active delegate; either registers the wallet as a participant. Cost: ${c.gas}. Time: 10 minutes, when a vote appears.`,
  `Follow ${c.name}'s official channels for a holder snapshot or a fee-sharing announcement, and claim only through the app. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const chainPlan: Playbook = (c) => [
  `Fund a fresh wallet with $${c.core} of USDC plus gas money, ready to move onto ${c.name}'s network. Cost: ${c.gas} to fund. Time: 10 minutes.`,
  `Bridge the $${c.core} onto the chain through ${c.name}'s canonical route and make the wallet's first transactions there: one swap and one small deposit in a listed app. Cost: a bridge fee of roughly $1-3 plus ${c.gas}. Time: 25 minutes.`,
  `Use one new app on the chain each week for ${c.weeks} weeks — a lending market, an exchange, a vault — so the wallet shows breadth, not one contract. Cost: ${c.gas} per app. Time: 15 minutes a week.`,
  `Keep at least $${c.small} of balance on the chain at all times during those ${c.weeks} weeks; chain launches usually count average balances and active days. Cost: the balance stays on the chain. Time: no action beyond the weekly app visit.`,
  `Watch ${c.name}'s official channels for an ecosystem points program or a snapshot date, and claim only through official links. Cost: nothing to watch. Time: 5 minutes a month.`,
];

const defaultPlan: Playbook = (c) => [
  `Open ${c.name} on ${c.chain} from a fresh wallet holding $${c.core} of USDC plus gas money, kept separate from your main funds. Cost: ${c.gas} to fund and approve. Time: 10 minutes.`,
  `Make ${c.name}'s core action with the $${c.core}: deposit it into the main product on ${c.chain} and keep the position open rather than withdrawing after a day. Cost: $${c.core} of capital plus ${c.gas}. Time: 15 minutes.`,
  `Add a second, different action a week later — a further $${c.small} deposit, a vote, or a claim, whichever the app offers — so the wallet is more than a single transaction. Cost: ${c.gas}. Time: 10 minutes.`,
  `Repeat one small action every week for ${c.weeks} weeks; launches count histories, and a steady rhythm beats one large deposit. Cost: ${c.gas} a week. Time: 10 minutes a week.`,
  `Follow ${c.name}'s official announcements and its in-app rewards page for a points program or snapshot notice; act only on links inside the app itself. Cost: nothing to watch, and never pay anyone to claim for you. Time: 5 minutes a month.`,
];

/** The playbook for a category: each line of business gets its own plan, the rest share the default. */
function playbookFor(category: string | null): Playbook {
  switch (category) {
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'Collateral Markets':
      return lendingPlan;
    case 'Dexs':
      return dexPlan;
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Leveraged Farming':
      return yieldPlan;
    case 'Derivatives':
      return derivativesPlan;
    case 'CDP':
    case 'CDP Manager':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Wrapper':
      return cdpPlan;
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Liquidity Manager':
      return curatorPlan;
    case 'RWA':
      return rwaPlan;
    case 'Basis Trading':
      return basisPlan;
    case 'Staking Pool':
    case 'Restaking':
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return stakingPlan;
    case 'Cross Chain Bridge':
      return bridgePlan;
    case 'Prediction Market':
      return predictionPlan;
    case 'Insurance':
      return insurancePlan;
    case 'Payments':
    case 'Crypto Card Issuer':
      return paymentsPlan;
    case 'Indexes':
      return indexPlan;
    case 'Chain':
      return chainPlan;
    default:
      return defaultPlan;
  }
}

/** A protocol's farm plan: five concrete steps built from its category, chains and size. */
export function farmSteps(p: SnapshotProtocol, ageYears: number | null): string[] {
  return playbookFor(p.category)(farmContext(p, ageYears)).map((s) => s.trim());
}

// ------------------------------------------------------------------ the board

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  implied_value_usd: number;
  implied_multiple: number;
  model: ScoreBreakdown;
  farm_steps: string[];
}

/** The full board: every qualifying protocol, ranked by implied value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const comps = compTable(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(qualifies)
    .map((p) => ({ p, s: score(p, snapshot.as_of, comps) }));
  scored.sort(
    (a, b) =>
      b.s.implied_value_usd - a.s.implied_value_usd ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map(({ p, s }, i) => ({
    rank: i + 1,
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    change_7d: p.change_7d,
    listed_at: p.listed_at,
    watchlist: watch.has(p.slug),
    implied_value_usd: s.implied_value_usd,
    implied_multiple: round4(s.implied_value_usd / p.tvl_usd),
    model: s,
    farm_steps: farmSteps(p, s.age_years),
  }));
}

/** Everything the dashboard renders: the board plus the model's own summary. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  global_multiple: number;
  board_size: number;
  watchlist_size: number;
  rows: BoardRow[];
}

/** Build the dashboard's dataset from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const comps = compTable(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    global_multiple: round4(comps.global_multiple),
    board_size: board.length,
    watchlist_size: snapshot.watchlist.length,
    rows: board,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape this model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isFinite(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null when it is in shape. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set<string>();
  for (const r of board) {
    if (slugs.has(r.slug)) return `slug ${r.slug} appears twice`;
    slugs.add(r.slug);
  }
  const known = new Set(snapshot.protocols.map((p) => p.slug));
  for (const r of board) if (!known.has(r.slug)) return `slug ${r.slug} is not in the snapshot`;
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  for (let i = 0; i < board.length; i++) if (board[i]!.rank !== i + 1) return `row ${i} carries rank ${board[i]!.rank}, not ${i + 1}`;
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'every row carries the same implied value: a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} trimmed characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network, the page renders from this alone. */
export function dataScript(radar: RadarData): string {
  return `window.LAUNCH_RADAR=${JSON.stringify(radar)};\n`;
}
