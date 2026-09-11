// Discord message helpers used by agent-daily to post asks and heartbeats.
// Uses @discordjs/rest so the short-lived job never opens a gateway connection.
import 'dotenv/config';
import { REST } from '@discordjs/rest';
import { Routes } from 'discord-api-types/v10';
import { tidyMoney } from './format.js';

let restClient = null;
function rest() {
  if (!restClient) {
    // retries: 0 — the library's default (3) re-POSTs after a response timeout even
    // when the first request actually landed, which double-posts the message
    // (observed 2026-07-30: two identical heartbeats at 7:01). These sends are
    // informational and the off-host dead-man ping covers "did the run happen",
    // so a rare dropped message is the better failure mode than duplicates.
    // The longer timeout absorbs the slow-response case that triggered the retry.
    restClient = new REST({ version: '10', retries: 0, timeout: 30_000 }).setToken(process.env.DISCORD_BOT_TOKEN);
  }
  return restClient;
}

// Button component style + type constants (raw API values).
const TYPE_ACTION_ROW = 1;
const TYPE_BUTTON = 2;
const STYLE_PRIMARY = 1;
const STYLE_SECONDARY = 2;

// custom_id format: cat|<txId>|<journalId>|<category>. Discord caps custom_id at 100
// chars. Never truncate: a cut category would parse as a different (or unknown)
// category on click. If it does not fit, return null and the caller drops the button;
// the Other (reply) path still covers that category.
export function catButton(txId, journalId, category, primary = false) {
  const customId = `cat|${txId}|${journalId}|${category}`;
  if (customId.length > 100) return null;
  return {
    type: TYPE_BUTTON,
    style: primary ? STYLE_PRIMARY : STYLE_SECONDARY,
    label: category.slice(0, 80),
    custom_id: customId,
  };
}

// Firefly amounts arrive as long-precision strings ('12.340000000000'); render as
// money, falling back to the raw string when unparseable rather than hiding it.
export function formatAmount(amount, currency) {
  // A missing amount must read as missing, not as a fabricated $0.00
  // (Number(null) and Number('') are both 0).
  if (amount === null || amount === undefined || String(amount).trim() === '') {
    return `n/a${currency ? ` ${currency}` : ''}`;
  }
  const n = Number(amount);
  const rendered = Number.isFinite(n)
    ? n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : String(amount);
  return `${rendered}${currency ? ` ${currency}` : ''}`;
}

export function buildAsk(item, guess) {
  const cats = [guess.category, ...guess.alternatives].filter(
    (c, i, arr) => c && arr.indexOf(c) === i
  ).slice(0, 3);

  const buttons = cats
    .map((c, i) => catButton(item.tx_id, item.journal_id, c, i === 0))
    .filter(Boolean);
  buttons.push({
    type: TYPE_BUTTON,
    style: STYLE_SECONDARY,
    label: 'Other (reply)',
    custom_id: `other|${item.tx_id}|${item.journal_id}`,
  });

  const direction = item.type === 'deposit' ? 'Deposit from' : 'Merchant';
  const embed = {
    title: 'Categorize this transaction',
    color: 0xe0a500,
    fields: [
      { name: direction, value: (item.merchant || item.description || 'unknown').slice(0, 200), inline: false },
      { name: 'Amount', value: formatAmount(item.amount, item.currency), inline: true },
      { name: 'Date', value: item.date || 'n/a', inline: true },
      { name: 'Account', value: item.account || 'n/a', inline: true },
      { name: 'Best guess', value: `${guess.category} (${Math.round(guess.confidence * 100)}%)`, inline: false },
    ],
    footer: { text: `tx ${item.tx_id}` },
  };

  return {
    embeds: [embed],
    components: [{ type: TYPE_ACTION_ROW, components: buttons }],
  };
}

