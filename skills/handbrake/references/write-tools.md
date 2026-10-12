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

## Seen live (official server, 2026-10-12)

- Creates return ids but the objects are **drafts** (EDITING, unpublished) in Ads Manager, not paused
  objects. `ads_activate_entity` publishes the draft and its parents and sets it ACTIVE.
- `ads_activate_entity` arguments: `ad_account_id`, `entity_id`, `entity_type` (`ad_set`, …),
  `publish_as_active`, and `object_ids` (a list) when several drafts must be published together.
  Meta refuses to publish a child before its parent, so a first campaign goes out as campaign + ad set in one call.
- `ads_update_entity` arguments: `ad_account_id` (digits, no `act_`), `entity_id`, `entity_type`, and
  `fields` as a **JSON string**, e.g. `"{\"status\":\"PAUSED\"}"` or `"{\"lifetime_budget\":5000}"`.
  handbrake expands JSON strings before classifying, so this is a pause and a budget change, not an opaque update.
- **Updates are drafts too.** A pause written with `ads_update_entity` leaves the ad set ACTIVE live
  until `ads_activate_entity` publishes it with `publish_as_active: false`. handbrake classifies that
  call as `publish`: allowed at once when the ledger shows the only successful pending change for
  every named object is a pause handbrake let through; otherwise treated as an activation and gated,
  because drafts can hold changes handbrake never saw (made in Ads Manager, for instance).
- Every call also carries telemetry (`advertiser_job`, `advertiser_request`, `client_conversation_id`,
  `client_model`) that differs per call. It is ignored for the fingerprint and the summary.
- A failed write surfaces to Claude Code as a tool error, which fires `PostToolUseFailure`, not
  `PostToolUse`. handbrake listens to both so failures land in the ledger.
- A plain lookup by id does not find a draft; the agent has to read drafts through the entity tools.
- The server requires `ads_get_field_context` before some reads; it is a read and passes.
- Advantage+ audience was on for a freshly created ad set without being asked for.

## The fingerprint

`hb-` + first 10 hex of a sha256 over the **meaning** of the change: kind (activate, budget, pause,
delete, update, create), entity id, account, budgets found at any depth, and status. Updates and
creates also carry their arguments with scalars normalised to strings and nulls dropped, because the
fields are the change. So a fresh agent session that writes `publish_as_active: "true"` instead of
`true`, adds a null, or reorders keys gets the same id as the one the human approved. A different
entity, account, amount or direction is a different id.
