#!/usr/bin/env node
// Claude Code Stop hook. Two checks, both only when this session touched Meta ads writes:
//  1. The final message says something went live, but the ledger has no successful activate/budget write
//     for this session. Sent back: say what actually happened.
//  2. Writes were gated this session and the final message has no `handbrake:` status line. Sent back
//     with the line to paste. The human must see what the agent did to their money.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.CLAUDE_PLUGIN_ROOT || resolve(here, '..');
const lib = await import('file://' + join(root, 'skills', 'handbrake', 'scripts', 'handbrake.js').split('\\').join('/'));

export const LIVE_CLAIM = /\b(is|are|now|went|gone|it's|they're)\s+live\b|\bactivated\b|\bturned (it |them |the \w+ )?on\b|\blaunched\b|\bbudget[^.\n]{0,30}\b(raised|increased|bumped|scaled|doubled|set to)\b|\bresumed\b|\b(spend|spending|delivery)\b[^.\n]{0,20}\b(started|running|on)\b|\bnow (running|spending|delivering)\b/i;
export const EXEMPT = /\bnot (yet )?(live|activated|launched|resumed)\b|\bstill paused\b|\bremains? paused\b|\bwould (activate|launch|go live)\b|\bdid not (activate|launch|go live)\b|\bwas denied\b|\bno(thing)? went live\b/i;

export function check(input) {
  const cwd = input.cwd || process.cwd();
  const session = input.session_id || '';
  const rows = lib.readLedger(cwd).filter((r) => r.session === session && r.kind !== 'self');
  const gated = rows.filter((r) => r.decision && r.decision !== 'planned');
  if (!gated.length) return null;
  const msg = String(input.last_assistant_message || '');
  const live = rows.filter((r) => r.result === 'ok' && ['activate', 'budget'].includes(r.kind));
  if (LIVE_CLAIM.test(msg) && !EXEMPT.test(msg) && !live.length) {
    return `handbrake: your last message says something went live, but the ledger for this session shows no successful activation or budget change (${gated.length} gated call${gated.length === 1 ? '' : 's'}, ${rows.filter((r) => r.decision === 'deny').length} denied). Say what actually happened to spend, then end with the line from \`handbrake status\`.`;
  }
  if (!/handbrake:/.test(msg)) {
    return `handbrake: this session made ${gated.length} gated Meta ads call${gated.length === 1 ? '' : 's'}. End your message with the status line so the human sees what touched their money:\n${lib.statusLine(cwd, session)}`;
  }
  return null;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (d) => { raw += d; });
  process.stdin.on('end', () => {
    let input; try { input = JSON.parse(raw); } catch { process.exit(0); }
    if (input.stop_hook_active) process.exit(0);
    let reason = null;
    try { reason = check(input); } catch { reason = null; }
    if (!reason) process.exit(0);
    process.stderr.write(reason + '\n');
    process.exit(2);
  });
}
