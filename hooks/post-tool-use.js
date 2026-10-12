#!/usr/bin/env node
// Claude Code PostToolUse hook (matcher: Bash|mcp__.*). After a gated write runs, record what happened:
// ok or error, and any entity ids Meta returned. The ledger is the audit trail the human reads later.
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.CLAUDE_PLUGIN_ROOT || resolve(here, '..');
const lib = await import('file://' + join(root, 'skills', 'handbrake', 'scripts', 'handbrake.js').split('\\').join('/'));

export function outcome(resp) {
  const str = typeof resp === 'string' ? resp : JSON.stringify(resp ?? '');
  const head = str.slice(0, 1200);
  const isErr = !!(resp && typeof resp === 'object' && (resp.isError || resp.is_error))
    || (resp && typeof resp === 'object' && typeof resp.exit_code === 'number' && resp.exit_code !== 0)
    || /"error"\s*:\s*[{"]|OAuthException|\(#\d{2,4}\)|Error validating|Invalid parameter|Permissions error|Unsupported (post|get) request/i.test(head);
  // MCP responses wrap JSON in a text string, so quotes may be escaped: \"id\":\"123\"
  const ids = [...new Set([...str.matchAll(/\\?"(?:id|campaign_id|adset_id|ad_id)\\?"\s*:\s*\\?"?(\d{6,})/g)].map((m) => m[1]))].slice(0, 5);
  const detail = isErr ? head.replace(/\s+/g, ' ').slice(0, 240) : (ids.length ? 'ids ' + ids.join(', ') : head.replace(/\s+/g, ' ').slice(0, 120));
  return { result: isErr ? 'error' : 'ok', ids, detail };
}

export function handle(input) {
  const tool = String(input.tool_name || '');
  const args = input.tool_input || {};
  const cwd = input.cwd || process.cwd();
  const policy = lib.loadPolicy(cwd);
  const cls = tool === 'Bash' ? lib.classifyBash(args.command, policy) : tool.startsWith('mcp__') ? lib.classify(tool, args, policy) : null;
  if (!cls || !cls.gated || cls.kind === 'self') return null;
  // PostToolUseFailure delivers the error in `error` (no tool_response); PostToolUse delivers tool_response.
  const failed = input.hook_event_name === 'PostToolUseFailure' || (input.error != null && input.tool_response == null);
  const o = failed ? { result: 'error', ids: [], detail: String(typeof input.error === 'string' ? input.error : JSON.stringify(input.error ?? 'tool failed')).replace(/\s+/g, ' ').slice(0, 240) } : outcome(input.tool_response);
  // Decide "live" before appending this row, or the publish would see itself as the latest write.
  const live = o.result === 'ok' && (['activate', 'budget'].includes(cls.kind) || (cls.kind === 'publish' && !lib.publishIsPause(cls, cwd)));
  lib.appendLedger(cwd, { session: input.session_id || '', id: cls.id, tool, kind: cls.kind, eid: cls.eid || null, summary: cls.summary, result: o.result, detail: o.detail, ids: o.ids });
  return {
    hookSpecificOutput: {
      hookEventName: failed ? 'PostToolUseFailure' : 'PostToolUse',
      additionalContext: `handbrake ${cls.id}: ${o.result}${live ? ' and LIVE: spend is now affected' : ''}. ${o.detail}`.trim(),
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
    try { out = handle(input); } catch { /* never break the session over logging */ }
    if (out) process.stdout.write(JSON.stringify(out));
    process.exit(0);
  });
}
