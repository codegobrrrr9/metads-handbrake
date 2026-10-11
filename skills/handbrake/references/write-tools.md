# What gates, and why

handbrake classifies by tool shape, not by one server. It gates any MCP tool whose server name
looks like ads tooling (`meta`, `facebook`, `fb`, `ads`, `marketing`, `pipeboard`) or whose bare tool
name starts with `ads_`, plus `Bash` commands that invoke the official `meta ads` CLI or POST to
`graph.facebook.com`.

## Official Meta Ads MCP (`https://mcp.facebook.com/ads`, beta since 29 Apr 2026)

Six write tools out of 29. Meta creates everything PAUSED; a human has to activate.

| Tool | handbrake kind | Default decision |
|---|---|---|
| `ads_create_campaign` | create | allow + log (`gate_creates: true` to prompt) |
| `ads_create_ad_set` | create | allow + log |
| `ads_create_ad` | create | allow + log |
| `ads_catalog_create` | create | allow + log |
| `ads_update_entity` | depends on args: `status: ACTIVE` → activate; `status: PAUSED/ARCHIVED` → deescalate; `daily_budget`/`lifetime_budget`/`bid_amount` → budget; else update | activate/budget/update → ask (or twokey); deescalate → allow |
| `ads_activate_entity` | activate | ask (or twokey); denied if `block_activate` |

The other 23 (`ads_get_*`, `ads_insights_*`, `ads_catalog_get_*`, `ads_get_opportunity_score`,
`ads_get_help_article`, …) are reads and pass silently.

OAuth tiers at consent time: read-only, read/write, read/write/financial. Pick the narrowest the
task needs; handbrake is a second gate, not a replacement for scope.

## Official CLI (`pip install meta-ads-cli`, command `meta`)

`meta ads <object> <verb> …`. handbrake reads the verb and flags:
`activate|resume|enable` or `--status ACTIVE` → activate; `pause|archive|stop` or `--status PAUSED`
→ deescalate; `create` → create; `update|set|edit` with `--daily-budget`/`--lifetime-budget` →
budget, otherwise update; `delete` → delete; anything else → read.

## Community servers (pipeboard, jeffreywlai, attainmentlabs, serkanhaslak, …)

Matched by verb prefix on the bare tool name:

- read: `get_ list_ fetch_ search_ insights_ report_ preview_ estimate_ describe_ analyze_ …`
- create: `create_ add_ duplicate_ copy_ clone_ upload_ generate_`
- deescalate: `pause_ stop_ archive_ disable_ turn_off_`
- activate: `activate_ resume_ enable_ launch_ start_ publish_ unpause_`
- delete: `delete_ remove_ destroy_`
- update: `update_ set_ edit_ modify_ change_ patch_ adjust_ scale_ increase_ decrease_ bulk_update_`
  then refined by args (`status`, budget keys) exactly like `ads_update_entity`.
- anything else on an ads server: `unknown-write`, treated as a live change and gated.

## Budget units

The Marketing API takes budgets in minor units (cents). `policy.budget_unit` defaults to `minor`
and summaries print both: `daily 50.00 (5000 minor units)`. If a server takes dollars, set
`"budget_unit": "major"` so the cap compares like with like.

## The fingerprint

`hb-` + first 10 hex of sha256(bare tool name + canonical JSON of the arguments). Same change, same
id, in `explain`, `plan`, the hook and the ledger. Change one argument and it is a different change.
