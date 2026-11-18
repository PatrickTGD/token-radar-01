// Launch Radar model: one sealed snapshot in, one ranked board of pre-token protocols out.
//
// The idea: a protocol that records no token has no market price, so we price it two independent
// ways from the snapshot's traded half, and blend the two.
//
//   A. Peer multiples. Protocols whose token trades give, per category, a market-cap-to-TVL
//      multiple (winsorised, median, sparse categories shrunk toward the market's median).
//      A pre-token protocol prices at its TVL times its category's multiple.
//   B. A fitted size curve. Across every traded protocol, log market cap is regressed on log
//      TVL; a category with enough traded peers gets its own intercept on that curve, shrunk
//      toward the market's. A pre-token protocol prices where the curve puts its TVL.
//
// The board's value is the geometric blend of the two, nudged by three facts from the protocol's
// own record: how fast its TVL moved over seven days, how many years it has run with no token,
// and on how many chains it runs.
//
//   implied = blend(A, B) x growth_factor x maturity_factor x breadth_factor
//
// The spread between A and B is carried on every row as a value range: where two unrelated
// methods agree, the range is narrow; where they fight, it is wide, and the reader sees it.
//
// The model is also graded, in this file, on the only ground truth the snapshot holds: the
// traded protocols themselves. Leave-one-out: each traded protocol is priced by the full model
// fitted without it, and the error is recorded. Those figures ship in the dashboard's data, so
// the page shows the backtest next to the board it produced. Nothing is hardcoded: no protocol
// is named in this file, and every figure is computed from the snapshot at run time.

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
  /** The board carries every qualifying protocol at or above this TVL (the snapshot's own floor). */
  board_min_tvl_usd: 5_000_000,
  /** Comp ratios are winsorised into this band before any median is taken. */
  ratio_floor: 0.01,
  ratio_cap: 10,
  /** A category needs at least this many traded peers before its own median is used at all. */
  min_comps: 3,
  /** Sparse category medians are shrunk toward the global median with this weight. */
  shrink_weight: 4,
  /** No multiple, however strong its peers or its curve, leaves this band. */
  multiple_floor: 0.02,
  multiple_cap: 5,
  /** A category needs at least this many traded peers before the size curve gives it an intercept. */
  curve_min_category_comps: 8,
  /** Category intercepts on the size curve are shrunk toward the market's with this weight. */
  curve_shrink_weight: 8,
  /** The blend's weight on the peer-multiple value, in log space; the curve takes the rest. */
  blend_weight_a: 0.5,
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

