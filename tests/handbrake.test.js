import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { classify, classifyBash, decide, changeId, canonical, approve, listApprovals, loadPolicy, savePolicy, DEFAULT_POLICY, appendLedger, statusLine, audit, bareTool, serverOf } from '../skills/handbrake/scripts/handbrake.js';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', 'skills', 'handbrake', 'scripts', 'handbrake.js');
const fresh = () => mkdtempSync(join(tmpdir(), 'handbrake-t-'));
const cli = (dir, ...args) => { const r = spawnSync(process.execPath, [CLI, ...args], { cwd: dir, encoding: 'utf8' }); return { code: r.status, out: r.stdout, err: r.stderr }; };
const P = { ...DEFAULT_POLICY };

// ---- names ------------------------------------------------------------------------------------

test('bareTool strips the mcp prefix including servers with underscores', () => {
  assert.equal(bareTool('mcp__meta-ads__ads_activate_entity'), 'ads_activate_entity');
  assert.equal(bareTool('mcp__meta_ads_pro__update_ad_set'), 'update_ad_set');
  assert.equal(serverOf('mcp__meta_ads_pro__update_ad_set'), 'meta_ads_pro');
  assert.equal(bareTool('Bash'), 'Bash');
});

test('approval id binds to the meaning of the change, not the argument layout', () => {
  const a = classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1', entity_id: '120', entity_type: 'ad_set', publish_as_active: true }).id;
  const b = classify('mcp__pipeboard__ads_activate_entity', { entity_type: 'AD_SET', entity_id: 120, ad_account_id: 'act_1', publish_as_active: 'true', note: null }).id;
  const c = classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1', entity_id: '121', entity_type: 'ad_set' }).id;
  const d = classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_2', entity_id: '120', entity_type: 'ad_set' }).id;
  assert.equal(a, b, 'same entity, same account, same kind: same id');
  assert.notEqual(a, c, 'different entity');
  assert.notEqual(a, d, 'different account');
  const e = classify('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 5000 }).id;
  const f = classify('mcp__meta__ads_update_entity', { entity_id: '1', updates: { daily_budget: '5000' } }).id;
  const g = classify('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 5001 }).id;
  assert.equal(e, f, 'budget found at any depth, number or string');
  assert.notEqual(e, g, 'different amount is a different change');
  const h = classify('mcp__meta__ads_update_entity', { entity_id: '1', name: 'A' }).id;
  const i = classify('mcp__meta__ads_update_entity', { entity_id: '1', name: 'B' }).id;
  assert.notEqual(h, i, 'plain updates still bind to their fields');
  assert.notEqual(classify('mcp__meta__ads_activate_entity', { entity_id: '1' }).id, classify('mcp__meta__ads_update_entity', { entity_id: '1', status: 'PAUSED' }).id, 'activate and pause of the same entity differ');
});

test('official server: payload arrives as a JSON string in `fields`; still classified, capped, and paused freely', () => {
  const noise = { advertiser_job: 'update_existing_campaigns', advertiser_request: 'differs every call', client_conversation_id: 'abc', client_model: 'x' };
  const pause = classify('mcp__meta-ads__ads_update_entity', { ad_account_id: '1389694561222174', entity_id: '120', entity_type: 'ad_set', fields: '{"status":"PAUSED"}', ...noise });
  assert.equal(pause.kind, 'deescalate', 'the brake always works, even through a JSON string');
  assert.equal(pause.account, 'act_1389694561222174');
  const bud = classify('mcp__meta-ads__ads_update_entity', { ad_account_id: '1389694561222174', entity_id: '120', entity_type: 'ad_set', fields: '{"lifetime_budget":5000}', ...noise });
  assert.equal(bud.kind, 'budget'); assert.deepEqual(bud.budgets, { lifetime: 5000 });
  assert.equal(decide(bud, { ...P, max_lifetime_budget: 500, mode: 'twokey' }, fresh()).decision, 'deny');
  assert.match(decide(bud, { ...P, max_lifetime_budget: 500, mode: 'twokey' }, fresh()).reason, /over the cap/);
  const act = classify('mcp__meta-ads__ads_update_entity', { entity_id: '120', fields: '{"status":"ACTIVE"}' });
  assert.equal(act.kind, 'activate');
  const upd = classify('mcp__meta-ads__ads_update_entity', { ad_account_id: 'act_1', entity_id: '120', entity_type: 'ad_set', fields: '{"name":"new name"}', ...noise });
  assert.equal(upd.kind, 'update');
  assert.match(upd.summary, /^UPDATE ad set 120: name\.$/, 'summary names the real field, not the telemetry');
  const upd2 = classify('mcp__meta-ads__ads_update_entity', { ad_account_id: 'act_1', entity_id: '120', fields: { name: 'new name' }, advertiser_request: 'other words' });
  assert.equal(upd.id, upd2.id, 'string payload and object payload are the same change');
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '120', fields: '{"status":"DELETED"}' }).kind, 'delete');
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '120', fields: 'not json {' }).kind, 'update', 'a non-JSON string is left alone');
});

