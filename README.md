# token-radar-01

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/PatrickTGD/token-radar-01/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/PatrickTGD/token-radar-01/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar over the sealed DefiLlama snapshot. It finds the protocols that have real usage but no token yet, and prices each one two independent ways from the protocols whose tokens already trade — then shows its own backtest.

## How it works

A protocol with no token has no market price, so the model builds one from the snapshot's 128 traded protocols, twice:

- **Peer multiples.** For every category, the median market-cap-to-TVL multiple of the traded protocols in it (ratios winsorised to 0.01–10; sparse categories are shrunk toward the market-wide median of 0.214, and categories with too few traded peers fall back to it entirely). Price = TVL × the multiple.
- **A fitted size curve.** A least-squares line through every traded protocol, log(market cap) = 6.965 + 0.522 × log(TVL) — a slope under 1, so size is discounted. A category with at least 8 traded peers gets its own intercept on that line, shrunk toward the market's.
- **The blend.** Implied value is the geometric mean of the two prices, adjusted by three factors from the protocol's own record: 7-day TVL growth, years running without a token, and the number of chains it runs on. The two prices, adjusted the same way, are kept as a per-protocol **value range**.
- **The backtest.** The model is validated by leave-one-out over all 128 traded protocols: each is priced by the model fitted without it and set against its real market cap. The ensemble's median error is 89.8%, with 21.1% of protocols priced within 2× of the truth (peer multiples alone: 98.1% and 18.8%; the size curve alone: 86.7% and 31.3%). The dashboard's model page shows the full table and a fitted-versus-actual scatter.
- Derivative and exchange products (bridges, liquid staking, CEX products, wrapped/staked names, versioned pools) are excluded — they are products of tokens that already exist, not launch candidates.

On the sealed snapshot this ranks **198 pre-token protocols** and covers all **40 watchlist protocols**. Every protocol also gets a **farm plan** — concrete actions with costs and time, drawn from 14 category playbooks (lending, DEX, yield, derivatives, CDP, RWA, prediction markets, and more), with position sizes scaled to the protocol's TVL tier, and a closing line that adds the plan up: total fees, capital put to work, and total time.

## Outputs

- `board.json` — the ranked board: implied value, the full two-method breakdown and value range per protocol, its farm plan totals, and its farm steps.
- `dashboard/` — an offline dashboard that renders from the bundled data with no network: a sortable board, category and chain filters, a per-protocol detail view showing every factor in the score, and a model page with the method, the leave-one-out backtest, and the fitted-versus-actual scatter.
- `screenshots/` — the board, a detail view, and the model page.
- `dossier.json` — the run summary.

## Run it

Node 22, standard library only, no network. The run is deterministic — the only date it knows is the snapshot's own `as_of`.

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=d5a50dzy&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