/** The traded half of the snapshot: a token that trades, with both a market cap and a TVL on record. */
export function tradedComps(snapshot: Snapshot): SnapshotProtocol[] {
  return snapshot.protocols.filter((p) => !recordsNoToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
}

// ------------------------------------------------------------------ method A: peer multiples

/** What the traded half of the snapshot says: one winsorised mcap/TVL median per category, and one overall. */
export interface CompTable {
  global_multiple: number;
  by_category: Map<string, { comps: number; median: number }>;
}

/**
 * The comparison set's ratios: each traded protocol's mcap/TVL, winsorised so a single
 * micro-cap cannot set a whole category's price.
 */
export function compTableFrom(list: SnapshotProtocol[]): CompTable {
  const all: number[] = [];
  const byCategory = new Map<string, number[]>();
  for (const p of list) {
    const ratio = clamp(p.mcap_usd! / p.tvl_usd, MODEL.ratio_floor, MODEL.ratio_cap);
    all.push(ratio);
    if (p.category !== null) {
      const entry = byCategory.get(p.category);
      if (entry === undefined) byCategory.set(p.category, [ratio]);
      else entry.push(ratio);
    }
  }
  const by_category = new Map<string, { comps: number; median: number }>();
  for (const [category, ratios] of byCategory) by_category.set(category, { comps: ratios.length, median: median(ratios) });
  return { global_multiple: median(all), by_category };
}

/** The comparison table for a whole snapshot. */
export function compTable(snapshot: Snapshot): CompTable {
  return compTableFrom(tradedComps(snapshot));
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

// ------------------------------------------------------------------ method B: the fitted size curve

/** The size curve: log market cap against log TVL, one market line and shrunk per-category intercepts. */
export interface CurveFit {
  /** The market's intercept and slope: log(mcap) = intercept + slope x log(TVL). */
  intercept: number;
  slope: number;
  /** Per-category intercepts (same slope), only for categories with enough traded peers. */
  intercepts: Map<string, number>;
  /** How many traded protocols the curve was fitted on. */
  comps: number;
  /** Traded peers per category, for the dashboard's account of which intercept a row used. */
  category_comps: Map<string, number>;
}

/** Fit the size curve on a list of traded protocols by least squares. */
export function curveFitFrom(list: SnapshotProtocol[]): CurveFit {
  const n = list.length;
  const xs = list.map((p) => Math.log(p.tvl_usd));
  const ys = list.map((p) => Math.log(p.mcap_usd!));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  const intercept = my - slope * mx;
  const residuals = new Map<string, number[]>();
  const category_comps = new Map<string, number>();
  list.forEach((p, i) => {
    if (p.category === null) return;
    category_comps.set(p.category, (category_comps.get(p.category) ?? 0) + 1);
    const entry = residuals.get(p.category);
    const r = ys[i]! - slope * xs[i]!;
    if (entry === undefined) residuals.set(p.category, [r]);
    else entry.push(r);
  });
  const intercepts = new Map<string, number>();
  for (const [category, rs] of residuals) {
    if (rs.length < MODEL.curve_min_category_comps) continue;
    const own = rs.reduce((a, b) => a + b, 0) / rs.length;
    intercepts.set(category, (rs.length * own + MODEL.curve_shrink_weight * intercept) / (rs.length + MODEL.curve_shrink_weight));
  }
  return { intercept, slope, intercepts, comps: n, category_comps };
}

/** Fit the size curve for a whole snapshot. */
export function curveFit(snapshot: Snapshot): CurveFit {
  return curveFitFrom(tradedComps(snapshot));
}

/** The curve's price for one TVL in one category: the fitted value, and the multiple it implies. */
export function curvePrice(category: string | null, tvl: number, fit: CurveFit): { value: number; multiple: number; category_comps: number } {
  const own = category === null ? undefined : fit.intercepts.get(category);
  const a = own ?? fit.intercept;
  const raw = Math.exp(a + fit.slope * Math.log(tvl));
  const multiple = round4(clamp(raw / tvl, MODEL.multiple_floor, MODEL.multiple_cap));
  return { value: Math.round(tvl * multiple), multiple, category_comps: category === null ? 0 : (fit.category_comps.get(category) ?? 0) };
}

// ------------------------------------------------------------------ the record's own nudges

const DAY_MS = 86_400_000;

/** Whole days from a listing date to the snapshot's as_of date, clamped at zero; null when unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The three nudges from a protocol's own record, shared by the board and the backtest. */
export interface Adjustments {
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  age_years: number | null;
  combined: number;
}

/** Growth, maturity and breadth for one protocol. Factors are rounded, so shown working multiplies out. */
export function adjustments(p: SnapshotProtocol, asOf: string): Adjustments {
  const growthPct = p.change_7d === null ? 0 : clamp(p.change_7d, MODEL.growth_floor_pct, MODEL.growth_cap_pct);
  const growth = round4(1 + (growthPct / 100) * MODEL.growth_weight);
  const days = ageDays(asOf, p.listed_at);
  const ageYears = days === null ? null : days / 365.25;
  const maturity = round4(1 + MODEL.maturity_per_year * Math.min(ageYears ?? 0, MODEL.maturity_year_cap));
  const breadth = round4(1 + MODEL.breadth_per_chain * Math.min(Math.max(p.chains.length - 1, 0), MODEL.breadth_chain_cap));
  return {
    growth_factor: growth,
    maturity_factor: maturity,
    breadth_factor: breadth,
    age_years: ageYears === null ? null : Math.round(ageYears * 100) / 100,
    combined: growth * maturity * breadth,
  };
}

// ------------------------------------------------------------------ scoring

/** The model's reading of one protocol: both prices, the blend, the range and every factor. */
export interface ScoreBreakdown {
  category_multiple: number;
  category_comps: number;
  comp_value_usd: number;
  curve_multiple: number;
  curve_category_comps: number;
  curve_value_usd: number;
  growth_factor: number;
  maturity_factor: number;
  breadth_factor: number;
  age_years: number | null;
  value_low_usd: number;
  value_high_usd: number;
  implied_value_usd: number;
}

const wholeDollars = (n: number): number => Math.min(100_000_000_000_000, Math.max(1, Math.round(n)));

/** Score one qualifying protocol: blend the two prices in log space, then apply the record's nudges. */
export function score(p: SnapshotProtocol, asOf: string, comps: CompTable, fit: CurveFit): ScoreBreakdown {
  const { multiple, comps: n } = categoryMultiple(p.category, comps);
  const compValue = p.tvl_usd * multiple;
  const curve = curvePrice(p.category, p.tvl_usd, fit);
  const w = MODEL.blend_weight_a;
  const blended = Math.exp(w * Math.log(compValue) + (1 - w) * Math.log(curve.value));
  const adj = adjustments(p, asOf);
  const low = wholeDollars(Math.min(compValue, curve.value) * adj.combined);
  const high = wholeDollars(Math.max(compValue, curve.value) * adj.combined);
  const implied = clamp(wholeDollars(blended * adj.combined), low, high);
  return {
    category_multiple: multiple,
    category_comps: n,
    comp_value_usd: wholeDollars(compValue),
    curve_multiple: curve.multiple,
    curve_category_comps: curve.category_comps,
    curve_value_usd: curve.value,
    growth_factor: adj.growth_factor,
    maturity_factor: adj.maturity_factor,
    breadth_factor: adj.breadth_factor,
    age_years: adj.age_years,
    value_low_usd: low,
    value_high_usd: high,
    implied_value_usd: implied,
  };
}

// ------------------------------------------------------------------ the backtest

/** One method's leave-one-out record on the traded protocols. */
export interface MethodStats {
  /** Median absolute percentage error, in per cent. */
  median_ape_pct: number;
  /** The share of traded protocols priced within a factor of two of their real market cap, in per cent. */
  within_2x_pct: number;
  /** The median predicted-to-actual ratio: above 1 the method prices high, below 1 it prices low. */
  median_ratio: number;
}

/** The model's own grading: leave-one-out statistics for each method and the ensemble, plus the fitted-versus-actual scatter. */
export interface Validation {
  comps: number;
  ensemble: MethodStats;
  comps_only: MethodStats;
  curve_only: MethodStats;
  curve_intercept: number;
  curve_slope: number;
  /** [log10 actual market cap, log10 fitted value] for every traded protocol, fitted on all of them. */
  scatter: [number, number][];
}

function methodStats(errors: { ape: number; ratio: number }[]): MethodStats {
  const within = errors.filter((e) => e.ratio >= 0.5 && e.ratio <= 2).length;
  return {
    median_ape_pct: Math.round(median(errors.map((e) => e.ape)) * 1000) / 10,
    within_2x_pct: Math.round((within / errors.length) * 1000) / 10,
    median_ratio: Math.round(median(errors.map((e) => e.ratio)) * 1000) / 1000,
  };
}

/**
 * Leave-one-out over the traded protocols: each is priced by the full model — both methods,
 * the blend and its own record's nudges — fitted without it, and the price is set against the
 * market cap it actually carries. The scatter, by contrast, is the full fit pricing its own
 * training set, which is what a fitted-versus-actual chart means.
 */
export function validateModel(snapshot: Snapshot): Validation {
  const list = tradedComps(snapshot);
  const asOf = snapshot.as_of;
  const w = MODEL.blend_weight_a;
  const ens: { ape: number; ratio: number }[] = [];
  const aOnly: { ape: number; ratio: number }[] = [];
  const bOnly: { ape: number; ratio: number }[] = [];
  for (let i = 0; i < list.length; i++) {
    const p = list[i]!;
    const rest = list.filter((_, j) => j !== i);
    const ct = compTableFrom(rest);
    const fit = curveFitFrom(rest);
    const adj = adjustments(p, asOf).combined;
    const a = p.tvl_usd * categoryMultiple(p.category, ct).multiple * adj;
    const b = curvePrice(p.category, p.tvl_usd, fit).value * adj;
    const blended = Math.exp(w * Math.log(a) + (1 - w) * Math.log(b));
    const actual = p.mcap_usd!;
    for (const [bucket, pred] of [[ens, blended], [aOnly, a], [bOnly, b]] as const) {
      bucket.push({ ape: Math.abs(pred - actual) / actual, ratio: pred / actual });
    }
  }
  const ctFull = compTableFrom(list);
  const fitFull = curveFitFrom(list);
  const scatter = list.map((p): [number, number] => {
    const s = score(p, asOf, ctFull, fitFull);
    return [Math.round(Math.log10(p.mcap_usd!) * 1000) / 1000, Math.round(Math.log10(s.implied_value_usd) * 1000) / 1000];
  });
  return {
    comps: list.length,
    ensemble: methodStats(ens),
    comps_only: methodStats(aOnly),
    curve_only: methodStats(bOnly),
    curve_intercept: Math.round(fitFull.intercept * 10000) / 10000,
    curve_slope: Math.round(fitFull.slope * 10000) / 10000,
    scatter,
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
  gas_usd: number;
  weeks: number;
}

/** Position sizes from the protocol's TVL tier: bigger protocols get bigger suggested positions. */
function farmContext(p: SnapshotProtocol, ageYears: number | null): FarmContext {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const chain2 = p.chains.length > 1 ? p.chains[1]! : chain;
  const gas = chain === 'Ethereum' ? 'about $18 in gas' : chain === 'Solana' ? 'under $1 in network fees' : chain === 'Bitcoin' ? 'about $6 in network fees' : 'about $2 in gas';
  const gas_usd = chain === 'Ethereum' ? 18 : chain === 'Solana' ? 1 : chain === 'Bitcoin' ? 6 : 2;
  const tier = p.tvl_usd >= 1_000_000_000 ? { core: 500, small: 200 } : p.tvl_usd >= 250_000_000 ? { core: 300, small: 120 } : p.tvl_usd >= 50_000_000 ? { core: 200, small: 80 } : { core: 100, small: 40 };
  const weeks = ageYears === null ? 6 : ageYears >= 3 ? 4 : ageYears >= 1 ? 6 : 8;
  return { name: p.name, chain, chain2, core: tier.core, small: tier.small, gas, gas_usd, weeks };
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

/** The playbooks by key: each line of business gets its own plan. */
const PLAYBOOKS: Record<string, Playbook> = {
  lending: lendingPlan,
  dex: dexPlan,
  yield: yieldPlan,
  derivatives: derivativesPlan,
  cdp: cdpPlan,
  curator: curatorPlan,
  rwa: rwaPlan,
  basis: basisPlan,
  staking: stakingPlan,
  bridge: bridgePlan,
  prediction: predictionPlan,
  insurance: insurancePlan,
  payments: paymentsPlan,
  index: indexPlan,
  chain: chainPlan,
  default: defaultPlan,
};

/** The playbook key for a category. */
function playbookKey(category: string | null): string {
  switch (category) {
    case 'Lending':
    case 'Uncollateralized Lending':
    case 'Collateral Markets':
      return 'lending';
    case 'Dexs':
      return 'dex';
    case 'Yield':
    case 'Yield Aggregator':
    case 'Farm':
    case 'Leveraged Farming':
      return 'yield';
    case 'Derivatives':
      return 'derivatives';
    case 'CDP':
    case 'CDP Manager':
    case 'Dual-Token Stablecoin':
    case 'Stablecoin Wrapper':
      return 'cdp';
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Liquidity Manager':
      return 'curator';
    case 'RWA':
      return 'rwa';
    case 'Basis Trading':
      return 'basis';
    case 'Staking Pool':
    case 'Restaking':
    case 'Anchor BTC':
    case 'Decentralized BTC':
      return 'staking';
    case 'Cross Chain Bridge':
      return 'bridge';
    case 'Prediction Market':
      return 'prediction';
    case 'Insurance':
      return 'insurance';
    case 'Payments':
    case 'Crypto Card Issuer':
      return 'payments';
    case 'Indexes':
      return 'index';
    case 'Chain':
      return 'chain';
    default:
      return 'default';
  }
}

// ---------------------------------------------------------- what a plan costs, step by step

/**
 * One step's money, in the same order as the playbook's text: `fee` is dollars that leave and do
 * not come back (gas, swap and bridge fees, premiums, interest), `cap` is capital the step puts
 * to work (still the farmer's, withdrawable), `min` is the farmer's own minutes. The prose of
 * each step states the same figures; these are the numbers the plan's totals are added from.
 */
interface StepCost {
  fee: number;
  cap: number;
  min: number;
}

type CostBook = (c: FarmContext) => StepCost[];
const step = (fee: number, cap: number, min: number): StepCost => ({ fee, cap, min });

/** Step costs per playbook, aligned step for step with the texts above. */
const PLAN_COSTS: Record<string, CostBook> = {
  lending: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(2 + c.gas_usd, 0, 20), step(c.gas_usd * c.weeks, 0, 10 * c.weeks), step(0, 0, 5)],
  dex: (c) => [step(c.gas_usd, 0, 10), step(1.5 + c.gas_usd, 0, 15), step(c.gas_usd, c.core, 20), step(c.gas_usd * c.weeks, 0, 10 * c.weeks), step(0, 0, 5)],
  yield: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(c.gas_usd, 0, 10), step(c.gas_usd * c.weeks, c.small * c.weeks, 10 * c.weeks), step(0, 0, 5)],
  derivatives: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(3 + c.gas_usd, 0, 20), step((3 + c.gas_usd) * c.weeks, 0, 15 * c.weeks), step(0, 0, 5)],
  cdp: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 20), step(c.gas_usd, 0, 10), step(c.gas_usd * c.weeks, 0, 10 * c.weeks), step(0, 0, 5)],
  curator: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(c.gas_usd, c.small, 15), step(2 * c.gas_usd, 0, 10), step(c.gas_usd * c.weeks, 0, 10 * c.weeks)],
  rwa: (c) => [step(c.gas_usd, 0, 20), step(c.gas_usd, c.core, 15), step(c.gas_usd, c.small, 10), step(0, 0, 0), step(0, 0, 5)],
  basis: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(c.gas_usd, c.small, 10), step(c.gas_usd * c.weeks, 0, 10 * c.weeks), step(0, 0, 5)],
  staking: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(c.gas_usd, 0, 15), step(c.gas_usd * c.weeks, 0, 10 * c.weeks), step(0, 0, 5)],
  bridge: (c) => [step(c.gas_usd, 0, 10), step(2 + c.gas_usd, c.core, 25), step(c.gas_usd, 0, 10), step((2 + c.gas_usd) * c.weeks, 0, 15 * c.weeks), step(0, 0, 5)],
  prediction: (c) => [step(c.gas_usd, c.core, 15), step(1, c.small, 10), step(0, c.small * c.weeks, 10 * c.weeks), step(0, 0, 0), step(0, 0, 5)],
  insurance: (c) => [step(c.gas_usd, 0, 10), step(3.5 + c.gas_usd, 0, 15), step(3.5, 0, 10), step(c.gas_usd, c.small, 15), step(0, 0, 5)],
  payments: (c) => [step(0, 0, 20), step(c.gas_usd, c.small, 10), step(2, 0, 15), step(1 * c.weeks, 0, 5 * c.weeks), step(0, 0, 5)],
  index: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(c.gas_usd * c.weeks, c.small * c.weeks, 10 * c.weeks), step(c.gas_usd, 0, 10), step(0, 0, 5)],
  chain: (c) => [step(c.gas_usd, 0, 10), step(2 + c.gas_usd, c.core, 25), step(c.gas_usd * c.weeks, 0, 15 * c.weeks), step(0, 0, 0), step(0, 0, 5)],
  default: (c) => [step(c.gas_usd, 0, 10), step(c.gas_usd, c.core, 15), step(c.gas_usd, 0, 10), step(c.gas_usd * c.weeks, 0, 10 * c.weeks), step(0, 0, 5)],
};