test('official server: publishing a drafted pause is allowed; publishing anything else is an activation', () => {
  const d = fresh();
  const pol = { ...P, mode: 'twokey' };
  const pub = (ids) => classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: '1', entity_id: ids[0], entity_type: 'ad_set', object_ids: ids, publish_as_active: false });
  assert.equal(pub(['120']).kind, 'publish');
  assert.match(pub(['120']).summary, /PUBLISH pending drafts for ad set 120, keeping their drafted statuses/);
  // Nothing drafted through handbrake yet: unknown drafts, treated as activation, denied in twokey.
  let r = decide(pub(['120']), pol, d);
  assert.equal(r.decision, 'deny'); assert.match(r.reason, /treated as an activation/);
  // A pause was drafted through handbrake and succeeded (pre row with args, post row with eid).
  const pause = classify('mcp__meta-ads__ads_update_entity', { ad_account_id: '1', entity_id: '120', entity_type: 'ad_set', fields: '{"status":"PAUSED"}' });
  appendLedger(d, { session: 's', id: pause.id, kind: 'deescalate', decision: 'allow', args: JSON.stringify({ entity_id: '120', fields: '{"status":"PAUSED"}' }) });
  appendLedger(d, { session: 's', id: pause.id, kind: 'deescalate', result: 'ok' });
  r = decide(pub(['120']), pol, d);
  assert.equal(r.decision, 'allow'); assert.match(r.reason, /publishes a pause\. Always allowed/);
  // A later budget change on the same object makes the pending drafts unknown again.
  appendLedger(d, { session: 's', id: 'hb-x', kind: 'budget', eid: '120', result: 'ok' });
  assert.equal(decide(pub(['120']), pol, d).decision, 'deny');
  // Two objects: both must be pauses.
  appendLedger(d, { session: 's', id: 'hb-y', kind: 'deescalate', eid: '120', result: 'ok' });
  appendLedger(d, { session: 's', id: 'hb-z', kind: 'deescalate', eid: '121', result: 'ok' });
  assert.equal(decide(pub(['120', '121']), pol, d).decision, 'allow');
  appendLedger(d, { session: 's', id: 'hb-w', kind: 'activate', eid: '121', result: 'ok' });
  assert.equal(decide(pub(['120', '121']), pol, d).decision, 'deny');
  // A delete the human approved publishes like a pause: it stops spend and was gated when drafted.
  appendLedger(d, { session: 's', id: 'hb-v', kind: 'delete', eid: '121', result: 'ok' });
  assert.equal(decide(pub(['120', '121']), pol, d).decision, 'allow');
  // publish_as_active true is a plain activation, never a pause.
  assert.equal(classify('mcp__meta-ads__ads_activate_entity', { entity_id: '120', publish_as_active: true }).kind, 'activate');
  assert.equal(classify('mcp__meta-ads__ads_activate_entity', { entity_id: '120' }).kind, 'activate');
  // statusLine does not count a pause-publish as live.
  appendLedger(d, { session: 's2', id: 'hb-p', kind: 'publish', eid: '120', decision: 'allow', reason: 'handbrake: PUBLISH … publishes a pause. Always allowed.' });
  appendLedger(d, { session: 's2', id: 'hb-p', kind: 'publish', eid: '120', result: 'ok' });
  appendLedger(d, { session: 's2', id: 'hb-q', kind: 'publish', eid: '122', decision: 'allow', reason: 'handbrake: hb-q approved by the human.' });
  appendLedger(d, { session: 's2', id: 'hb-q', kind: 'publish', eid: '122', result: 'ok' });
  assert.match(statusLine(d, 's2'), /1 spend-affecting change went live/);
  rmSync(d, { recursive: true, force: true });
});

