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

**Requires** Claude Code 2.1.287+ (plugin hook modules on by default).

See the [plugin README](plugins/model-router/README.md) for every option, the decision policy, transcript log lines, troubleshooting, and privacy details.

## Repository layout

```
.claude-plugin/marketplace.json   marketplace manifest (name: skyteklabs)
plugins/
  model-router/
    .claude-plugin/plugin.json    plugin manifest and userConfig schema
    hooks/                        hook module (model-router.ts) and policy (policy.ts)
    tests/                        policy and router tests
```

## Adding a plugin

1. Create `plugins/<name>/` with a `.claude-plugin/plugin.json`.
2. Add an entry to `.claude-plugin/marketplace.json`:

   ```json
   { "name": "<name>", "source": "./plugins/<name>", "description": "..." }
   ```

3. Users pick it up with `/plugin marketplace update skyteklabs`.

## License

[MIT](LICENSE) © 2026 SkyTek Labs
