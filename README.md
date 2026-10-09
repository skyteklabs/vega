# vega

The **skyteklabs** plugin marketplace for [Claude Code](https://claude.com/claude-code), maintained by SkyTek Labs.

A marketplace is a git repository with a `.claude-plugin/marketplace.json` manifest that lists installable plugins. Add it once, then install any plugin it lists.

## Add the marketplace

Inside Claude Code:

```sh
/plugin marketplace add skyteklabs/vega
```

Then install a plugin from it:

```sh
/plugin install model-router@skyteklabs
/plugin install flightdeck@skyteklabs
/plugin install next-steps@skyteklabs
/plugin install burner@skyteklabs
/plugin install skytek@skyteklabs
```

Pick a scope when asked (user scope loads the plugin in every session). Run `/plugin` to browse, enable, disable, or update installed plugins.

To work on a plugin from a local checkout instead:

```sh
claude --plugin-dir ./plugins/model-router
```

## Plugins

| Plugin | Version | Description |
|---|---|---|
| [`model-router`](plugins/model-router) | 0.1.0 | Picks the model and reasoning effort per task using Jev, TypeSafe's System One decision model |
| [`flightdeck`](plugins/flightdeck) | 0.1.0 | Live agent dashboard: main-model vitals, on-call architect, permission checks, subagent cards and swimlanes, turn receipt, session log |
| [`next-steps`](plugins/next-steps) | 1.0.0 | Suggests up to three next prompts above the input after each turn; press `1`–`3` to draft one |
| [`burner`](plugins/burner) | 0.2.0 | Live session cost odometer above the prompt: a burning fuse, real-world comparisons, threshold alerts |
| [`skytek`](plugins/skytek) | 0.1.0 | Writes a Scope of Work from an RFP or an interview, as `.docx` and `.pdf` from one Word template |

The first four are function-hooks plugins (mods): a `hooks/hooks.json` points at a TypeScript module that Claude Code loads directly, with no build step and no `node_modules`. `skytek` is a skill plugin: a `SKILL.md` plus Python scripts run with `uv`.

### model-router

Classifies each prompt with [Jev](https://typesafe.ai) and routes it to a model tier and reasoning effort:

- **Tiers** — `fast` / `balanced` / `deep`, defaulting to `haiku` / `sonnet` / `opus`. Each accepts an alias or a full model id.
- **Effort** — `low` / `medium` / `high` / `xhigh`, from how much step-by-step reasoning the task needs.
- **Risk** — a task touching production, money, credentials, or irreversible state (`risky` > 0.7) goes to the deep tier with real reasoning.

Three switches control what it changes, all on by default:

| Switch | What it sets |
|---|---|
| `routeSubagentModel` | the model of each subagent, at `agent.spawn` |
| `routeMainEffort` | the reasoning effort of the main conversation, at `turn.step` |
| `routeMainModel` | the model of the main conversation, at `turn.step` |

Changing the main loop's model mid-session invalidates the prompt cache. On long contexts the re-cache can cost more than the cheaper tier saves; turn `routeMainModel` off if that matters for your sessions.

**Backends.** `typesafe` (TypeSafe's API, reports calibrated confidence), `gateway` (Vercel AI Gateway), or `builtin` (Claude Code's own `$.model.classify`). `provider: "auto"` picks whichever key is set, preferring TypeSafe. With no key the plugin still works on the built-in classifier and nothing leaves the machine.

**Fail-open.** Raising spend needs confidence ≥ 0.3; lowering it needs ≥ 0.6. Any error, timeout, or malformed response leaves the request untouched — the router never blocks a turn.

**Configure** in `/config`, or in `~/.claude/settings.json`:

```json
{ "pluginConfigs": { "model-router": { "options": { "typesafeApiKey": "" } } } }
```

`typesafeApiKey` can also come from the `TYPESAFE_API_KEY` environment variable. Get a key at [console.typesafe.ai](https://console.typesafe.ai).

See the [plugin README](plugins/model-router/README.md) for every option, the decision policy, transcript log lines, troubleshooting, and privacy details.

### flightdeck

A live dashboard pane fed only by real session events (`turn.step`, `tool.check`, `tool.call`, `agent.spawn`, `session.measure`, `session.compact`, …). Panels, in default order:

| Panel | Shows |
|---|---|
| `main` | model, effort, permission mode, steps, context and cost gauges, rate limits |
| `architect` | consults of the on-call architect (agent types or server tools matching `architectPattern`), with the inferred moment of each |
| `gate` | every permission check, bucketed into file / shell / other, by rule, ask, cleared, deny |
| `agents` | a card per subagent; more than `maxCards` switches to swimlanes |
| `loops` | active loops |
| `receipt` | last turn's duration, agents, and cost |
| `log` | the last 60 session log lines |

`/flightdeck [open|close|reset|layout auto|compact|wide|mini]` controls the pane. Focus it with `ctrl+x tab`; `1`–`6` expand cards, `f`/`s`/`o` open the gate rows. A status line shows context %, running agents, consults, and denials.

Options (`/config`): `panels`, `layout`, `palette` (`theme` or `pastel`), `motion`, `maxCards`, `architectPattern`, `architectLabel`, `gateLabel`, `moments`, `matchDescriptions`, `openOnStart`, `statusLine`. See the [plugin README](plugins/flightdeck/README.md) for defaults, the architect's moments, and how it works.

### next-steps

After each turn, forks the session with `$.model.fork` (sharing the prompt cache, so about one short reply) to propose up to three next prompts, drawn above the input:

```
next:
  1: run the tests you just wrote
  2: do the same for the settings page
  3: /code-review high
  0: dismiss
```

Press `1`, `2` or `3` from an empty prompt box to write that prompt in as an editable draft; `0` dismisses. The top suggestion also appears as ghost text, so Tab takes it. It never submits a prompt itself. Suggestions can be skills or slash commands the session actually has; ones naming a missing command are dropped.

Options: `minAnswerChars` (default `80`) and `suggestSkills` (default `true`). See the [plugin README](plugins/next-steps/README.md).

### burner

A cost odometer above the prompt, read from `$.session.usage()` every second. The fuse fills with the 5-hour subscription window when there is one, otherwise with the session's spend. Each figure is also shown as burritos or McDoubles (or Indonesian foods), and a toast fires once per session at $1, $5, $10, $25 and $50 (in rupiah: Rp 20.000, Rp 50.000, Rp 100.000, Rp 500.000 and Rp 1.000.000).

`/burn` opens a pane with the per-model token tally, the 5-hour and weekly windows, and the cost of the last 12 turns. `/burn [panel|show|hide|demo|lifetime]`: `hide` and `show` toggle the band, `demo` ramps from zero to $30 (Rp 489.000 at the default rate) in 20 seconds, `lifetime` prints spend across all sessions.

Options: `language` (`id` for Bahasa Indonesia or `en`, default `id`), `currency` (`idr` for Rp or `usd`, default `auto` to follow the language; display only, the math stays in dollars) and `comparisons` (`us` for burritos and McDoubles, `id` for nasi padang, bakso and es teh manis, default `auto` to follow the language). The rupiah rate is `idrPerUsd` (default `16300`), or, with an `exchangeRateApiKey` from the free [exchangerate-api.com](https://www.exchangerate-api.com) plan, the live rate, fetched once per new session and cached. See the [plugin README](plugins/burner/README.md).

### skytek

The `create-sow` skill turns an RFP into a Scope of Work:
- **Input:** a PDF, docx, txt or md RFP, or nothing, in which case it interviews you for every field.
- **Gaps:** it asks only for what the RFP leaves open, and never guesses pricing, payment or legal terms.
- **Review:** it shows every value for your approval before writing anything.
- **Output:** it fills one docxtpl Word template and writes `.docx`, `.pdf` and a `.sow.json` you can edit and re-render.

```sh
/skytek:create-sow ~/Downloads/acme-rfp.pdf
```

The PDF comes from LibreOffice (headless) or Microsoft Word. With neither installed you get the `.docx` and an offer to install LibreOffice. Requires [`uv`](https://docs.astral.sh/uv/).

Options: `outputDir` (default `./sow`), `templatePath` (your own template), and the vendor defaults `vendorName`, `vendorAddress`, `vendorSignatoryName` and `vendorSignatoryTitle`. See the [plugin README](plugins/skytek/README.md) for the template rules and the field list.

## Repository layout

```
.claude-plugin/marketplace.json   marketplace manifest (name: skyteklabs)
plugins/
  model-router/
    .claude-plugin/plugin.json    plugin manifest and userConfig schema
    hooks/                        hook module (register.tsx) and policy (policy.ts)
    tests/                        policy and router tests
  flightdeck/
    .claude-plugin/plugin.json    plugin manifest and userConfig schema
    hooks/                        register.tsx (hooks, pane), core.ts (pure reducers and layout), rail.tsx, elapsed.tsx
    types/                        shared state types
    tests/                        core tests
  next-steps/
    .claude-plugin/plugin.json    plugin manifest and userConfig schema
    hooks/register.tsx            hook module
    tests/                        suggestion, press, fork and text-cleaning tests
  burner/
    .claude-plugin/plugin.json    plugin manifest and userConfig schema
    hooks/                        register.tsx (hooks, band, pane), burn.ts (pure helpers)
    types/                        shared state types
    tests/                        helper and exchange-rate hook tests
  skytek/
    .claude-plugin/plugin.json    plugin manifest and userConfig schema
    skills/create-sow/            SKILL.md, scripts/ (render, extract, template builder), assets/ (template, schema, sample)
    tests/                        pytest render tests (uv run --with pytest pytest plugins/skytek/tests)
```

## Testing

From a plugin directory:

```sh
claude plugin test .
```

`skytek` is Python: `uv run --with pytest pytest plugins/skytek/tests`.

## Adding a plugin

1. Create `plugins/<name>/` with a `.claude-plugin/plugin.json`.
2. For a mod, add `hooks/hooks.json` (`{ "modules": ["./register.tsx"] }`) and the module it names. For a skill, add `skills/<skill-name>/SKILL.md`.
3. Add an entry to `.claude-plugin/marketplace.json`:

   ```json
   { "name": "<name>", "source": "./plugins/<name>", "description": "..." }
   ```

4. Users pick it up with `/plugin marketplace update skyteklabs`.

## Requirements

Claude Code 2.1.287+ (plugin hook modules on by default).

## License

[MIT](LICENSE) © 2026 SkyTek Labs