test('a multi-object publish binds to exactly that set of ids', () => {
  const two = classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1', object_ids: ['222', '111'], publish_as_active: true });
  assert.equal(two.kind, 'activate');
  assert.equal(two.eid, '111+222');
  assert.match(two.summary, /ACTIVATE 2 objects \(111, 222\): turns spend ON/);
  const same = classify('mcp__meta-ads__ads_activate_entity', { object_ids: [111, 222], ad_account_id: 'act_1', advertiser_request: 'different every call' });
  assert.equal(two.id, same.id, 'order and telemetry do not matter');
  assert.notEqual(two.id, classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1', object_ids: ['111'] }).id, 'subset is a different change');
  assert.notEqual(two.id, classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1', object_ids: ['111', '222', '333'] }).id, 'superset is a different change');
  assert.notEqual(classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1' }).id, two.id);
  // Seen live: the official server call carried entity_id for the parent AND object_ids for the set.
  const both = classify('mcp__meta-ads__ads_activate_entity', { ad_account_id: 'act_1', entity_id: '111', entity_type: 'campaign', object_ids: ['111', '222'], publish_as_active: true });
  assert.equal(both.eid, '111+222');
  assert.equal(both.id, two.id, 'the single id is already in the set; same change');
  assert.match(both.summary, /ACTIVATE 2 objects/);
});

test('changeId is stable under key order and prefix, changes with any argument', () => {
  const a = changeId('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 500 });
  const b = changeId('mcp__other__ads_update_entity', { daily_budget: 500, entity_id: '1' });
  const c = changeId('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 501 });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^hb-[0-9a-f]{10}$/);
  assert.equal(canonical({ b: [1, { d: null, c: 2 }], a: 'x' }), '{"a":"x","b":[1,{"c":2,"d":null}]}');
});

// ---- classification ---------------------------------------------------------------------------

test('official MCP: reads pass, creates log, activate and budget gate, pause de-escalates', () => {
  assert.equal(classify('mcp__meta-ads__ads_get_ad_entities', {}).kind, 'read');
  assert.equal(classify('mcp__meta-ads__ads_insights_performance_trend', { a: 1 }).kind, 'read');
  assert.equal(classify('mcp__meta-ads__ads_catalog_get_products', {}).kind, 'read');
  const cr = classify('mcp__meta-ads__ads_create_campaign', { name: 'Q4', objective: 'OUTCOME_SALES', daily_budget: 3000 });
  assert.equal(cr.kind, 'create');
  assert.match(cr.summary, /CREATE campaign "Q4" with daily 30\.00 \(3000 minor units\)\. Created paused or as a draft/);
  assert.equal(classify('mcp__meta-ads__ads_create_ad', { adset_id: '1', status: 'ACTIVE' }).kind, 'activate', 'status ACTIVE on a create is an activation');
  const act = classify('mcp__meta-ads__ads_activate_entity', { entity_id: '120211', entity_type: 'ADSET' });
  assert.equal(act.kind, 'activate');
  assert.match(act.summary, /ACTIVATE adset 120211: turns spend ON/);
  const bud = classify('mcp__meta-ads__ads_update_entity', { entity_id: '1', daily_budget: 5000 });
  assert.equal(bud.kind, 'budget');
  assert.deepEqual(bud.budgets, { daily: 5000 });
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '1', status: 'ACTIVE' }).kind, 'activate');
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '1', status: 'PAUSED' }).kind, 'deescalate');
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '1', name: 'renamed' }).kind, 'update');
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '1', status: 'DELETED' }).kind, 'delete', 'deleting via status is a delete, gated and named as such');
  assert.equal(classify('mcp__meta-ads__ads_update_entity', { entity_id: '1', updates: { lifetime_budget: '90000' } }).kind, 'budget', 'nested budget keys are found');
});

test('community servers classify by verb; non-ads servers are ignored', () => {
  assert.equal(classify('mcp__pipeboard__update_adset', { adset_id: '5', status: 'ACTIVE' }).kind, 'activate');
  assert.equal(classify('mcp__meta_ads__pause_campaign', { campaign_id: '5' }).kind, 'deescalate');
  assert.equal(classify('mcp__meta_ads__update_daily_budget', { adset_id: '5', daily_budget: 100 }).kind, 'budget');
  assert.equal(classify('mcp__meta_ads__duplicate_campaign', { campaign_id: '5' }).kind, 'create');
  assert.equal(classify('mcp__meta_ads__delete_ad', { ad_id: '5' }).kind, 'delete');
  assert.equal(classify('mcp__meta_ads__frobnicate_adset', { adset_id: '5' }).kind, 'unknown-write');
  assert.equal(classify('mcp__meta_ads__get_insights', {}).kind, 'read');
  assert.equal(classify('mcp__github__create_issue', { title: 'x' }).gated, false);
  assert.equal(classify('mcp__filesystem__write_file', { path: 'x' }).gated, false);
  assert.equal(classify('mcp__ads-scout__update_campaign_budget', { campaign_id: '1', budget: 100 }).kind, 'budget');
});

