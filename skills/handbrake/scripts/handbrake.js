#!/usr/bin/env node
// handbrake: the agent can drive your Meta ads; spend does not move until you release the brake.
// Zero dependencies. Node >= 18. Library exports at the top, CLI at the bottom.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DIR = '.handbrake';
export const VERSION = '0.1.0';

export const DEFAULT_POLICY = {
  mode: 'ask',                  // ask: native permission prompt per gated write. twokey: needs a token from `handbrake approve`. off: log only.
  gate_creates: false,          // Meta creates campaigns/ad sets/ads PAUSED. Log them; set true to prompt on creates too.
  budget_unit: 'minor',         // Meta Marketing API budgets are minor units (cents). 'major' if your server takes dollars.
  max_daily_budget: 20000,      // per entity, in budget_unit. null = no cap.
  max_lifetime_budget: null,
  allowed_accounts: [],         // e.g. ["act_123"]; empty = any account.
  block_activate: false,        // true = activations are always denied (review-only sessions).
  approval_ttl_minutes: 30,     // twokey tokens expire.
};

// ---- storage ---------------------------------------------------------------------------------

export function root(cwd = process.cwd()) { return join(process.env.HANDBRAKE_DIR || cwd, DIR); }
function ensure(cwd) {
  const d = root(cwd);
  for (const p of [d, join(d, 'approvals')]) if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return d;
}

export function loadPolicy(cwd) {
  const f = join(root(cwd), 'policy.json');
  if (!existsSync(f)) return { ...DEFAULT_POLICY, _missing: true };
  try { return { ...DEFAULT_POLICY, ...JSON.parse(readFileSync(f, 'utf8')) }; }
  catch { return { ...DEFAULT_POLICY, _corrupt: true }; }
}
export function savePolicy(cwd, policy) {
  ensure(cwd);
  const { _missing, _corrupt, ...p } = policy;
  writeFileSync(join(root(cwd), 'policy.json'), JSON.stringify(p, null, 2) + '\n');
  return p;
}

export function appendLedger(cwd, entry) {
  ensure(cwd);
  const row = { ts: new Date().toISOString(), ...entry };
  appendFileSync(join(root(cwd), 'ledger.jsonl'), JSON.stringify(row) + '\n');
  return row;
}
export function readLedger(cwd) {
  const f = join(root(cwd), 'ledger.jsonl');
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ---- fingerprint -----------------------------------------------------------------------------

export function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v === undefined ? null : v);
}
export function changeId(tool, args) {
  return 'hb-' + createHash('sha256').update(bareTool(tool) + '\n' + canonical(args ?? {})).digest('hex').slice(0, 10);
}

// ---- classification --------------------------------------------------------------------------

export function bareTool(name) {
  const s = String(name);
  if (!s.startsWith('mcp__')) return s;
  const i = s.indexOf('__', 5);
  return i < 0 ? s : s.slice(i + 2);
}
export function serverOf(name) {
  const s = String(name);
  if (!s.startsWith('mcp__')) return '';
  const i = s.indexOf('__', 5);
  return i < 0 ? '' : s.slice(5, i);
}

const ADS_SERVER = /meta|facebook|\bfb\b|ads|marketing|pipeboard/i;
const ADS_TOOL = /^ads_|campaign|ad_?set|adset|creative|audience|budget|\bad\b|_ad$|_ads?_|insights/i;
const READ_VERB = /^(get|list|fetch|read|search|find|describe|insights?|report|preview|estimate|check|show|query|lookup|download|export|analy[sz]e|diagnos|validate|count|ads_get|ads_insights|ads_catalog_get)/i;
const CREATE_VERB = /^(ads_create|ads_catalog_create|create|add|duplicate|copy|clone|upload|generate)_?/i;
const DEESC_VERB = /^(pause|stop|archive|disable|turn_off|halt)_?/i;
const ACTIVATE_VERB = /^(ads_activate|activate|resume|enable|launch|start|turn_on|publish|unpause)_?/i;
const DELETE_VERB = /^(delete|remove|destroy)_?/i;
const UPDATE_VERB = /^(ads_update|update|set|edit|modify|change|patch|adjust|scale|increase|decrease|bulk_update|batch_update)_?/i;

