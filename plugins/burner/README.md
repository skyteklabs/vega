# burner

A live session cost odometer above the prompt box: a burning fuse, real-world comparisons, and threshold alerts.

```
BAKAR       ▂▄▆█▇▅▃   Rp 69.601 = 2,8 porsi nasi padang
5j 42% 2j 14m lagi    opus 5.5 1.2M in 84k out
mg 18% 3hr 4j lagi     total Rp 995.604  sembunyikan
```

By default burner speaks Bahasa Indonesia and shows money in rupiah. Set `language` to `en` for English, dollars and burritos.

The figure eases toward the session's real cost. Every six seconds the comparison switches between burritos ($11) and McDoubles ($3.19), or Indonesian foods (see [Options](#options)). The fuse fills with the 5-hour subscription window when there is one; on an API key it fills with the spend instead, log-scaled from $1 to $100, or, when money shows in rupiah, from Rp 10.000 to Rp 1.000.000. It turns orange past 45% and red past 75%.

A toast fires the first time the spend crosses $1, $5, $10, $25 and $50, or, when money shows in rupiah, Rp 20.000, Rp 50.000, Rp 100.000, Rp 500.000 and Rp 1.000.000. Rupiah thresholds are converted to dollars at the rupiah rate before the spend is compared against them; each fires once per session by its rupiah amount, so a rate that changes mid-session does not fire it again. What fired is kept in `$.store` by session id, so a resumed session does not replay the alerts below its cost.

## Command

| Command | What it does |
| --- | --- |
| `/burn`, `/burn panel` | Open the pane and print this session's cost, the subscription windows, lifetime spend and the per-model tally |
| `/burn show` | Bring the band back and print the same summary without opening the pane |
| `/burn hide` | Hide the band (so does its `hide` button) |
| `/burn demo` | Ramp from zero to $30 (Rp 489.000 at the default rate) in 20 seconds, hold for 6 seconds, then go back to the real cost |
| `/burn lifetime` | Print spend across all sessions |

The pane shows the session cost on a taller fire, the 5-hour and weekly windows with their reset times, and a bar per turn for the last 12 turns, the costliest one in orange.

## How it works

It is a function-hooks plugin (`hooks/register.tsx`):

- `session.start`: registers `/burn` and reads `$.session.usage()` every second. The cost comes from `cost.usd`, and the windows come from the `five_hour` and `seven_day` entries of `rateLimits`.
- `prompt.submit` and `turn.complete`: record the cost of each turn and add the turn's tokens to the per-model tally. Input tokens include cache reads and writes.
- `ui.render` on `AbovePrompt`: draws the band. It does not draw while a survey is open or before there is a cost or window to show.
- `ui.render` on `Pane`: draws the pane.

Lifetime spend is kept in `$.store` and only counts new spend, so reopening a session does not add its cost twice. Cost readings run one at a time, and timer ticks during a slow reading join a single queued one. The store keeps each session's last reading and fired alerts for the 100 most recent sessions; resuming an older one counts its cost again.

The animated fire is a `Raster` and only draws in the terminal. Other surfaces show a plain `█░` bar.

The pure helpers (money formatting, comparisons, thresholds, the tween, the fire cells, and each language's text) live in `hooks/burn.ts`.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `language` | `id` | Language of the band, the pane, the toasts and `/burn`: `id` (Bahasa Indonesia) or `en` (English) |
| `currency` | `auto` | What money shows in: `idr` (Rp), `usd` ($), or `auto` to follow `language` |
| `comparisons` | `auto` | What the spend is compared to: `us` (burritos, McDoubles), `id` (nasi padang, bakso, es teh manis), or `auto` to follow `language` |
| `exchangeRateApiKey` | empty | Free key from [exchangerate-api.com](https://www.exchangerate-api.com) for the live rupiah rate; overrides `idrPerUsd`. Falls back to the `EXCHANGERATE_API_KEY` environment variable |
| `idrPerUsd` | `16300` | Rupiah per dollar when no key is set |

`currency` is display only. The session cost arrives in dollars from `$.session.usage()`, and every sum, per-turn figure and stored total is kept in dollars. Only the text converts, at the rupiah rate: whole rupiah with dots between thousands (`Rp 69.601`), or two decimals with a comma under Rp 10 (`Rp 6,52`).

The Indonesian prices are in rupiah (nasi padang Rp 25.000, bakso Rp 20.000, es teh manis Rp 5.000) and convert to dollars at the same rate:

- **With a key**, the live rate is fetched from `https://v6.exchangerate-api.com/v6/<key>/latest/USD` once per new session, at `session.start`, and cached in `$.store`. A resumed session with the same id reuses the cache without a request. If the request fails or takes more than 3 seconds, the last cached rate is used if it is under 30 days old, then `idrPerUsd`. The failure goes to the session log with the key replaced by `***`. The first cost reading waits for the rate, so the first alerts already use it; after a hot reload the next reading picks the rate up again from the cache.
- **Without a key**, `idrPerUsd` is used and nothing is fetched.

Nothing is fetched when neither rupiah money nor the Indonesian foods are shown.

In Indonesian the comparison uses a decimal comma: `= 1,3 porsi nasi padang`. The `/burn` subcommands keep their English names in both languages.

## Tests

`tests/burn.test.ts` covers the helpers in `hooks/burn.ts`: money formatting, comparisons in both languages, options, exchange-rate replies, thresholds, key redaction, the fuse heat, the tween, lifetime deltas, fire cells, the text bar, subscription windows and the per-model tally.

`tests/rate.test.ts` drives the hooks against a faked exchange-rate API, store and environment: the manual rate, the live rate overriding it, the key from the environment, the per-session cache, and the fallbacks when a request fails, the key kept out of the log, stale cached rates, a resumed session not replaying its alerts, overlapping cost readings, a hung reading not holding a turn, and the session cap.

```sh
claude plugin test .
```
