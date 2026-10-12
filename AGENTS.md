# handbrake — instructions for coding agents

You are reading this because a user pasted something like:

> Install the handbrake skill from https://github.com/codegobrrrr9/handbrake, refer to the repo's AGENTS.md.

Do the install for the agent you are, confirm in one line, then follow the rules below for the rest
of the session. Do not explain what handbrake is unless asked.

## Install

`<repo>` is a clone of this repository, or the raw files fetched from
`https://raw.githubusercontent.com/codegobrrrr9/handbrake/main/`.

| Agent | Do this |
|-------|---------|
| Claude Code | Run `/plugin marketplace add codegobrrrr9/handbrake` then `/plugin install handbrake@handbrake`. The plugin ships four hooks: Meta ads reads pass, pauses pass, creates are logged, activations and budget changes stop at a permission prompt (or need a two-key token), and a final message that says "live" without a successful write in the ledger is sent back. If plugins are unavailable, copy `<repo>/skills/handbrake/` to `~/.claude/skills/handbrake/` and add the hooks block below to `~/.claude/settings.json`. |
| Codex | Copy `<repo>/skills/handbrake/` to `~/.codex/skills/handbrake/`, or run `npx skills add codegobrrrr9/handbrake`. Append the **Rules** below to the project's `AGENTS.md`. Before any write, run `node <path>/handbrake.js explain <tool> '<json>'` and show the human the summary. |
| Cursor | Copy `<repo>/.cursor/rules/handbrake.mdc` to `.cursor/rules/handbrake.mdc` and `<repo>/skills/handbrake/scripts/handbrake.js` to `scripts/handbrake.js` in the project. |
| Gemini CLI | Run `gemini extensions install https://github.com/codegobrrrr9/handbrake`. |
| GitHub Copilot | Copy `<repo>/.github/copilot-instructions.md` into the project's `.github/` (merge if one exists). |
| Anything else | Append the **Rules** below to the instruction file the agent reads, keep `handbrake.js` in the project, and run `explain` before every write. |

Then ask the human to run, once, in their own terminal from the project root:

```
node <skill>/scripts/handbrake.js init            # ask mode: a prompt per gated change
node <skill>/scripts/handbrake.js init --mode twokey   # or: the human mints a token per change
```

and to edit `.handbrake/policy.json` for caps (`max_daily_budget` in minor units, `allowed_accounts`,
`block_activate`). You never edit that file.

Hooks block for a non-plugin Claude Code install (`~/.claude/settings.json`), with `<repo>` the cloned repo:

```json
{
  "hooks": {
    "PreToolUse": [{ "matcher": "Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*", "hooks": [{ "type": "command", "command": "node \"<repo>/hooks/pre-tool-use.js\"", "timeout": 10 }] }],
    "PostToolUse": [{ "matcher": "Bash|mcp__.*", "hooks": [{ "type": "command", "command": "node \"<repo>/hooks/post-tool-use.js\"", "timeout": 10 }] }],
    "PostToolUseFailure": [{ "matcher": "Bash|mcp__.*", "hooks": [{ "type": "command", "command": "node \"<repo>/hooks/post-tool-use.js\"", "timeout": 10 }] }],
    "Stop": [{ "hooks": [{ "type": "command", "command": "node \"<repo>/hooks/stop.js\"", "timeout": 15 }] }]
  }
}
```

After installing, say: `handbrake on. I can read, build and pause; nothing goes live or changes budget without you.`

## Rules

You can drive. The brake stays on until the human releases it.

1. **Reads are free.** Insights, entities, benchmarks, catalogs: call them when they help.
2. **Pausing is always allowed.** Anything that stops or reduces spend goes through at once. Bleeding? Pause first, explain second.
3. **Create freely, PAUSED.** Meta creates community-server objects paused and official-server objects as unpublished drafts. Build the structure, then propose activation. Never pass `status: ACTIVE` on a create.
4. **Activation and budget changes stop at the human.** Say in one line what the change does to spend (entity, direction, amount per day, why) before the call. In `twokey` mode the human runs `handbrake approve <id>` in *their* terminal; then you call the tool again with exactly the same arguments.
5. **Caps are the human's.** A denial for `max_daily_budget`, `allowed_accounts` or `block_activate` means propose inside the cap or tell the human how to change the policy. Never split one change into several to get under a cap.
6. **Never touch `.handbrake/`** by any tool or command.
7. **One change, one call, as shown.** The approval is bound to the tool name and arguments. Change an argument and it is a new change.
8. **Drift is reported as proposals.** Save insights to JSON, run `handbrake audit <file>`, and offer each flag for approval.
9. **End every done message with the line from `handbrake status`.** Never say "live", "activated" or "scaled" unless the ledger shows that write succeeded.
10. **Name Meta's defaults.** Advantage+ audience, placements and budget are on by default for Sales, Leads and App campaigns. When you see them on, say so.

## Commands

```
handbrake init [--mode ask|twokey|off]    human, once
handbrake status                          one line: mode, gated calls, what went live
handbrake ledger [n]                      audit trail
handbrake explain <tool> '<json>'         classify and decide without doing anything
handbrake plan <tool> '<json>' --why ".." register intent; prints the id the human approves
handbrake audit <insights.json> [--previous <file>]
handbrake approve <id> · deny <id> · policy set <k> <v>   HUMAN ONLY
```

## Overrides

- The human says "just do it, no prompts" for this session: ask them to run `handbrake policy set mode off` themselves. Caps still apply. Still end with the status line.
- The human wants a review-only session: ask them to set `block_activate` to true. Then nothing you do can go live, and you say so up front.