/** A plan's totals, added up from its steps: the net cost of farming this protocol. */
export interface PlanTotals {
  /** Dollars spent for good: gas, fees, premiums, interest. */
  fee_usd: number;
  /** Dollars put to work by the plan: still the farmer's, withdrawable. */
  capital_usd: number;
  /** The farmer's own active minutes across the whole plan. */
  minutes: number;
  /** The weeks the plan runs over. */
  weeks: number;
}

/** Add a plan's step costs up into its totals. */
export function planTotals(p: SnapshotProtocol, ageYears: number | null): PlanTotals {
  const c = farmContext(p, ageYears);
  const costs = PLAN_COSTS[playbookKey(p.category)]!(c);
  return {
    fee_usd: Math.round(costs.reduce((n, s) => n + s.fee, 0)),
    capital_usd: costs.reduce((n, s) => n + s.cap, 0),
    minutes: costs.reduce((n, s) => n + s.min, 0),
    weeks: c.weeks,
  };
}

/** A span of minutes the way a reader says it: 110 minutes, or about 2.5 hours. */
export function timeText(minutes: number): string {
  if (minutes < 120) return `${minutes} minutes`;
  const hours = Math.round(minutes / 6) / 10;
  return `about ${hours} hours`;
}

/** A protocol's farm plan: five concrete steps built from its category, chains and size, plus their added-up totals. */
export function farmSteps(p: SnapshotProtocol, ageYears: number | null): string[] {
  const c = farmContext(p, ageYears);
  const steps = PLAYBOOKS[playbookKey(p.category)]!(c).map((s) => s.trim());
  const t = planTotals(p, ageYears);
  steps.push(
    `Plan totals, added up from the steps above: about $${t.fee_usd} in fees, gas and interest that does not come back; $${t.capital_usd} of capital put to work, still yours and withdrawable; and ${timeText(t.minutes)} of your own time, spread over ${t.weeks} weeks.`,
  );
  return steps;
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
  plan: PlanTotals;
  farm_steps: string[];
}

