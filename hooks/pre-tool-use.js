#!/usr/bin/env node
// Claude Code PreToolUse hook (matcher: Bash|Edit|Write|MultiEdit|NotebookEdit|mcp__.*).
// Reads pass silently. Pauses always pass. Creates are logged (Meta starts them PAUSED).
// Activations, budget and status changes stop at the human: 'ask' (native prompt) or 'twokey' (token the
// human minted in their own terminal). Policy caps deny regardless. The agent cannot write into .handbrake/.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.CLAUDE_PLUGIN_ROOT || resolve(here, '..');
const lib = await import('file://' + join(root, 'skills', 'handbrake', 'scripts', 'handbrake.js').split('\\').join('/'));

export function handle(input) {
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const policy = lib.loadPolicy(cwd);
  let cls;
  if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool)) {
    const fp = String(args.file_path || args.notebook_path || '').split('\\').join('/');
    if (!/(^|\/)\.handbrake(\/|$)/.test(fp)) return null;
    cls = { gated: true, kind: 'self', id: lib.changeId(tool, { fp }), summary: 'approvals, policy and the ledger are written by the human, in their own terminal, never by the agent.' };
  } else if (tool === 'Bash') {
    cls = lib.classifyBash(args.command, policy);
  } else if (tool.startsWith('mcp__')) {
    cls = lib.classify(tool, args, policy);
  } else return null;
  const d = lib.decide(cls, policy, cwd);
  if (d.decision === 'pass') return null;
  lib.appendLedger(cwd, { session: input.session_id || '', id: cls.id, tool, kind: cls.kind, summary: cls.summary, decision: d.decision, reason: d.reason.split('\n')[0], account: cls.account || null, budgets: cls.budgets || {} });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: d.decision,
      permissionDecisionReason: d.reason,
    },
  };
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input; try { input = JSON.parse(raw); } catch { process.exit(0); }
    let out = null;
    try { out = handle(input); } catch (e) {
      // Fail closed only for things that look like ads writes; never break unrelated tools.
      const t = String(input.tool_name || '');
      if (t.startsWith('mcp__') && /ads|meta|facebook/i.test(t)) out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: `handbrake could not classify this call (${e.message}). Treating it as a live change.` } };
    }
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}