// Emoji per known line prefix, so the heartbeat scans as sections instead of a wall
// of uniform bullets. First match wins; unknown lines get a plain bullet. Ordered
// specific-before-general (e.g. 'Budgets OVER' before 'Budgets').
const LINE_EMOJI = [
  [/^(Snapshot|Net worth)/i, '📊'],
  [/^Influx overdue/i, '🚨'],
  [/^Paystub/i, '📄'],
  [/^INFLUX/i, '💰'],
  [/^WINDFALL/i, '💰'],
  [/^Tax/i, '🧾'],
  [/^Debts|^Revolving/i, '💳'],
  [/^Budgets OVER/i, '🚨'],
  [/^Budget/i, '📉'],
  [/^Influx (watch|overdue)/i, '⏳'],
  [/^STRAGGLER|^Playbook flag: STRAGGLER/i, '🚨'],
  [/^Bills.*OVERDUE/i, '🚨'],
  [/^Bills/i, '📅'],
  [/^STALE|^Freshness/i, '⚠️'],
  [/^Matching flag|^Sync flag|^Valuations flag|^Loans flag|^Playbook flag|^Reconcile flag|^Schwab flag/i, '⚠️'],
  [/^Matching/i, '🔀'],
  [/^Sync/i, '🔄'],
  [/^Valuations/i, '💼'],
  [/^Loans/i, '🏦'],
  [/^Schwab/i, '📈'],
  [/^Reconcile/i, '🧮'],
  [/failed/i, '🚨'],
];

function emojiFor(line) {
  for (const [re, e] of LINE_EMOJI) if (re.test(line)) return e;
  return '•';
}

// The daily heartbeat, v2 (2026-08-10, "too smashed together" feedback): signal
// first, noise compressed. Order: snapshot headline, attention items, plan
// lines, then all routine plumbing collapsed to one quiet line. Pure; exported
// for tests. Unknown lines fail OPEN into the plan section verbatim — a line
// the compressor does not recognize must never be dropped.

// Routine plumbing line -> short token, or null when the line is not routine.
function plumbingToken(line) {
  let m;
  if ((m = /^Sync: (\d+) imported\.?$/.exec(line))) return `sync ${m[1]}`;
  if ((m = /^Matching: (\d+) transfers matched, (\d+) ambiguous queued\.?$/.exec(line))) return `match ${m[1]} · ${m[2]} held`;
  if ((m = /^Matching: (\d+) ambiguous queued\.?$/.exec(line))) return `match ${m[1]} held`;
  if ((m = /^Valuations: (\d+) account balances? ingested\.?$/.exec(line))) return `val ${m[1]}`;
  if (/^Loans: \d+ loan balance\(s\) already exact\.?$/.test(line)) return 'loans ✓';
  if (/^Loans: \d+ loan balance\(s\) trued to the feed\.?$/.test(line)) return 'loans trued ✓';
  if ((m = /^Budgets: (\d+) transaction\(s\) assigned\.?$/.exec(line))) return `budgets ${m[1]}`;
  if (/^no new transactions to categorize\.?$/i.test(line)) return '0 to review';
  if ((m = /^(\d+) auto-categorized, (\d+) (?:need your review|queued for review)\.?$/.exec(line))) return `${m[1]} categorized · ${m[2]} to review`;
  return null;
}

// Shorten one stale-feed name: drop machine prefixes and as-of parentheticals.
function shortStaleName(name) {
  return name
    .trim()
    .replace(/^bank:\d+:/, '')
    .replace(/^valuation:/, '')
    .replace(/\s*\(as of [^)]*\)/, '')
    .trim();
}

function compressStaleList(names) {
  let list = names.map(shortStaleName).filter(Boolean);
  // schwab-positions/analytics-only is detail of the schwab entry; once is enough.
  if (list.includes('schwab')) list = list.filter((n) => !/^schwab-positions/.test(n));
  list = [...new Set(list)];
  if (list.length > 3) list = [...list.slice(0, 2), `+${list.length - 2} more`];
  return list.join(', ');
}

// Composed lines sometimes repeat their own prefix ("Tax set-aside: Tax
// set-aside short ...", "Influx overdue: OVERDUE: ..."); render it once.
function dedupePrefix(line) {
  return line
    .replace(/^Tax set-aside: Tax set-aside /, 'Tax set-aside: ')
    .replace(/^Influx overdue: OVERDUE: /, 'Influx OVERDUE: ')
    .replace(/^Playbook flag: STRAGGLER/, 'STRAGGLER');
}