/** The full board: every qualifying protocol, ranked by implied value. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const comps = compTable(snapshot);
  const fit = curveFit(snapshot);
  const watch = new Set(snapshot.watchlist);
  const scored = snapshot.protocols
    .filter(qualifies)
    .map((p) => ({ p, s: score(p, snapshot.as_of, comps, fit) }));
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
    plan: planTotals(p, s.age_years),
    farm_steps: farmSteps(p, s.age_years),
  }));
}

/** One category's pricing line, for the model page: its peers, its multiple and its curve intercept. */
export interface CategoryLine {
  category: string;
  comps: number;
  multiple: number;
  curve_intercept: boolean;
}

/** Everything the dashboard renders: the board plus the model's own summary and backtest. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  global_multiple: number;
  board_size: number;
  watchlist_size: number;
  blend_weight_a: number;
  validation: Validation;
  categories: CategoryLine[];
  rows: BoardRow[];
}

/** Build the dashboard's dataset from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const comps = compTable(snapshot);
  const fit = curveFit(snapshot);
  const categories: CategoryLine[] = [...comps.by_category.keys()]
    .sort()
    .map((category) => ({
      category,
      comps: comps.by_category.get(category)!.comps,
      multiple: categoryMultiple(category, comps).multiple,
      curve_intercept: fit.intercepts.has(category),
    }));
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    global_multiple: round4(comps.global_multiple),
    board_size: board.length,
    watchlist_size: snapshot.watchlist.length,
    blend_weight_a: MODEL.blend_weight_a,
    validation: validateModel(snapshot),
    categories,
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
    if (r.model.value_low_usd > r.implied_value_usd || r.implied_value_usd > r.model.value_high_usd) {
      return `${r.slug} has implied value ${r.implied_value_usd} outside its own range ${r.model.value_low_usd}..${r.model.value_high_usd}`;
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
