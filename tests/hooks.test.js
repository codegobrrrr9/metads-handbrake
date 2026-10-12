import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readLedger, approve, savePolicy, DEFAULT_POLICY, classify } from '../skills/handbrake/scripts/handbrake.js';

const here = dirname(fileURLToPath(import.meta.url));
const HOOKS = join(here, '..', 'hooks');
const fresh = () => mkdtempSync(join(tmpdir(), 'handbrake-h-'));
function run(hook, input, cwd) {
  const r = spawnSync(process.execPath, [join(HOOKS, hook)], { input: JSON.stringify({ cwd, session_id: 'sess-1', ...input }), encoding: 'utf8', cwd, env: { ...process.env, CLAUDE_PLUGIN_ROOT: join(here, '..') } });
  let out = null; try { out = r.stdout ? JSON.parse(r.stdout) : null; } catch { out = r.stdout; }
  return { code: r.status, out, err: r.stderr };
}
const pre = (input, cwd) => run('pre-tool-use.js', input, cwd);
const post = (input, cwd) => run('post-tool-use.js', input, cwd);
const stop = (input, cwd) => run('stop.js', input, cwd);
const decision = (r) => r.out?.hookSpecificOutput?.permissionDecision;

test('pre: reads and unrelated tools produce no output and no ledger', () => {
  const d = fresh();
  for (const input of [
    { tool_name: 'mcp__meta-ads__ads_get_ad_entities', tool_input: {} },
    { tool_name: 'mcp__meta-ads__ads_insights_performance_trend', tool_input: { account_id: 'act_1' } },
    { tool_name: 'mcp__github__create_issue', tool_input: { title: 'x' } },
    { tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { tool_name: 'Bash', tool_input: { command: 'meta ads campaign list' } },
    { tool_name: 'Write', tool_input: { file_path: join(d, 'notes.md'), content: 'x' } },
    { tool_name: 'Read', tool_input: { file_path: join(d, '.handbrake', 'ledger.jsonl') } },
  ]) { const r = pre(input, d); assert.equal(r.code, 0); assert.equal(r.out, null, JSON.stringify(input)); }
  assert.equal(existsSync(join(d, '.handbrake')), false);
  rmSync(d, { recursive: true, force: true });
});

test('pre: activation asks with a plain-English reason and is logged', () => {
  const d = fresh();
  const r = pre({ tool_name: 'mcp__meta-ads__ads_activate_entity', tool_input: { entity_id: '120211', entity_type: 'ADSET' } }, d);
  assert.equal(r.code, 0);
  assert.equal(decision(r), 'ask');
  assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /^handbrake hb-[0-9a-f]{10}: ACTIVATE adset 120211: turns spend ON\./);
  const L = readLedger(d);
  assert.equal(L.length, 1); assert.equal(L[0].decision, 'ask'); assert.equal(L[0].kind, 'activate'); assert.equal(L[0].session, 'sess-1');
  rmSync(d, { recursive: true, force: true });
});

test('pre: pause allowed, create allowed+logged, over-cap budget denied', () => {
  const d = fresh();
  assert.equal(decision(pre({ tool_name: 'mcp__meta-ads__ads_update_entity', tool_input: { entity_id: '1', status: 'PAUSED' } }, d)), 'allow');
  const cr = pre({ tool_name: 'mcp__meta-ads__ads_create_campaign', tool_input: { name: 'Q4', daily_budget: 3000 } }, d);
  assert.equal(decision(cr), 'allow'); assert.match(cr.out.hookSpecificOutput.permissionDecisionReason, /nothing runs until it is activated\. Logged/);
  assert.match(readLedger(d)[1].args, /"name":"Q4"/, 'arguments are kept for diagnosis');
  const over = pre({ tool_name: 'mcp__meta-ads__ads_update_entity', tool_input: { entity_id: '1', daily_budget: 999999 } }, d);
  assert.equal(decision(over), 'deny'); assert.match(over.out.hookSpecificOutput.permissionDecisionReason, /over the cap/);
  assert.equal(readLedger(d).length, 3);
  rmSync(d, { recursive: true, force: true });
});

