---
description: What did the agent do to my Meta ads? Prints the handbrake status line and the recent ledger, or runs a drift audit on an insights file.
allowed-tools: Bash(node:*), Read
---

Report handbrake for this project.

1. Run `node ${CLAUDE_PLUGIN_ROOT}/skills/handbrake/scripts/handbrake.js status` from the project
   root (if that path does not exist, find `handbrake.js` under the installed handbrake skill).
   Then run `... ledger 10`. Pass through any arguments the user gave: $ARGUMENTS
   - `/handbrake audit <file>` runs `... audit <file>` instead and reports each flag as a proposal.
   - `/handbrake explain <tool> <json>` shows how a call would be classified without doing it.
2. Quote the status line exactly as printed, then the ledger rows in a short table: time, id,
   decision or result, kind, summary.
3. If anything was denied, say why in one line each (the reason is in the row). If a write failed,
   quote Meta's error. Never say something is live unless its row says `ok` with kind activate or
   budget.
