// The token radar's model, "radar-2": one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) plus every
// rankable protocol below the watchlist floor: the early rows the radar exists to find. A protocol is
// rankable when its record carries no token (mcap_usd, gecko_id and symbol all null), its category is
// not Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX, its name does
// not end in a version marker, carries no whole word wrapped / staked / staking, and does not start
// with an exchange name. Above the floor only the watchlist counts: the house's parent-checked list.
// That gives 40 watchlist rows + 138 early rows = 178 rows on this snapshot, asserted in buildBoard.
//
// Implied value follows only from the snapshot's own figures, never from a hand-kept list of names:
//
//   multiple     = the category's median mcap/TVL over token-bearing peers (see calibrate), clamped
//                  to [0.05, 1.0]; categories with fewer than 3 peers use the global median instead
//   growthMult   = 1 + clamp(change_7d, -60, 120) / 100 * 0.5
//   maturityMult = 0.6 + min(age_days, 1095) / 1095 * 0.4   (age unknown: 365 days)
//   chainMult    = 1 + 0.02 * min(max(chains - 1, 0), 10)
//   implied      = max(1, round(tvl_usd * multiple * growthMult * maturityMult * chainMult))
//
// The multiple is built from mcap, which is circulating market cap: a token's fully-diluted value is
// usually higher, so this multiple is conservative versus a fully-diluted value. The model does not
// predict whether or when a protocol issues a token, only what a launch would be worth if its record
// stayed as it is.

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

/** The model's constants, as the dashboard states them. */
export interface ModelConstants {
  base: 'category-calibrated';
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_per_extra: number;
  chain_cap: number;
  global_median_multiple: number;
}

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** The board size this snapshot must produce: 40 watchlist rows + 138 early rows. */
export const EXPECTED_BOARD_SIZE = 178;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/**
 * What the model is, in the dashboard's own words. mcap is circulating market cap, so the
 * category multiple is conservative versus a fully-diluted value.
 */
export const MODEL_DESCRIPTION =
  'radar-2 ranks each pre-token protocol by an implied launch value: TVL times its category\'s ' +
  'median market-cap-to-TVL ratio over token-bearing peers (clamped to 0.05–1.0, global median ' +
  'where a category has fewer than 3 peers), adjusted for 7-day TVL growth, for how long the ' +
  'protocol has run with no token, and for how many chains it runs on. The multiple is built ' +
  'from circulating market cap, so it is conservative versus a fully-diluted value. The model ' +
  'does not predict whether or when a protocol issues a token, and it does not predict a price: ' +
  'it only prices the record as it stands.';

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  base_multiple: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
  watchlist: boolean;
}