test('pre: the agent cannot mint approvals, edit policy or touch the ledger', () => {
  const d = fresh();
  for (const input of [
    { tool_name: 'Bash', tool_input: { command: 'node skills/handbrake/scripts/handbrake.js approve hb-abc' } },
    { tool_name: 'Bash', tool_input: { command: 'handbrake policy set mode off' } },
    { tool_name: 'Bash', tool_input: { command: 'echo "{}" > .handbrake/approvals/hb-1.json' } },
    { tool_name: 'Write', tool_input: { file_path: join(d, '.handbrake', 'policy.json'), content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: '.handbrake/ledger.jsonl', old_string: 'a', new_string: 'b' } },
    { tool_name: 'Edit', tool_input: { file_path: 'C:\\proj\\.handbrake\\policy.json', old_string: 'a', new_string: 'b' } },
  ]) { const r = pre(input, d); assert.equal(decision(r), 'deny', JSON.stringify(input)); assert.match(r.out.hookSpecificOutput.permissionDecisionReason, /written by the human/); }
  rmSync(d, { recursive: true, force: true });
});

test('pre: twokey denies without a token and allows exactly once with one', () => {
  const d = fresh();
  savePolicy(d, { ...DEFAULT_POLICY, mode: 'twokey' });
  const input = { tool_name: 'mcp__meta-ads__ads_update_entity', tool_input: { entity_id: '1', daily_budget: 5000 } };
  const no = pre(input, d);
  assert.equal(decision(no), 'deny'); assert.match(no.out.hookSpecificOutput.permissionDecisionReason, /in THEIR terminal/);
  approve(d, classify(input.tool_name, input.tool_input).id, 30, 'yes');
  // A fresh session shapes the same change differently: string budget, extra null, different key order.
  const reshaped = { tool_name: 'mcp__meta-ads__ads_update_entity', tool_input: { daily_budget: '5000', entity_id: '1', entity_type: null } };
  const yes = pre(reshaped, d);
  assert.equal(decision(yes), 'allow'); assert.match(yes.out.hookSpecificOutput.permissionDecisionReason, /approved by the human \(yes\)/);
  assert.equal(decision(pre(input, d)), 'deny', 'token consumed');
  rmSync(d, { recursive: true, force: true });
});

test('pre: Bash meta CLI activation asks; pause via CLI allowed; raw Graph POST asks', () => {
  const d = fresh();
  assert.equal(decision(pre({ tool_name: 'Bash', tool_input: { command: 'meta ads adset update 123 --status ACTIVE' } }, d)), 'ask');
  assert.equal(decision(pre({ tool_name: 'Bash', tool_input: { command: 'meta ads adset update 123 --status PAUSED' } }, d)), 'allow');
  const g = pre({ tool_name: 'Bash', tool_input: { command: 'curl -X POST https://graph.facebook.com/v25.0/120211 -d status=ACTIVE' } }, d);
  assert.equal(decision(g), 'ask'); assert.match(g.out.hookSpecificOutput.permissionDecisionReason, /raw Marketing API call/);
  rmSync(d, { recursive: true, force: true });
});

