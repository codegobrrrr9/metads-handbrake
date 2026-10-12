# handbrake

Rules from https://github.com/codegobrrrr9/handbrake. The agent can drive the Meta ads account; spend does not move until the human releases the brake.

1. Reads are free. Pausing is always allowed. Creates are fine because they land paused or as unpublished drafts; never pass `status: ACTIVE` on a create.
2. Before any activation, budget or status change, run `node scripts/handbrake.js explain <tool> '<json>'` (copy `skills/handbrake/scripts/handbrake.js` from the repo to `scripts/handbrake.js`) and show the human the one-line summary. Do not call the write until they say yes to that exact change.
3. Never edit anything under `.handbrake/`. Caps are the human's. Never split a change to get under a cap.
4. Run `node scripts/handbrake.js audit <insights.json>` for drift; every flag is a proposal, not an action.
5. End every done message with the line from `node scripts/handbrake.js status`. Never say "live" unless the ledger shows the write succeeded.