test('account id is found in several shapes', () => {
  assert.equal(classify('mcp__meta__ads_create_campaign', { account_id: '123' }).account, 'act_123');
  assert.equal(classify('mcp__meta__ads_create_campaign', { ad_account_id: 'act_9' }).account, 'act_9');
  assert.equal(classify('mcp__meta__ads_create_campaign', { parent: 'act_77' }).account, 'act_77');
});

test('bash: meta CLI verbs, raw Graph API writes, and self-protection', () => {
  assert.equal(classifyBash('meta ads campaign list --json').kind, 'read');
  assert.equal(classifyBash('meta ads adset update 123 --status PAUSED').kind, 'deescalate');
  assert.equal(classifyBash('meta ads adset update 123 --status ACTIVE').kind, 'activate');
  assert.equal(classifyBash('meta ads adset activate 123').kind, 'activate');
  const b = classifyBash('meta ads adset update 123 --daily-budget 7000');
  assert.equal(b.kind, 'budget'); assert.deepEqual(b.budgets, { daily: 7000 });
  assert.equal(classifyBash('meta ads campaign create --name x --objective OUTCOME_SALES').kind, 'create');
  assert.equal(classifyBash('curl -X POST "https://graph.facebook.com/v25.0/act_1/campaigns" -d name=x').kind, 'unknown-write');
  assert.equal(classifyBash('curl "https://graph.facebook.com/v25.0/act_1/insights?fields=spend"').gated, false);
  assert.equal(classifyBash('node handbrake.js approve hb-123').kind, 'self');
  assert.equal(classifyBash('handbrake policy set mode off').kind, 'self');
  assert.equal(classifyBash('echo "{}" > .handbrake/approvals/hb-1.json').kind, 'self');
  assert.equal(classifyBash('rm -rf .handbrake/ledger.jsonl').kind, 'self');
  assert.equal(classifyBash('node handbrake.js status').gated, false);
  assert.equal(classifyBash('npm test').gated, false);
});

// ---- decisions --------------------------------------------------------------------------------