const ID_KEYS = ['entity_id', 'id', 'campaign_id', 'adset_id', 'ad_set_id', 'ad_id', 'object_id', 'creative_id', 'node_id'];
const BUDGET_KEYS = { daily_budget: 'daily', lifetime_budget: 'lifetime', bid_amount: 'bid', dailyBudget: 'daily', lifetimeBudget: 'lifetime', bidAmount: 'bid', budget: 'daily' };

export function deepFind(obj, pred, depth = 0, out = []) {
  if (!obj || typeof obj !== 'object' || depth > 5) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (pred(k, v)) out.push([k, v]);
    if (v && typeof v === 'object') deepFind(v, pred, depth + 1, out);
  }
  return out;
}
const firstVal = (args, keys) => {
  for (const k of keys) {
    const hit = deepFind(args, (kk, v) => kk === k && (typeof v === 'string' || typeof v === 'number'))[0];
    if (hit) return String(hit[1]);
  }
  return null;
};
export function budgetsOf(args) {
  const found = {};
  for (const [k, v] of deepFind(args, (kk, vv) => kk in BUDGET_KEYS && vv !== null && vv !== '' && isFinite(Number(vv)))) {
    if (!(BUDGET_KEYS[k] in found)) found[BUDGET_KEYS[k]] = Number(v);
  }
  return found;
}
export function statusOf(args) {
  const s = firstVal(args, ['status', 'effective_status', 'configured_status']);
  return s ? s.toUpperCase() : null;
}
export function accountOf(args) {
  const a = firstVal(args, ['account_id', 'ad_account_id', 'act_id', 'adAccountId', 'accountId']);
  if (a) return a.startsWith('act_') ? a : 'act_' + a;
  const any = deepFind(args, (k, v) => typeof v === 'string' && /^act_\d+$/.test(v))[0];
  return any ? any[1] : null;
}
export function fmtMoney(n, unit) {
  if (n == null) return '?';
  const major = unit === 'minor' ? n / 100 : n;
  return major.toFixed(2) + (unit === 'minor' ? ` (${n} minor units)` : '');
}
const entityType = (tool, args) => {
  const t = bareTool(tool).toLowerCase();
  if (/campaign/.test(t)) return 'campaign';
  if (/ad_?set|adset/.test(t)) return 'ad set';
  if (/creative/.test(t)) return 'creative';
  if (/catalog/.test(t)) return 'catalog';
  if (/(^|_)ad$|(^|_)ads?(_|$)/.test(t) && !/ads_(update|activate|get|insights)_entity/.test(t)) return 'ad';
  const lvl = firstVal(args, ['entity_type', 'level', 'object_type', 'type']);
  return lvl ? lvl.toLowerCase().replace(/_/g, ' ') : 'entity';
};

