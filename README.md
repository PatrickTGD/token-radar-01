# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/PatrickTGD/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/PatrickTGD/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot. It finds the protocols that have real usage but no token yet, and prices each one the way the market prices its already-launched peers.

## How it works

A protocol with no token has no market price, so the model builds one from comparable traded protocols ("comps"):

- For every category, it takes the median market-cap-to-TVL multiple of the protocols in that category whose tokens already trade (ratios winsorised to 0.01–10; sparse categories are shrunk toward the market-wide median, and categories with too few traded peers fall back to it entirely).
- A pre-token protocol's **implied value** is its own TVL × its category multiple, adjusted by three factors from its own record: 7-day TVL growth, years running without a token, and the number of chains it runs on.
- Derivative and exchange products (bridges, liquid staking, CEX products, wrapped/staked names, versioned pools) are excluded — they are products of tokens that already exist, not launch candidates.

On the sealed snapshot this ranks **154 pre-token protocols** and covers all **40 watchlist protocols**. Every protocol also gets a **5-step farm plan** — concrete actions with costs and time, drawn from 14 category playbooks (lending, DEX, yield, derivatives, CDP, RWA, bridges, prediction markets, and more), with position sizes scaled to the protocol's TVL tier.

## Outputs

- `board.json` — the ranked board: implied value, the full model breakdown per protocol, and its farm steps.
- `dashboard/` — an offline dashboard that renders from the bundled data with no network: a sortable board, category and chain filters, and a per-protocol detail view showing every factor in the score.
- `screenshots/` — the board, a detail view, and a filtered view.
- `dossier.json` — the run summary.

## Run it

Node 22, standard library only, no network. The run is deterministic — the only date it knows is the snapshot's own `as_of`.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=d5a50dzy&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