test('decide: ask mode', () => {
  const d = fresh();
  assert.equal(decide(classify('mcp__meta__ads_get_ad_entities', {}), P, d).decision, 'pass');
  assert.equal(decide(classify('mcp__meta__ads_update_entity', { entity_id: '1', status: 'PAUSED' }), P, d).decision, 'allow');
  assert.equal(decide(classify('mcp__meta__ads_create_campaign', { name: 'x' }), P, d).decision, 'allow');
  assert.equal(decide(classify('mcp__meta__ads_create_campaign', { name: 'x' }), { ...P, gate_creates: true }, d).decision, 'ask');
  const act = decide(classify('mcp__meta__ads_activate_entity', { entity_id: '1' }), P, d);
  assert.equal(act.decision, 'ask'); assert.match(act.reason, /^handbrake hb-[0-9a-f]{10}: ACTIVATE/);
  assert.equal(decide(classify('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 5000 }), P, d).decision, 'ask');
  assert.equal(decide(classify('mcp__meta__ads_activate_entity', { entity_id: '1' }), { ...P, mode: 'off' }, d).decision, 'allow');
  assert.equal(decide(classifyBash('handbrake approve hb-1'), P, d).decision, 'deny');
  rmSync(d, { recursive: true, force: true });
});

test('decide: caps deny regardless of mode, pause still allowed', () => {
  const d = fresh();
  const over = decide(classify('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 50000 }), { ...P, mode: 'off' }, d);
  assert.equal(over.decision, 'deny'); assert.match(over.reason, /over the cap 200\.00/);
  assert.equal(decide(classify('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 50000 }), { ...P, max_daily_budget: null }, d).decision, 'ask');
  assert.equal(decide(classify('mcp__meta__ads_create_ad_set', { name: 'x', lifetime_budget: 999999 }), { ...P, max_lifetime_budget: 100000 }, d).decision, 'deny');
  const acct = decide(classify('mcp__meta__ads_activate_entity', { entity_id: '1', account_id: 'act_2' }), { ...P, allowed_accounts: ['act_1'] }, d);
  assert.equal(acct.decision, 'deny'); assert.match(acct.reason, /act_2 is not in policy.allowed_accounts/);
  assert.equal(decide(classify('mcp__meta__ads_activate_entity', { entity_id: '1', account_id: 'act_1' }), { ...P, allowed_accounts: ['act_1'] }, d).decision, 'ask');
  const blocked = decide(classify('mcp__meta__ads_activate_entity', { entity_id: '1' }), { ...P, block_activate: true, mode: 'off' }, d);
  assert.equal(blocked.decision, 'deny'); assert.match(blocked.reason, /review-only/);
  assert.equal(decide(classify('mcp__meta__ads_update_entity', { entity_id: '1', status: 'PAUSED' }), { ...P, block_activate: true, allowed_accounts: ['act_x'] }, d).decision, 'allow', 'the brake always works');
  rmSync(d, { recursive: true, force: true });
});

test('decide: twokey needs a token, consumes it, expires it', () => {
  const d = fresh();
  const pol = { ...P, mode: 'twokey' };
  const cls = classify('mcp__meta__ads_activate_entity', { entity_id: '1' });
  const no = decide(cls, pol, d);
  assert.equal(no.decision, 'deny'); assert.match(no.reason, new RegExp(`handbrake approve ${cls.id}`));
  approve(d, cls.id, 30, 'go');
  assert.equal(listApprovals(d).length, 1);
  const yes = decide(cls, pol, d);
  assert.equal(yes.decision, 'allow'); assert.match(yes.reason, /approved by the human \(go\)/);
  assert.equal(listApprovals(d).length, 0, 'token consumed');
  assert.equal(decide(cls, pol, d).decision, 'deny', 'second call needs a new token');
  approve(d, cls.id, 30);
  assert.equal(decide(cls, pol, d, { dry: true }).decision, 'allow');
  assert.equal(listApprovals(d).length, 1, 'dry run does not consume');
  const other = classify('mcp__meta__ads_activate_entity', { entity_id: '2' });
  assert.equal(decide(other, pol, d).decision, 'deny', 'token is bound to the exact change');
  writeFileSync(join(d, '.handbrake', 'approvals', other.id + '.json'), JSON.stringify({ id: other.id, expires: new Date(Date.now() - 1000).toISOString() }));
  const exp = decide(other, pol, d);
  assert.equal(exp.decision, 'deny'); assert.match(exp.reason, /expired/);
  assert.equal(decide(classify('mcp__meta__ads_update_entity', { entity_id: '1', daily_budget: 99999 }), pol, d).decision, 'deny', 'cap beats token');
  rmSync(d, { recursive: true, force: true });
});

// ---- policy, ledger, status -------------------------------------------------------------------

test('policy defaults when missing; savePolicy round-trips without private keys', () => {
  const d = fresh();
  assert.equal(loadPolicy(d)._missing, true);
  savePolicy(d, { ...loadPolicy(d), mode: 'twokey' });
  const p = loadPolicy(d);
  assert.equal(p.mode, 'twokey'); assert.equal(p._missing, undefined);
  assert.equal(JSON.parse(readFileSync(join(d, '.handbrake', 'policy.json'), 'utf8'))._missing, undefined);
  rmSync(d, { recursive: true, force: true });
});

test('statusLine counts gated, passed, denied, succeeded, live, per session', () => {
  const d = fresh();
  appendLedger(d, { session: 's1', id: 'hb-1', kind: 'activate', decision: 'ask' });
  appendLedger(d, { session: 's1', id: 'hb-1', kind: 'activate', result: 'ok' });
  appendLedger(d, { session: 's1', id: 'hb-2', kind: 'budget', decision: 'deny' });
  appendLedger(d, { session: 's1', id: 'hb-3', kind: 'create', decision: 'allow' });
  appendLedger(d, { session: 's1', id: 'hb-3', kind: 'create', result: 'ok' });
  appendLedger(d, { session: 's2', id: 'hb-9', kind: 'activate', decision: 'ask' });
  appendLedger(d, { session: 's1', id: 'hb-4', kind: 'activate', decision: 'planned' });
  assert.equal(statusLine(d, 's1'), 'handbrake: ask (defaults; run handbrake init) · 3 gated calls · 2 passed, 1 denied · 2 succeeded, 0 failed · 1 spend-affecting change went live');
  assert.match(statusLine(d), /4 gated calls/);
  rmSync(d, { recursive: true, force: true });
});

// ---- CLI --------------------------------------------------------------------------------------

test('cli: init, status, explain, plan, approve, deny, policy, ledger', () => {
  const d = fresh();
  let r = cli(d, 'init', '--mode', 'twokey');
  assert.equal(r.code, 0); assert.match(r.out, /handbrake on\. mode=twokey/);
  assert.match(cli(d, 'init').out, /policy exists/);
  r = cli(d, 'explain', 'mcp__meta-ads__ads_activate_entity', '{"entity_id":"7"}');
  assert.equal(r.code, 0); assert.match(r.out, /kind=activate\s+gated=true/); assert.match(r.out, /would: deny/);
  assert.equal(existsSync(join(d, '.handbrake', 'ledger.jsonl')), false, 'explain writes nothing');
  r = cli(d, 'plan', 'mcp__meta-ads__ads_activate_entity', '{"entity_id":"7"}', '--why', 'tested creative');
  const id = /(hb-[0-9a-f]{10})/.exec(r.out)[1];
  assert.match(r.out, new RegExp(`handbrake approve ${id}`));
  assert.match(cli(d, 'ledger').out, /planned\s+activate/);
  r = cli(d, 'approve', id, '--ttl', '5', '--note', 'ok by me');
  assert.match(r.out, /approved hb-/);
  assert.match(cli(d, 'explain', 'mcp__meta-ads__ads_activate_entity', '{"entity_id":"7"}').out, /would: allow/);
  assert.match(cli(d, 'deny', id).out, /revoked/);
  assert.match(cli(d, 'deny', id).out, /no token/);
  assert.match(cli(d, 'policy', 'set', 'max_daily_budget', '1000').out, /max_daily_budget = 1000/);
  assert.equal(loadPolicy(d).max_daily_budget, 1000);
  assert.equal(cli(d, 'policy', 'set', 'nope', '1').code, 1);
  assert.match(cli(d, 'policy').out, /"mode": "twokey"/);
  assert.match(cli(d, 'status').out, /^handbrake: twokey · 0 gated calls/);
  assert.match(cli(d, 'explain', 'Bash', '{"command":"meta ads adset update 1 --status PAUSED"}').out, /would: allow/);
  assert.equal(cli(d, 'bogus').code, 1);
  assert.equal(cli(d).code, 0);
  rmSync(d, { recursive: true, force: true });
});

// ---- audit ------------------------------------------------------------------------------------

test('audit flags drift and proposes, never acts', () => {
  const rows = JSON.parse(readFileSync(join(here, 'fixtures', 'insights-drift.json'), 'utf8'));
  const prev = JSON.parse(readFileSync(join(here, 'fixtures', 'insights-prev.json'), 'utf8'));
  const rep = audit(rows, prev);
  const checks = rep.flags.map((f) => f.check);
  for (const c of ['placement-drift', 'bleeding', 'cheap-inventory', 'fatigue', 'learning-limited', 'creative-starvation', 'advantage-audience-on']) assert.ok(checks.includes(c), 'missing ' + c);
  assert.equal(rep.flags[0].sev, 'high', 'sorted by severity');
  for (const f of rep.flags) assert.match(f.propose, /propose|confirm|check/i);
  const clean = audit([{ name: 'a', spend: 100, impressions: 10000, reach: 8000, results: 10, publisher_platform: 'facebook', platform_position: 'feed' }]);
  assert.equal(clean.flags.length, 0);
  assert.equal(audit({ data: rows }).rows, rows.length, 'accepts {data:[...]}');
});

test('cli audit prints flags and proposals', () => {
  const d = fresh();
  const r = cli(d, 'audit', join(here, 'fixtures', 'insights-drift.json'), '--previous', join(here, 'fixtures', 'insights-prev.json'));
  assert.equal(r.code, 0);
  assert.match(r.out, /handbrake audit: \d+ rows/); assert.match(r.out, /\[high\] placement-drift/); assert.match(r.out, /-> Propose/);
  const j = JSON.parse(cli(d, 'audit', join(here, 'fixtures', 'insights-drift.json'), '--json').out);
  assert.ok(Array.isArray(j.flags));
  assert.equal(cli(d, 'audit', 'missing.json').code, 1);
  rmSync(d, { recursive: true, force: true });
});