/** classify(toolName, args, policy) -> { gated, kind, id, tool, bare, summary, budgets, account, entity, eid, status } */
export function classify(toolName, args = {}, policy = DEFAULT_POLICY) {
  const bare = bareTool(toolName), server = serverOf(toolName);
  const verbish = CREATE_VERB.test(bare) || UPDATE_VERB.test(bare) || ACTIVATE_VERB.test(bare) || DEESC_VERB.test(bare) || DELETE_VERB.test(bare);
  const ads = ADS_SERVER.test(server) || /^ads_/.test(bare) || (ADS_TOOL.test(bare) && verbish);
  const base = {
    tool: toolName, bare, server, id: changeId(toolName, args), budgets: budgetsOf(args), account: accountOf(args),
    entity: entityType(toolName, args), eid: firstVal(args, ID_KEYS), status: statusOf(args),
  };
  if (!ads) return { ...base, gated: false, kind: 'ignore', summary: '' };
  let kind;
  if (READ_VERB.test(bare)) kind = 'read';
  else if (DEESC_VERB.test(bare)) kind = 'deescalate';
  else if (ACTIVATE_VERB.test(bare)) kind = 'activate';
  else if (DELETE_VERB.test(bare)) kind = 'delete';
  else if (CREATE_VERB.test(bare)) kind = 'create';
  else if (UPDATE_VERB.test(bare)) kind = 'update';
  else kind = 'unknown-write';
  if (kind === 'update' || kind === 'unknown-write') {
    if (base.status === 'ACTIVE') kind = 'activate';
    else if (base.status === 'PAUSED' || base.status === 'ARCHIVED') kind = 'deescalate';
    else if (Object.keys(base.budgets).length) kind = 'budget';
  }
  if (kind === 'create' && base.status === 'ACTIVE') kind = 'activate';
  const unit = policy.budget_unit || 'minor';
  const bstr = Object.entries(base.budgets).map(([k, v]) => `${k} ${fmtMoney(v, unit)}`).join(', ');
  const who = `${base.entity}${base.eid ? ' ' + base.eid : ''}`;
  const name = firstVal(args, ['name']);
  const changed = Object.keys(args || {}).filter((k) => !ID_KEYS.includes(k) && !['account_id', 'ad_account_id'].includes(k));
  const summary = {
    read: '', ignore: '',
    deescalate: `PAUSE ${who}: stops or reduces spend. Always allowed.`,
    activate: `ACTIVATE ${who}: turns spend ON${bstr ? ' at ' + bstr : ''}.`,
    budget: `BUDGET ${who}: ${bstr}.`,
    update: `UPDATE ${who}: ${changed.join(', ') || 'fields'}.`,
    create: `CREATE ${base.entity}${name ? ` "${name}"` : ''}${bstr ? ' with ' + bstr : ''}. Starts PAUSED at Meta.`,
    delete: `DELETE ${who}. Not reversible.`,
    'unknown-write': `WRITE ${bare}${who !== 'entity' ? ' on ' + who : ''}: unrecognised verb, treated as a live change.`,
  }[kind];
  const gated = !['read', 'ignore'].includes(kind);
  return { ...base, gated, kind, summary };
}