export function buildHeartbeat(text) {
  const raw = tidyMoney(text).split('\n').filter((l) => l.trim() !== '');
  const first = raw.shift() ?? '';

  let schwabChronic = null; // the weekly token nag: one compact quiet line
  const plumbing = [];
  const attention = [];
  const plan = [];
  let snapshotMain = null;
  let snapshotAux = null;
  let staleLine = null;

  for (const l of raw) {
    if (/^Schwab flag: Schwab (analytics )?token (missing or )?expired/i.test(l)) {
      schwabChronic = '⚠️ Schwab token expired · npm run schwab-auth';
      continue;
    }
    const m = /^Snapshot: net worth (\$[\d,.]+), DTI ([\d.]+%)( \(partial basis\))?\.?\s*(.*)$/.exec(l);
    if (m) {
      snapshotMain = `📊 Net worth ${m[1]} · DTI ${m[2]}${m[3] ? ' (partial)' : ''}`;
      const aux = [];
      const fm = /(\d+) data flags/.exec(m[4] || '');
      if (fm) aux.push(`${fm[1]} flags (npm run snapshot)`);
      const sm = /STALE: (.*)$/.exec(m[4] || '');
      if (sm) aux.push(`stale: ${compressStaleList(sm[1].split(','))}`);
      if (aux.length) snapshotAux = `⚠️ ${aux.join(' · ')}`;
      continue;
    }
    if (/^STALE FEEDS: /.test(l)) {
      staleLine = `⚠️ stale feed: ${compressStaleList(l.replace(/^STALE FEEDS: /, '').split(','))}`;
      continue;
    }
    const token = plumbingToken(l);
    if (token) {
      plumbing.push(token);
      continue;
    }
    // Loud lines: anything demanding action or reporting an abnormal condition.
    if (/WINDFALL|INFLUX|OVERDUE|STRAGGLER|FAILED|failed|Budgets >80%|Budgets OVER|Paystub:|Reconcile|flag:|drift/i.test(l)) {
      attention.push(`${emojiFor(l)} ${dedupePrefix(l)}`);
      continue;
    }
    plan.push(`${emojiFor(l)} ${dedupePrefix(l)}`);
  }

  // The title comes from the message itself (Fincore daily, Fincore backup, ...);
  // hardcoding one job's name would mislabel the others' failures.
  const titleMatch = first.match(/^(Fincore [a-z]+)\b:?\s*/i);
  const head = titleMatch ? first.slice(titleMatch[0].length) : first;
  const headToken = plumbingToken(head.trim());
  if (headToken) plumbing.unshift(headToken); // routine head counts join the quiet line

  const groups = [];
  if (snapshotMain) groups.push([snapshotMain]);
  if (attention.length) groups.push(attention);
  if (plan.length) groups.push(plan);
  const quiet = [];
  if (plumbing.length) quiet.push(`🔧 ${plumbing.join(' · ')}`);
  if (staleLine) quiet.push(staleLine);
  if (snapshotAux) quiet.push(snapshotAux);
  if (schwabChronic) quiet.push(schwabChronic);
  if (quiet.length) groups.push(quiet);

  const hasAttention =
    attention.length > 0 || staleLine !== null || snapshotAux !== null || /FAILED|failed/.test(first);
  const body = groups.map((g) => g.join('\n')).join('\n\n');
  const embed = {
    title: titleMatch ? titleMatch[1] : 'Fincore',
    description: [...(headToken || head.trim() === '' ? [] : [head, '']), body]
      .join('\n')
      .trim()
      .slice(0, 4000),
    color: hasAttention ? 0xe0a500 : 0x2e8b57,
  };
  return { embeds: [embed], hasAttention };
}

function send(body) {
  return rest().post(Routes.channelMessages(process.env.DISCORD_FINANCE_CHANNEL_ID), { body });
}

export async function sendAsk(item, guess) {
  return send(buildAsk(item, guess));
}

// Quiet mode (2026-09-11 decision): Discord only speaks when something needs a
// human — stale/disconnected feeds, failures, loud playbook events. Routine
// success is silent; reporting moved to on-demand sessions. HEARTBEAT_MODE=always
// restores the old daily send as a rollback valve.
export async function sendHeartbeat(text) {
  const { embeds, hasAttention } = buildHeartbeat(text);
  if (!hasAttention && process.env.HEARTBEAT_MODE !== 'always') {
    return { skipped: true };
  }
  return send({ embeds });
}
