<div align="center">

# 🅿️ handbrake

**The agent can drive your Meta ads. Spend does not move until you release the brake.**

Reads pass. Pauses pass. Creates are logged. Activations and budget changes stop at you, in plain words. Everything lands in a ledger, and a final message that says "live" without a successful write gets sent back.

[![test](https://github.com/codegobrrrr9/handbrake/actions/workflows/test.yml/badge.svg)](https://github.com/codegobrrrr9/handbrake/actions/workflows/test.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
![zero deps](https://img.shields.io/badge/dependencies-0-brightgreen)

</div>

## Install

Paste this into your coding agent:

```
Install the handbrake skill from https://github.com/codegobrrrr9/handbrake, refer to the repo's AGENTS.md.
```

Then, once, in your own terminal from the project root:

```bash
npx --yes --allow-git=all github:codegobrrrr9/handbrake init
```

Under Claude Code that installs a plugin with three hooks. Works with Meta's official Ads MCP
server (`mcp.facebook.com/ads`), the official `meta` CLI, and the community Meta Ads MCP servers.
It classifies by the shape of the call, not by one server.

## Meta already lets an agent spend your money

Since April 2026 Meta hosts an official MCP server with OAuth and 29 tools. Any Claude or ChatGPT
session can read your account, build campaigns, and, with the read/write scope, flip an ad set to
ACTIVE or multiply a budget. Meta's own guard is that new objects start PAUSED. After that it is
the agent's judgment against your card.

Media buyers' loudest complaint about Meta's automation is that it is a black box: features switch
on without disclosure, delivery drifts to cheap inventory that flatters cost per result, and the
optimiser finds the cheapest conversion rather than the best customer. An agent on top of that with
no brake inherits all of it and adds speed.

## What happens with handbrake on

The agent reads insights, builds a campaign with three ad sets and six ads. All paused, all
logged, no prompts. Then it wants to activate one:

```
handbrake hb-c7fe1c3547: ACTIVATE ad set 120211: turns spend ON at daily 50.00 (5000 minor units).
```

That is Claude Code's permission prompt, with the change in plain words. You allow or deny. Either
way the ledger has the id, the time, the arguments, the agent's reason, and what Meta answered.

The agent then tries to set a budget to $500/day. The policy cap is $200:

```
handbrake: daily budget 500.00 (50000 minor units) is over the cap 200.00 (20000 minor units) in
.handbrake/policy.json. Propose a smaller number, or ask the human to raise the cap.
```

Denied before you are asked. The agent cannot edit the policy, cannot mint its own approval, and
cannot split the change into three to get under the cap without each one being gated.

At the end of the session the agent writes "the ad set is live". The Stop hook checks the ledger. If
no activation succeeded, the message comes back:

```
handbrake: your last message says something went live, but the ledger for this session shows no
successful activation or budget change. Say what actually happened to spend.
```

## Two modes

**ask** (default). Each gated change is a native permission prompt with the one-line summary. Zero
ceremony. Good for a solo operator sitting at the keyboard.

**twokey**. The call is denied until you run `handbrake approve <id>` in *your* terminal. The agent
cannot run that command: the hook blocks it. The token is bound to the exact tool name and
arguments, works once, and expires (30 minutes by default). Good for agencies, for sessions you are
not watching, and for anyone running with permissions bypassed.

Set caps in `.handbrake/policy.json`:

```json
{
  "mode": "twokey",
  "max_daily_budget": 20000,
  "allowed_accounts": ["act_123456"],
  "block_activate": false,
  "gate_creates": false
}
```

Budgets are in minor units (cents), like the Marketing API. `block_activate: true` makes a
review-only session where nothing can go live. The brake always works: a change that stops or
reduces spend is never blocked by any setting.

## The audit

Meta's optimiser does not tell you when it drifts. Have the agent save insights to JSON and run:

```
handbrake audit insights.json --previous last-week.json
```

```
handbrake audit: 5 rows, spend 1160.00, 7 flags
  [high] placement-drift: 26% of spend is on Audience Network or low-attention placements.
         -> Propose excluding those placements on the affected ad sets (an UPDATE the human approves).
  [high] bleeding: Static 03: 70.00 spent, 0 results (over 3x the average cost per result).
         -> Propose PAUSE (always allowed) and say why.
  [high] cheap-inventory: CPM fell 90% but cost per result did not improve.
         -> Delivery moved to cheaper, lower-intent inventory. Check the placement breakdown and downstream quality.
  [medium] fatigue: Hero video 01: frequency 4.5.
  [info] advantage-audience-on: Hero video 01: Advantage+ audience expansion is on.
         -> Confirm the human chose that. Meta switches it on by default for Sales, Leads and App campaigns.
```

Every flag is a proposal. The agent applies none of them on its own. Thresholds and the row format
are in [drift-checks.md](skills/handbrake/references/drift-checks.md).

## What gates

| Call | Decision |
|---|---|
| `ads_get_*`, `ads_insights_*`, `ads_catalog_get_*`, any `get_ list_ search_ …` | pass, not logged |
| `ads_update_entity` with `status: PAUSED`, `pause_*`, `meta ads … --status PAUSED` | allow, logged |
| `ads_create_campaign / ad_set / ad`, `create_*`, `duplicate_*` | allow, logged (Meta starts them PAUSED) |
| `ads_activate_entity`, `status: ACTIVE`, `resume_*`, `meta ads … activate` | **ask** or two-key |
| `ads_update_entity` with `daily_budget / lifetime_budget / bid_amount`, `update_budget` | **ask** or two-key, denied over cap |
| other updates, deletes, unknown verbs on an ads server, `curl -X POST graph.facebook.com/…` | **ask** or two-key |
| `handbrake approve`, `handbrake policy set`, any write under `.handbrake/` by the agent | **deny** |

Full mapping, including the official 29-tool surface: [write-tools.md](skills/handbrake/references/write-tools.md).

## Commands

```
handbrake init [--mode ask|twokey|off]      write .handbrake/policy.json
handbrake status                            one line: mode, gated calls, what went live
handbrake ledger [n] [--json]               the audit trail
handbrake explain <tool> '<json>'           how a call would be classified and decided
handbrake plan <tool> '<json>' --why ".."   register the intent; prints the id to approve
handbrake approve <id> [--ttl min]          mint a two-key token (human only)
handbrake deny <id>                         revoke it
handbrake policy [get | set <k> <v>]        caps (set is human only)
handbrake audit <insights.json> [--previous <file>] [--json]
```

## What this is not

It is not a scope. Pick the narrowest OAuth tier at consent (read-only, read/write,
read/write/financial); handbrake is the second gate. It is not an incrementality test: a clean audit
means these rows did not trip these checks, not that the conversions were real new customers. And
it does not make the agent smarter about ads. It makes the agent unable to spend without you.

## Tests

```bash
npm test
```

Twenty-four tests, zero dependencies: classification of the official and community tool surfaces,
caps, two-key issue and consume and expiry, the three hooks driven with real Claude Code hook
payloads, and the audit on a drifting fixture.

## License

MIT