test('post: records ok with ids, records errors, ignores reads', () => {
  const d = fresh();
  const base = { tool_name: 'mcp__meta-ads__ads_activate_entity', tool_input: { entity_id: '120211' } };
  const ok = post({ ...base, tool_response: { content: [{ type: 'text', text: '{"success":true,"id":"120211000111"}' }] } }, d);
  assert.match(ok.out.hookSpecificOutput.additionalContext, /ok and LIVE: spend is now affected\. ids 120211000111/);
  const err = post({ ...base, tool_response: { isError: true, content: [{ type: 'text', text: '{"error":{"message":"(#100) Invalid parameter","type":"OAuthException"}}' }] } }, d);
  assert.match(err.out.hookSpecificOutput.additionalContext, /: error/);
  const err2 = post({ ...base, tool_response: '{"error":{"message":"Permissions error","code":200}}' }, d);
  assert.match(err2.out.hookSpecificOutput.additionalContext, /: error/);
  assert.equal(post({ tool_name: 'mcp__meta-ads__ads_get_ad_entities', tool_input: {}, tool_response: { content: [{ type: 'text', text: '{"error":null,"data":[]}' }] } }, d).out, null);
  assert.equal(post({ tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: { stdout: 'error: 1 failed' } }, d).out, null);
  const cli = post({ tool_name: 'Bash', tool_input: { command: 'meta ads adset update 1 --daily-budget 5000' }, tool_response: { stdout: '', stderr: 'API error', exit_code: 4 } }, d);
  assert.match(cli.out.hookSpecificOutput.additionalContext, /: error/);
  // Seen live: success:true with an embedded error block. That is an error, not an ok.
  const soft = post({ tool_name: 'mcp__meta-ads__ads_update_entity', tool_input: { entity_id: '1', fields: '{"status":"PAUSED"}' }, tool_response: { content: [{ type: 'text', text: '{"success":true,"is_draft":true,"error_type":"AD_DRAFT_PUBLISHING","error_summary":"Deleted ad set can\'t be edited","error_code":3858862}' }] } }, d);
  assert.match(soft.out.hookSpecificOutput.additionalContext, /: error\./);
  assert.doesNotMatch(soft.out.hookSpecificOutput.additionalContext, /LIVE/);
  const okText = post({ tool_name: 'mcp__meta-ads__ads_update_entity', tool_input: { entity_id: '1', fields: '{"status":"PAUSED"}' }, tool_response: { content: [{ type: 'text', text: '{"success":true,"is_draft":true,"error_type":null,"id":"1"}' }] } }, d);
  assert.match(okText.out.hookSpecificOutput.additionalContext, /: ok/, 'a null error_type is not an error');
  const fail = post({ ...base, hook_event_name: 'PostToolUseFailure', error: 'VALIDATION (code 100, subcode 2490409): Missing dependency: You must first publish the ad objects [120250187538830232]' }, d);
  assert.match(fail.out.hookSpecificOutput.additionalContext, /: error\. VALIDATION \(code 100/);
  assert.equal(fail.out.hookSpecificOutput.hookEventName, 'PostToolUseFailure');
  const L = readLedger(d);
  assert.equal(L.length, 7);
  assert.deepEqual(L.map((r) => r.result), ['ok', 'error', 'error', 'error', 'error', 'ok', 'error']);
  assert.deepEqual(L[0].ids, ['120211000111']);
  rmSync(d, { recursive: true, force: true });
});

test('stop: silent when nothing was gated this session', () => {
  const d = fresh();
  assert.equal(stop({ last_assistant_message: 'All live now! Activated everything.' }, d).code, 0);
  pre({ tool_name: 'mcp__meta-ads__ads_activate_entity', tool_input: { entity_id: '1' }, session_id: 'other' }, d);
  assert.equal(stop({ last_assistant_message: 'Activated everything.' }, d).code, 0, 'other session does not count');
  rmSync(d, { recursive: true, force: true });
});

test('stop: blocks a live claim with no successful write, blocks a missing status line, passes a true report', () => {
  const d = fresh();
  const input = { tool_name: 'mcp__meta-ads__ads_activate_entity', tool_input: { entity_id: '1' } };
  pre(input, d);
  let r = stop({ last_assistant_message: 'The ad set is now live at $50/day.' }, d);
  assert.equal(r.code, 2); assert.match(r.err, /says something went live, but the ledger/);
  r = stop({ last_assistant_message: 'I proposed activating ad set 1; it was denied and remains paused.' }, d);
  assert.equal(r.code, 2); assert.match(r.err, /End your message with the status line/); assert.match(r.err, /handbrake: ask/);
  r = stop({ last_assistant_message: 'Proposed activating ad set 1; it was denied and remains paused.\nhandbrake: ask · 1 gated call · 1 passed, 0 denied · 0 succeeded, 0 failed · 0 spend-affecting changes went live' }, d);
  assert.equal(r.code, 0);
  post({ ...input, tool_response: '{"success":true}' }, d);
  r = stop({ last_assistant_message: 'Ad set 1 is now live.\nhandbrake: ask · 1 gated call · 1 passed, 0 denied · 1 succeeded, 0 failed · 1 spend-affecting change went live' }, d);
  assert.equal(r.code, 0, 'a true live claim with a status line passes');
  assert.equal(stop({ last_assistant_message: 'x', stop_hook_active: true }, d).code, 0, 'never loops');
  rmSync(d, { recursive: true, force: true });
});

test('hooks never crash the session on garbage input', () => {
  for (const h of ['pre-tool-use.js', 'post-tool-use.js', 'stop.js']) {
    const r = spawnSync(process.execPath, [join(HOOKS, h)], { input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 0, h);
  }
});
