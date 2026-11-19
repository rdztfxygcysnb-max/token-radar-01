# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/rdztfxygcysnb-max/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/rdztfxygcysnb-max/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Build the best token launch radar. It reads a sealed snapshot of every protocol and writes a web dashboard that ranks the protocols with no token yet by what their launch would be worth, each with the steps to farm it; an AI judge compares the dashboards two at a time, places go by win rate, and the 10 best share $1,325 in rewards.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../token-radar-01-kit/input/snapshot.json
```

## How the model works

The board (model `radar-2`) covers every protocol on the snapshot's watchlist (40) plus every
rankable protocol below the $50M floor: one that records no token, is not a bridge, liquid-staking
or restaking product, not a CEX, not a versioned pool, and not a wrapped or staked product of a
token that already trades. That is 178 rows on this snapshot.

Each row's implied value is its TVL times its category's median market-cap-to-TVL ratio over
token-bearing peers (clamped to 0.05–1.0; categories with fewer than 3 peers use the global median),
adjusted for 7-day TVL growth, for how long the protocol has run with no token, and for how many
chains it runs on. The multiple is built from circulating market cap, so it is conservative versus
a fully-diluted value. Every row carries a 7-step farm plan derived from its own record — category,
chains, TVL, age and 7-day growth — with dollar costs and times.

What it does NOT predict: whether or when a protocol issues a token, what its token would be
priced at, or whether farming it pays off. It only prices the record as it stands. A protocol is
described as recording no token, never as having none: the snapshot is DefiLlama's record, not proof.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gj29ear9&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
