# flightdeck

A live agent dashboard in a pane beside the transcript. Everything on it comes from real session events: the main model's vitals, the on-call architect, every permission check, subagent cards and swimlanes, a turn receipt and a session log.

```
/flightdeck                    open the pane
/flightdeck close              close it
/flightdeck reset              clear everything but the main model and mode
/flightdeck layout <layout>    auto, compact, wide or mini
```

Focus the pane with `ctrl+x tab`. `1` to `6` expand an agent card; `f`, `s` and `o` open the gate's file, shell and other rows.

The pane opens when a session starts, and resets on `/clear`.

## Panels

| Panel | What it shows |
| --- | --- |
| `main` | Model, effort, permission mode and step count; context and cost gauges, rate limits, compactions |
| `architect` | Consults of the on-call architect on a timeline, the moment of each, and the last advice |
| `gate` | Every permission check, bucketed into file, shell and other, counted as rule, ask, cleared or deny |
| `agents` | A card per subagent: model, steps, context, output tokens, its last three tools and a running clock. More than `maxCards` agents switch to swimlanes |
| `loops` | Other model loops seen in the session (forks, side queries), active while they stepped in the last 15 s |
| `receipt` | The last turn: how long it took, agents spawned, edits, errors and what it cost |
| `log` | The last 60 lines worth a glance: prompts, spawns, edits, errors, denials, consults |

### The architect

An agent type or server tool whose name matches `architectPattern` counts as the architect, so its runs show as consults rather than cards. Each consult is tagged with the moment it was asked at, inferred from the turn so far:

- `before a plan`: no edits yet this turn
- `error repeats`: two or more tool errors in a row
- `before done`: after edits

A background architect's report, handed back through `SubagentHandback`, becomes its advice line.

### Status line

`ctx 42% · agents 1/3 · architect 2 · denied 1`. Only fields with something to say are shown.

## How it works

It is a function-hooks plugin (`hooks/register.tsx`):

- `session.start`: registers `/flightdeck`, reads `$.session.usage`, opens the pane.
- `turn.start`, `turn.step`, `turn.complete`: main model and effort, per-agent steps and tokens, the turn receipt.
- `agent.offer`, `agent.spawn`: which agent types are the architect; a card for every other subagent.
- `tool.check`, `tool.call`: the gate's verdicts and how asks settled; tool lines on cards; edits and errors.
- `session.append`: server-side architect tools, which never reach `tool.call`.
- `session.measure`, `session.compact`: context, cost, rate limits and compactions.
- `ui.render` on `Pane`: draws it. `rail.tsx` and `elapsed.tsx` animate the connectors and tick the clocks on the surface's own frame clock, so the pane itself does not redraw.

State lives in plugin atoms. The reducers, formatting and layout math are pure functions in `hooks/core.ts`, tested in `tests/flightdeck.test.ts`. Commands, paths and patterns shown on the pane are redacted.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `panels` | `main,architect,gate,agents,loops,receipt,log` | Panels in display order; leave one out to hide it |
| `layout` | `auto` | `auto`: a summary of at most 8 rows inline above the prompt, two columns from 110 columns when docked, one otherwise. Or `compact`, `wide`, `mini` |
| `palette` | `theme` | `theme` follows your Claude Code theme; `pastel` is fixed colours for dark terminals |
| `motion` | `while-active` | Animate the connectors while work flows, or `off` |
| `maxCards` | `3` | Agent cards side by side before switching to swimlanes (1-6) |
| `architectPattern` | `advisor\|architect` | Case-insensitive regex for agent types and server tools that count as the architect |
| `architectLabel` | `ARCHITECT` | Name shown for the architect |
| `gateLabel` | `GATE` | Name shown for the permission panel |
| `moments` | `true` | Show the inferred moment of each consult |
| `matchDescriptions` | `false` | Also match `architectPattern` against an agent type's description |
| `openOnStart` | `true` | Open the pane when a session starts |
| `statusLine` | `true` | Show context, agents, consults and denials in the status line |

## Tests

```sh
claude plugin test .
```