/** One category's calibration: its multiple, how many peers set it, and whether it fell back. */
export interface CalibrationRow {
  category: string | null;
  multiple: number;
  peers: number;
  fallback: boolean;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** Everything the dashboard needs: the board, the live set, the calibration and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  calibration: CalibrationRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const MIN_PEERS = 3;
const MULTIPLE_FLOOR = 0.05;
const MULTIPLE_CAP = 1.0;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/**
 * The category multiples: for each category, the median mcap/TVL over token-bearing peers with
 * mcap > 0 and tvl > 0, using only categories with at least 3 such peers, clamped to [0.05, 1.0].
 * Categories with fewer peers, and protocols with no category, use the global median over all such
 * peers (also clamped). Returns the per-category map, the global median, and one calibration row per
 * category that appears in the board or live set.
 */
export function calibrate(
  snapshot: Snapshot,
  categories: (string | null)[],
): { multiples: Map<string | null, number>; globalMedian: number; calibration: CalibrationRow[] } {
  const byCategory = new Map<string | null, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      const ratio = p.mcap_usd / p.tvl_usd;
      all.push(ratio);
      const list = byCategory.get(p.category) ?? [];
      list.push(ratio);
      byCategory.set(p.category, list);
    }
  }
  if (all.length === 0) throw new SnapshotError('snapshot.json has no token-bearing peer to calibrate from');
  const clamp = (n: number): number => Math.min(MULTIPLE_CAP, Math.max(MULTIPLE_FLOOR, n));
  const globalMedian = clamp(median(all));
  const multiples = new Map<string | null, number>();
  const calibration: CalibrationRow[] = [];
  const seen = [...new Set(categories)].sort((a, b) => {
    if (a === null) return 1;
    if (b === null) return -1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  for (const category of seen) {
    const peers = byCategory.get(category) ?? [];
    if (peers.length >= MIN_PEERS) {
      const multiple = clamp(median(peers));
      multiples.set(category, multiple);
      calibration.push({ category, multiple: round4(multiple), peers: peers.length, fallback: false });
    } else {
      multiples.set(category, globalMedian);
      calibration.push({ category, multiple: round4(globalMedian), peers: peers.length, fallback: true });
    }
  }
  return { multiples, globalMedian, calibration };
}

/** The four multipliers and the implied value one protocol gets. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  baseMultiple: number,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(120, Math.max(-60, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * 0.5;
  const ageForModel = age ?? 365;
  const maturityMult = 0.6 + (Math.min(Math.max(ageForModel, 0), 1095) / 1095) * 0.4;
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), 10);
  const chainMult = 1 + 0.02 * extraChains;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * baseMultiple * growthMult * maturityMult * chainMult));
  return { implied, growthPct, growthMult, maturityMult, chainMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
/** A whole word wrapped, staked or staking, in any case. */
const WRAPPED_OR_STAKED = /\b(wrapped|staked|staking)\b/i;
/** Exchange names a protocol name must not start with. */
const EXCHANGES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
/** Categories that are a wrapped, staked or bridged product of a token that already trades. */
const EXCLUDED_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank below the floor. */
export function isRankable(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (VERSIONED.test(p.name)) return false;
  if (WRAPPED_OR_STAKED.test(p.name)) return false;
  if (EXCHANGES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug on it, whatever its TVL.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: every rankable protocol below the watchlist floor. Above the floor only the
  // watchlist counts: the house's parent-checked list, not the checkable exclusions.
  for (const p of snapshot.protocols) {
    if (!chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd) chosen.set(p.slug, p);
  }
  const picked = [...chosen.values()];
  if (picked.length !== EXPECTED_BOARD_SIZE) {
    throw new SnapshotError(
      `the board holds ${picked.length} rows, not the ${EXPECTED_BOARD_SIZE} this snapshot gives (40 watchlist + 138 early): the eligibility rule or the snapshot changed`,
    );
  }
  const categories = picked.map((p) => p.category);
  const { multiples } = calibrate(snapshot, categories);
  const scored = picked.map((p) => {
    const baseMultiple = multiples.get(p.category) ?? 0;
    const { implied, growthPct, growthMult, maturityMult, chainMult, age } = impliedValue(p, snapshot.as_of, baseMultiple);
    return { p, baseMultiple, implied, growthPct, growthMult, maturityMult, chainMult, age };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: round4(s.baseMultiple),
      growth_pct: round4(s.growthPct),
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      chain_multiplier: round4(s.chainMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol, at: number): string {
  return p.chains.length > at ? p.chains[at]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** A growth figure as the farm plan states it: 12.5, -4, never a long decimal tail. */
function fmtPct(n: number): string {
  const r = Math.round(n * 100) / 100;
  return Number.isInteger(r) ? String(r) : String(r);
}

/**
 * The category's main farming action, naming the protocol and its first chain. Derived from the
 * protocol's own category, never from a hand-kept list of names.
 */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const name = p.name;
  switch ((p.category ?? '').toLowerCase()) {
    case 'risk curators':
      return `Deposit $${capital} into a ${name} curated vault on ${chain} and keep the vault shares in your wallet.`;
    case 'dexs':
      return `Provide $${capital} of liquidity to ${name}'s largest pool on ${chain} and keep the LP position open.`;
    case 'onchain capital allocator':
      return `Deposit $${capital} into a ${name} allocation vault on ${chain} and keep the vault shares in your wallet.`;
    case 'rwa':
      return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in your wallet.`;
    case 'lending':
      return `Supply $${capital} of USDC to ${name} on ${chain} and keep the supplied position open.`;
    case 'yield':
      return `Deposit $${capital} into ${name}'s highest-TVL yield vault on ${chain} and keep the position open.`;
    case 'derivatives':
      return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged position.`;
    case 'cdp':
      return `Lock $${capital} of collateral in a ${name} vault on ${chain} and mint its stable asset against it.`;
    case 'yield aggregator':
      return `Deposit $${capital} into ${name}'s auto-compounding vault on ${chain} and keep the vault shares.`;
    case 'basis trading':
      return `Deposit $${capital} of USDC into ${name}'s basis vault on ${chain} and keep the position open.`;
    case 'chain':
      return `Bridge $${capital} of USDC onto ${chain} through ${name} and use the bridged funds in an app there.`;
    case 'staking pool':
      return `Stake $${capital} of the chain's asset in ${name}'s staking pool on ${chain} and keep the receipt token.`;
    case 'liquidity manager':
      return `Deposit $${capital} into a ${name}-managed concentrated liquidity position on ${chain} and keep it open.`;
    case 'leveraged farming':
      return `Open a leveraged farming position of $${capital} on ${name} on ${chain} and keep the health factor above 1.5.`;
    case 'restaking':
      return `Restake $${capital} of the staking asset through ${name} on ${chain} and keep the restaking receipt.`;
    case 'insurance':
      return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
    case 'prediction market':
      return `Fund $${capital} on ${name} on ${chain} and place one position in an active market.`;
    case 'farm':
      return `Deposit $${capital} into ${name}'s farm on ${chain} and keep the staked LP tokens there.`;
    case 'payments':
      return `Send $${capital} through ${name} on ${chain} and keep the receipt in your wallet.`;
    case 'indexes':
      return `Buy $${capital} of the ${name} index token on ${chain} and hold it in your wallet.`;
    case 'uncollateralized lending':
      return `Deposit $${capital} of USDC into ${name}'s lending pool on ${chain} and keep the position open.`;
    case 'interest rate derivatives':
      return `Deposit $${capital} of USDC into ${name}'s rate market on ${chain} and open one fixed-rate position.`;
    case 'cedefi':
      return `Deposit $${capital} of USDC into ${name}'s vault on ${chain} and keep the position open.`;
    case 'anchor btc':
    case 'decentralized btc':
      return `Deposit $${capital} of BTC into ${name} on ${chain} and keep the minted asset in your wallet.`;
    case 'stablecoin wrapper':
      return `Wrap $${capital} of the stable asset through ${name} on ${chain} and hold the wrapped token.`;
    case 'dual-token stablecoin':
      return `Mint $${capital} of ${name}'s stable asset on ${chain} and hold it in your wallet.`;
    case 'collateral markets':
      return `Supply $${capital} of collateral to ${name} on ${chain} and keep the position open.`;
    case 'governance incentives':
      return `Deposit $${capital} into ${name}'s incentive pool on ${chain} and keep the position open.`;
    case 'crypto card issuer':
      return `Load $${capital} onto a ${name} card on ${chain} and spend from it at least once a week.`;
    default:
      return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
  }
}

/**
 * The complementary second action for a single-chain protocol, from its category: a different
 * qualifying interaction with the same protocol, not a repeat of the first step.
 */
function complementFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const name = p.name;
  const small = Math.min(25, Math.max(10, Math.floor(capital / 4)));
  switch ((p.category ?? '').toLowerCase()) {
    case 'dexs':
      return `Swap $${small} of USDC for the chain's gas token on ${name} on ${chain} so the wallet shows trading activity.`;
    case 'lending':
    case 'cdp':
    case 'collateral markets':
      return `Borrow $${small} against the supplied collateral on ${name} on ${chain}, then repay it within a week.`;
    case 'yield':
    case 'yield aggregator':
    case 'risk curators':
    case 'onchain capital allocator':
      return `Deposit a second $${small} into a different ${name} vault on ${chain} so the wallet holds two positions.`;
    case 'derivatives':
    case 'basis trading':
    case 'interest rate derivatives':
      return `Open a second small position of $${small} on ${name} on ${chain} in the opposite direction as a hedge.`;
    case 'rwa':
    case 'dual-token stablecoin':
      return `Buy another $${small} of ${name}'s asset on ${chain} and hold it in the same wallet.`;
    case 'chain':
      return `Use $${small} of the bridged funds in a second app on ${chain} and keep the transaction receipt.`;
    case 'staking pool':
    case 'restaking':
      return `Stake a further $${small} through ${name} on ${chain} so the wallet shows a second staking transaction.`;
    case 'liquidity manager':
    case 'leveraged farming':
      return `Add $${small} to the ${name} position on ${chain} and rebalance it once.`;
    case 'prediction market':
      return `Place a second $${small} position in a different market on ${name} on ${chain}.`;
    case 'insurance':
      return `Buy a second $${small} of cover from ${name} on ${chain} for a different protocol.`;
    case 'farm':
      return `Stake another $${small} of LP tokens in ${name}'s farm on ${chain}.`;
    case 'payments':
      return `Send a second $${small} payment through ${name} on ${chain} to a different address.`;
    case 'indexes':
      return `Buy another $${small} of the ${name} index token on ${chain}.`;
    default:
      return `Make a second $${small} deposit into ${name} on ${chain} so the wallet shows more than one interaction.`;
  }
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived
 * from the protocol's own record (category, chains, TVL, age, 7-day growth), never from a hand-kept
 * list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p, 0);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const growth = p.change_7d ?? 0;
  const main = actionFor(p, capital, chain);
  const second =
    p.chains.length > 1
      ? `${actionFor(p, Math.min(capital, 100), chainOf(p, 1))} Do the same position on ${chainOf(p, 1)} so both chains count.`
      : complementFor(p, capital, chain);
  const weekly =
    growth >= 20
      ? `Make one qualifying action each week, such as a deposit, a swap or a vote: ${p.name}'s TVL rose ${fmtPct(growth)}% in 7 days, so repeat it weekly while the momentum lasts.`
      : `Make one qualifying action each week, such as a deposit, a swap or a vote on ${p.name}.`;
  const holdText =
    growth <= -20
      ? `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot. ${p.name}'s TVL fell ${fmtPct(growth)}% in 7 days, so check the position weekly and do not add funds while it keeps falling.`
      : `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`;
  return [
    {
      text: `Open a fresh wallet that holds only the funds you plan to farm on ${p.name}, and keep its seed phrase offline on paper.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: main,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: second,
      cost: `about $${p.chains.length > 1 ? Math.min(capital, 100) : Math.min(25, Math.max(10, Math.floor(capital / 4)))} of capital and about $4 of gas`,
      time: '10 minutes',
    },
    {
      text: weekly,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: holdText,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open ${p.name}'s own points or rewards page from the link it publishes itself and claim only there. Never pay a fee to claim, and never trust a claim link from a chat, an ad or a search result.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet address, the dates and every transaction hash for ${p.name} in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.tvl_usd > 0 && p.mcap_usd !== null ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow, watchlist: Set<string>): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    base_multiple: row.model.base_multiple,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
    watchlist: watchlist.has(row.slug),
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const watchlist = new Set(snapshot.watchlist);
  const early = board.filter((r) => !watchlist.has(r.slug)).length;
  const categories = [...new Set([...board.map((r) => r.category), ...live.map((r) => r.category)])];
  const { globalMedian, calibration } = calibrate(snapshot, categories);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model: {
      base: 'category-calibrated',
      growth_weight: 0.5,
      growth_floor: -60,
      growth_cap: 120,
      maturity_floor: 0.6,
      maturity_range: 0.4,
      maturity_days: 1095,
      unknown_age_days: 365,
      chain_per_extra: 0.02,
      chain_cap: 1.2,
      global_median_multiple: round4(globalMedian),
    },
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    calibration,
    rows: board.map((r) => radarRow(r, watchlist)),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    const keys = Object.keys(p).sort();
    const want = ['category', 'chains', 'change_7d', 'gecko_id', 'listed_at', 'mcap_usd', 'name', 'slug', 'symbol', 'tvl_usd'];
    if (keys.length !== want.length || keys.some((k, j) => k !== want[j])) {
      throw new SnapshotError(`snapshot.json's protocol ${i} does not carry exactly the ten fields`);
    }
    if (typeof p.slug !== 'string' || p.slug.length === 0 || typeof p.name !== 'string' || p.name.length === 0) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug or a name`);
    }
    if (typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd) || p.tvl_usd < 0) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a TVL`);
    }
    if (p.category !== null && typeof p.category !== 'string') throw new SnapshotError(`snapshot.json's protocol ${i} has a bad category`);
    if (!Array.isArray(p.chains) || p.chains.some((c) => typeof c !== 'string')) throw new SnapshotError(`snapshot.json's protocol ${i} has bad chains`);
    if (p.change_7d !== null && (typeof p.change_7d !== 'number' || !Number.isFinite(p.change_7d))) throw new SnapshotError(`snapshot.json's protocol ${i} has a bad change_7d`);
    // mcap_usd may be -1: DefiLlama's placeholder where it records a token but no market cap
    // (autofinance). Calibration and the live view only use mcap > 0, so it scores as no value.
    if (p.mcap_usd !== null && (typeof p.mcap_usd !== 'number' || !Number.isFinite(p.mcap_usd))) throw new SnapshotError(`snapshot.json's protocol ${i} has a bad mcap_usd`);
    if (p.listed_at !== null && (typeof p.listed_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(p.listed_at))) throw new SnapshotError(`snapshot.json's protocol ${i} has a bad listed_at`);
    if (p.gecko_id !== null && typeof p.gecko_id !== 'string') throw new SnapshotError(`snapshot.json's protocol ${i} has a bad gecko_id`);
    if (p.symbol !== null && typeof p.symbol !== 'string') throw new SnapshotError(`snapshot.json's protocol ${i} has a bad symbol`);
    return {
      slug: p.slug,
      name: p.name,
      category: p.category as string | null,
      chains: p.chains as string[],
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d as number | null,
      mcap_usd: p.mcap_usd as number | null,
      listed_at: p.listed_at as string | null,
      gecko_id: p.gecko_id as string | null,
      symbol: p.symbol as string | null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `rank ${byRank[i]!.rank} outranks rank ${byRank[i - 1]!.rank} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${byRank[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    const steps = r.farm_steps;
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) return `${r.slug} has ${Array.isArray(steps) ? steps.length : 'no'} farm steps`;
    for (const s of steps) {
      if (typeof s !== 'string') return `${r.slug} has a non-string farm step`;
      const len = s.trim().length;
      if (len < 20 || len > 600) return `${r.slug} has a farm step of ${len} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