/** Bash command -> equivalent classification (official `meta` CLI, raw Graph API, handbrake self-protection). */
export function classifyBash(command, policy = DEFAULT_POLICY) {
  const c = String(command || '');
  const id = changeId('bash', { c });
  const self = /handbrake(?:\.js)?["']?\s+(approve|deny|policy\s+set|init\s+--force|reset)\b/.test(c)
    || /[>]{1,2}\s*["']?\S*\.handbrake[\\/]/.test(c)
    || /\b(rm|del|erase|mv|cp|sed\s+-i|tee|truncate|echo)\b[^|;&]*\.handbrake[\\/]/.test(c);
  if (self) return { gated: true, kind: 'self', id, bare: 'bash', tool: 'Bash', budgets: {}, account: null, summary: 'approvals, policy and the ledger are written by the human, in their own terminal, never by the agent.' };
  const graphWrite = /graph\.facebook\.com\//.test(c) && /(-X|--request)\s*(POST|DELETE)\b|\s(-d|--data(-raw|-binary|-urlencode)?|-F|--form)\s|method\s*[:=]\s*['"]?(POST|DELETE)/i.test(c);
  if (graphWrite) return { gated: true, kind: 'unknown-write', id, bare: 'curl graph.facebook.com', tool: 'Bash', budgets: {}, account: (/\bact_\d+/.exec(c) || [])[0] || null, summary: `WRITE raw Marketing API call: ${c.slice(0, 120)}` };
  if (!/\bmeta\s+ads\b/.test(c)) return { gated: false, kind: 'ignore', id, bare: 'bash', tool: 'Bash', budgets: {}, account: null, summary: '' };
  const flagStatus = (/--status[= ]+["']?(\w+)/i.exec(c) || [])[1]?.toUpperCase();
  const daily = (/--daily[-_]budget[= ]+["']?(\d+(?:\.\d+)?)/i.exec(c) || [])[1];
  const lifetime = (/--lifetime[-_]budget[= ]+["']?(\d+(?:\.\d+)?)/i.exec(c) || [])[1];
  const budgets = {};
  if (daily) budgets.daily = Number(daily);
  if (lifetime) budgets.lifetime = Number(lifetime);
  const unit = policy.budget_unit || 'minor';
  const bstr = Object.entries(budgets).map(([k, v]) => `${k} ${fmtMoney(v, unit)}`).join(', ');
  let kind = 'read';
  if (/\b(activate|resume|enable|unpause)\b/.test(c) || flagStatus === 'ACTIVE') kind = 'activate';
  else if (/\b(pause|archive|stop|disable)\b/.test(c) || flagStatus === 'PAUSED' || flagStatus === 'ARCHIVED') kind = 'deescalate';
  else if (/\bdelete\b/.test(c)) kind = 'delete';
  else if (/\bcreate\b/.test(c)) kind = 'create';
  else if (/\b(update|set|edit)\b/.test(c)) kind = Object.keys(budgets).length ? 'budget' : 'update';
  const acct = (/\bact_\d+/.exec(c) || [])[0] || null;
  const short = c.slice(0, 100);
  const summary = {
    read: '',
    deescalate: `PAUSE via CLI: ${short}. Always allowed.`,
    activate: `ACTIVATE via CLI${bstr ? ' at ' + bstr : ''}: ${short}`,
    budget: `BUDGET via CLI: ${bstr}: ${short}`,
    update: `UPDATE via CLI: ${short}`,
    create: `CREATE via CLI${bstr ? ' with ' + bstr : ''}: ${short}. Starts PAUSED at Meta.`,
    delete: `DELETE via CLI: ${short}. Not reversible.`,
  }[kind];
  return { gated: kind !== 'read', kind, id, bare: 'meta ads', tool: 'Bash', budgets, account: acct, summary };
}

// ---- decision --------------------------------------------------------------------------------

export function listApprovals(cwd) {
  const d = join(root(cwd), 'approvals');
  if (!existsSync(d)) return [];
  return readdirSync(d).filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(readFileSync(join(d, f), 'utf8')); } catch { return null; } }).filter(Boolean);
}
export function approve(cwd, id, ttlMinutes, note = '') {
  ensure(cwd);
  const ttl = Number(ttlMinutes) || loadPolicy(cwd).approval_ttl_minutes || 30;
  const tok = { id, ts: new Date().toISOString(), expires: new Date(Date.now() + ttl * 60000).toISOString(), note };
  writeFileSync(join(root(cwd), 'approvals', id + '.json'), JSON.stringify(tok, null, 2) + '\n');
  return tok;
}
export function revoke(cwd, id) {
  const f = join(root(cwd), 'approvals', String(id).replace(/[^a-z0-9-]/gi, '') + '.json');
  if (existsSync(f)) { unlinkSync(f); return true; }
  return false;
}

/** decide(cls, policy, cwd, {dry}) -> { decision: 'pass'|'allow'|'ask'|'deny', reason } */
export function decide(cls, policy, cwd, opts = {}) {
  if (!cls.gated) return { decision: 'pass', reason: '' };
  if (cls.kind === 'self') return { decision: 'deny', reason: 'handbrake: ' + cls.summary };
  if (cls.kind === 'deescalate') return { decision: 'allow', reason: 'handbrake: ' + cls.summary };
  const unit = policy.budget_unit || 'minor';
  if (policy.allowed_accounts?.length && cls.account && !policy.allowed_accounts.includes(cls.account)) {
    return { decision: 'deny', reason: `handbrake: account ${cls.account} is not in policy.allowed_accounts. The human edits .handbrake/policy.json to change that.` };
  }
  if (policy.max_daily_budget != null && cls.budgets?.daily > policy.max_daily_budget) {
    return { decision: 'deny', reason: `handbrake: daily budget ${fmtMoney(cls.budgets.daily, unit)} is over the cap ${fmtMoney(policy.max_daily_budget, unit)} in .handbrake/policy.json. Propose a smaller number, or ask the human to raise the cap.` };
  }
  if (policy.max_lifetime_budget != null && cls.budgets?.lifetime > policy.max_lifetime_budget) {
    return { decision: 'deny', reason: `handbrake: lifetime budget ${fmtMoney(cls.budgets.lifetime, unit)} is over the cap ${fmtMoney(policy.max_lifetime_budget, unit)}.` };
  }
  if (policy.block_activate && cls.kind === 'activate') {
    return { decision: 'deny', reason: 'handbrake: policy.block_activate is on. This session is review-only; nothing goes live. Leave it PAUSED and tell the human what you would activate and why.' };
  }
  if (cls.kind === 'create' && !policy.gate_creates) return { decision: 'allow', reason: 'handbrake: ' + cls.summary + ' Logged.' };
  if (policy.mode === 'off') return { decision: 'allow', reason: 'handbrake(off): ' + cls.summary + ' Logged.' };
  if (policy.mode === 'twokey') {
    const tok = listApprovals(cwd).find((t) => t.id === cls.id);
    if (tok && new Date(tok.expires).getTime() > Date.now()) {
      if (!opts.dry) revoke(cwd, cls.id);
      return { decision: 'allow', reason: `handbrake: ${cls.id} approved by the human${tok.note ? ' (' + tok.note + ')' : ''}. ${cls.summary}` };
    }
    if (tok) {
      if (!opts.dry) revoke(cwd, cls.id);
      return { decision: 'deny', reason: `handbrake: approval ${cls.id} expired. Ask the human to run \`handbrake approve ${cls.id}\` again in their own terminal.` };
    }
    return { decision: 'deny', reason: `handbrake: ${cls.summary}\nNo approval token for ${cls.id}. Show the human this change in plain words and ask them to run, in THEIR terminal (not yours):\n  handbrake approve ${cls.id}\nThen call the tool again with exactly the same arguments.` };
  }
  return { decision: 'ask', reason: `handbrake ${cls.id}: ${cls.summary}` };
}

export function statusLine(cwd, session) {
  const rows = readLedger(cwd).filter((r) => !session || r.session === session);
  const n = (k) => rows.filter((r) => r.decision === k).length;
  const ok = rows.filter((r) => r.result === 'ok').length, err = rows.filter((r) => r.result === 'error').length;
  const p = loadPolicy(cwd);
  const live = rows.filter((r) => r.result === 'ok' && ['activate', 'budget'].includes(r.kind)).length;
  const gated = rows.filter((r) => r.decision && r.decision !== 'planned').length;
  return `handbrake: ${p.mode}${p._missing ? ' (defaults; run handbrake init)' : ''} · ${gated} gated call${gated === 1 ? '' : 's'} · ${n('allow') + n('ask')} passed, ${n('deny')} denied · ${ok} succeeded, ${err} failed · ${live} spend-affecting change${live === 1 ? '' : 's'} went live`;
}

// ---- audit (drift) ---------------------------------------------------------------------------

const num = (v) => (v == null || v === '' ? null : Number(String(v).replace(/[$,]/g, '')));
function normRow(r) {
  const g = (...ks) => { for (const k of ks) if (r[k] != null) return r[k]; return null; };
  const spend = num(g('spend', 'amount_spent', 'cost')) || 0, imps = num(g('impressions')), reach = num(g('reach'));
  const results = num(g('results', 'conversions', 'purchases', 'actions', 'leads'));
  return {
    name: g('name', 'ad_name', 'adset_name', 'campaign_name', 'id') || '?',
    level: String(g('level', 'entity_type') || 'ad').toLowerCase(),
    spend, impressions: imps, reach, results,
    frequency: num(g('frequency')) ?? (imps && reach ? imps / reach : null),
    cpr: num(g('cost_per_result', 'cpa', 'cost_per_purchase', 'cost_per_lead')) ?? (results ? spend / results : null),
    cpm: num(g('cpm')) ?? (imps ? (spend / imps) * 1000 : null),
    platform: String(g('publisher_platform', 'platform') || '').toLowerCase(),
    placement: String(g('platform_position', 'placement') || '').toLowerCase(),
    learning: String(g('learning_stage', 'learning_stage_info', 'status_learning') || '').toUpperCase(),
    advantage: g('advantage_audience', 'targeting_automation', 'advantage_plus_audience'),
  };
}
const rowsOf = (x) => (Array.isArray(x) ? x : x?.data || x?.rows || []).map(normRow);

export function audit(input, previous = null, opts = {}) {
  const rows = rowsOf(input);
  const prev = previous ? rowsOf(previous) : null;
  const total = rows.reduce((s, r) => s + r.spend, 0);
  const flags = [];
  const lowq = rows.filter((r) => /audience_network/.test(r.platform) || /right_hand|explore_home|search|rewarded_video|instream|marketplace/.test(r.placement));
  const lowqSpend = lowq.reduce((s, r) => s + r.spend, 0);
  if (total && lowqSpend / total > (opts.placementShare ?? 0.25)) {
    flags.push({ sev: 'high', check: 'placement-drift', detail: `${Math.round((lowqSpend / total) * 100)}% of spend is on Audience Network or low-attention placements.`, propose: 'Propose excluding those placements on the affected ad sets (an UPDATE the human approves). Cheap results there often do not convert downstream.' });
  }
  for (const r of rows) if (r.frequency && r.frequency > (opts.frequency ?? 3.5)) {
    flags.push({ sev: 'medium', check: 'fatigue', detail: `${r.name}: frequency ${r.frequency.toFixed(1)}.`, propose: 'Propose new creative or a broader audience. Do not raise budget on this one.' });
  }
  for (const r of rows) if (/LEARNING_LIMITED/.test(r.learning)) {
    flags.push({ sev: 'medium', check: 'learning-limited', detail: `${r.name} is learning limited.`, propose: 'Propose consolidating ad sets or raising conversion volume before touching budget.' });
  }
  const withCpr = rows.filter((r) => r.cpr);
  const avgCpr = withCpr.length ? withCpr.reduce((s, r) => s + r.cpr, 0) / withCpr.length : 0;
  for (const r of rows) if (r.results === 0 && avgCpr && r.spend > 3 * avgCpr) {
    flags.push({ sev: 'high', check: 'bleeding', detail: `${r.name}: ${r.spend.toFixed(2)} spent, 0 results (over 3x the average cost per result).`, propose: 'Propose PAUSE (always allowed) and say why.' });
  }
  const ads = rows.filter((r) => r.level === 'ad' && r.spend);
  if (ads.length >= 3 && total) {
    const top = [...ads].sort((a, b) => b.spend - a.spend)[0];
    if (top.spend / total > (opts.concentration ?? 0.6)) flags.push({ sev: 'low', check: 'creative-starvation', detail: `${top.name} takes ${Math.round((top.spend / total) * 100)}% of spend across ${ads.length} ads.`, propose: 'Propose 2 to 3 new variants to test. Delivery has one horse.' });
  }
  for (const r of rows) if (r.advantage === true || /^(true|on|enabled|1)$/i.test(String(r.advantage ?? ''))) {
    flags.push({ sev: 'info', check: 'advantage-audience-on', detail: `${r.name}: Advantage+ audience expansion is on.`, propose: 'Confirm the human chose that. Meta switches it on by default for Sales, Leads and App campaigns.' });
  }
  if (prev) {
    const sum = (rs, k) => rs.reduce((s, r) => s + (r[k] || 0), 0);
    const pt = sum(prev, 'spend'), pi = sum(prev, 'impressions'), pr = sum(prev, 'results');
    const ti = sum(rows, 'impressions'), tr = sum(rows, 'results');
    const cpmNow = ti ? (total / ti) * 1000 : null, cpmPrev = pi ? (pt / pi) * 1000 : null;
    const cprNow = tr ? total / tr : null, cprPrev = pr ? pt / pr : null;
    if (cpmNow && cpmPrev && cprNow && cprPrev && cpmNow < cpmPrev * 0.7 && cprNow >= cprPrev * 0.95) {
      flags.push({ sev: 'high', check: 'cheap-inventory', detail: `CPM fell ${Math.round((1 - cpmNow / cpmPrev) * 100)}% but cost per result did not improve.`, propose: 'Delivery moved to cheaper, lower-intent inventory. Check the placement breakdown and downstream quality before trusting the dashboard.' });
    }
  }
  const order = { high: 0, medium: 1, low: 2, info: 3 };
  flags.sort((a, b) => order[a.sev] - order[b.sev]);
  return { rows: rows.length, spend: total, flags };
}

// ---- CLI -------------------------------------------------------------------------------------

const HELP = `handbrake ${VERSION}: the agent can drive your Meta ads; spend does not move until you release the brake.

  handbrake init [--mode ask|twokey|off]        write .handbrake/policy.json with defaults
  handbrake status                              one line: mode, gated calls, what went live
  handbrake ledger [n] [--json]                 last n ledger rows (default 20)
  handbrake explain <tool> '<json args>'        how a call would be classified and decided (writes nothing)
  handbrake plan <tool> '<json args>' [--why]   same, plus registers the intent in the ledger; prints the id to approve
  handbrake approve <id> [--ttl min] [--note s] HUMAN ONLY: mint a two-key token for one change id
  handbrake deny <id>                           HUMAN ONLY: revoke a token
  handbrake policy [get | set <key> <json>]     HUMAN ONLY for set
  handbrake audit <insights.json> [--previous <file>] [--json]   drift report: proposals, never actions
`;

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const [cmd, ...rest] = process.argv.slice(2);
  const cwd = process.cwd();
  const BOOL_FLAGS = new Set(['json', 'force']);
  const flag = (n) => { const i = rest.indexOf('--' + n); return i >= 0 ? rest[i + 1] : undefined; };
  const has = (n) => rest.includes('--' + n);
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(i > 0 && rest[i - 1].startsWith('--') && !BOOL_FLAGS.has(rest[i - 1].slice(2))));
  const out = (s) => process.stdout.write(s + '\n');
  try {
    switch (cmd) {
      case 'init': {
        const p = loadPolicy(cwd);
        if (!p._missing && !has('force')) { out(`policy exists at ${join(root(cwd), 'policy.json')}; use --force to overwrite`); break; }
        const saved = savePolicy(cwd, { ...DEFAULT_POLICY, mode: flag('mode') || 'ask' });
        out(`handbrake on. mode=${saved.mode}, daily cap ${fmtMoney(saved.max_daily_budget, saved.budget_unit)} per entity. Edit ${join(DIR, 'policy.json')} by hand to change caps.`);
        break;
      }
      case 'status': out(statusLine(cwd, flag('session'))); break;
      case 'ledger': {
        const n = Number(pos[0]) || 20;
        const rows = readLedger(cwd).slice(-n);
        if (has('json')) { out(JSON.stringify(rows, null, 2)); break; }
        if (!rows.length) { out('ledger empty'); break; }
        for (const r of rows) out(`${r.ts.slice(0, 19)}  ${(r.id || '').padEnd(13)}  ${(r.decision || r.result || '').padEnd(7)}  ${(r.kind || '').padEnd(10)}  ${r.summary || r.detail || ''}`);
        break;
      }
      case 'explain': case 'plan': {
        const tool = pos[0];
        if (!tool) { out(`${cmd} <tool> '<json args>'`); process.exit(1); }
        let args = {};
        try { args = pos[1] ? JSON.parse(pos[1]) : {}; } catch { out('args must be JSON'); process.exit(1); }
        const p = loadPolicy(cwd);
        const cls = tool === 'Bash' ? classifyBash(args.command, p) : classify(tool, args, p);
        const d = decide(cls, p, cwd, { dry: true });
        if (cmd === 'plan' && cls.gated) appendLedger(cwd, { id: cls.id, tool, kind: cls.kind, summary: cls.summary, decision: 'planned', reason: flag('why') || '' });
        out(`${cls.id}  kind=${cls.kind}  gated=${cls.gated}\n${cls.summary || '(read: passes silently)'}\nwould: ${d.decision}${d.reason ? '  ' + d.reason.split('\n')[0] : ''}`);
        if (cmd === 'plan' && cls.gated && p.mode === 'twokey' && d.decision === 'deny' && !/cap|allowed_accounts|block_activate/.test(d.reason)) {
          out(`\nHuman: to release the brake for this one change, run in your own terminal:\n  handbrake approve ${cls.id}`);
        }
        break;
      }
      case 'approve': {
        if (!pos[0]) { out('approve <id>'); process.exit(1); }
        const t = approve(cwd, pos[0], flag('ttl'), flag('note') || '');
        out(`approved ${t.id} until ${t.expires}. The agent may now make exactly that change, once.`);
        break;
      }
      case 'deny': out(revoke(cwd, pos[0]) ? `revoked ${pos[0]}` : `no token ${pos[0]}`); break;
      case 'policy': {
        if (pos[0] === 'set') {
          const p = loadPolicy(cwd);
          if (!(pos[1] in DEFAULT_POLICY)) { out(`unknown key ${pos[1]}. keys: ${Object.keys(DEFAULT_POLICY).join(', ')}`); process.exit(1); }
          let v; try { v = JSON.parse(pos[2]); } catch { v = pos[2]; }
          p[pos[1]] = v; savePolicy(cwd, p); out(`${pos[1]} = ${JSON.stringify(v)}`); break;
        }
        const { _missing, _corrupt, ...p } = loadPolicy(cwd);
        out(JSON.stringify(p, null, 2) + (_missing ? '\n(defaults, not yet written. run handbrake init)' : ''));
        break;
      }
      case 'audit': {
        const f = pos[0];
        if (!f || !existsSync(f)) { out('audit <insights.json> [--previous <file>]'); process.exit(1); }
        const prevF = flag('previous');
        const rep = audit(JSON.parse(readFileSync(f, 'utf8')), prevF && existsSync(prevF) ? JSON.parse(readFileSync(prevF, 'utf8')) : null);
        if (has('json')) { out(JSON.stringify(rep, null, 2)); break; }
        out(`handbrake audit: ${rep.rows} rows, spend ${rep.spend.toFixed(2)}, ${rep.flags.length} flag${rep.flags.length === 1 ? '' : 's'}`);
        for (const fl of rep.flags) out(`  [${fl.sev}] ${fl.check}: ${fl.detail}\n         -> ${fl.propose}`);
        if (!rep.flags.length) out('  nothing drifted on these checks. That is a statement about these rows, not about customer quality.');
        break;
      }
      case 'version': out(VERSION); break;
      default: out(HELP); process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
    }
  } catch (e) { process.stderr.write(`handbrake: ${e.message}\n`); process.exit(1); }
}
