// Tests for the pure helpers in the agent layer. Run with: npm test
// Engine tests (debt, cash-flow, tax, ...) arrive with their engines in later phases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveMerchantToken, isGenericCounterparty, incomeSourceTag, extraTagsFor, nyDateStr } from '../lib/firefly.js';
import { chunk, extractJson, normalizeGuess } from '../lib/anthropic.js';
import { catButton, buildAsk, buildHeartbeat, formatAmount } from '../lib/discord.js';
import { CATEGORY_SET, detectIncomeSource } from '../lib/categories.js';

test('deriveMerchantToken strips trailing store numbers', () => {
  assert.equal(deriveMerchantToken({ merchant: 'WALMART #4581 HUNTINGTON WV', description: '' }), 'WALMART');
  assert.equal(deriveMerchantToken({ merchant: 'Netflix', description: '' }), 'Netflix');
  // Digit runs of 3+ and their tails are treated as store numbers and stripped.
  assert.equal(deriveMerchantToken({ merchant: '', description: 'KROGER 738 FUEL' }), 'KROGER');
  assert.equal(deriveMerchantToken({ merchant: '', description: '' }), '');
});

test('incomeSourceTag slugs known sources and rejects empties', () => {
  assert.equal(incomeSourceTag('Blenko'), 'income-source:blenko');
  assert.equal(incomeSourceTag('Redshirt Cloud'), 'income-source:redshirt-cloud');
  assert.equal(incomeSourceTag('Neptune Political'), 'income-source:neptune-political');
  assert.equal(incomeSourceTag(''), null);
  assert.equal(incomeSourceTag(null), null);
  assert.equal(incomeSourceTag('  '), null);
});

test('nyDateStr formats YYYY-MM-DD in America/New_York', () => {
  // 2026-01-01T03:00Z is still 2025-12-31 in New York.
  assert.equal(nyDateStr(new Date('2026-01-01T03:00:00Z')), '2025-12-31');
  assert.equal(nyDateStr(new Date('2026-07-12T16:00:00Z')), '2026-07-12');
  assert.match(nyDateStr(), /^\d{4}-\d{2}-\d{2}$/);
});

test('chunk splits arrays, preserves order, rejects bad sizes', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 10), []);
  assert.deepEqual(chunk([1], 1), [[1]]);
  assert.throws(() => chunk([1, 2], 0), RangeError); // size 0 would loop forever
  assert.throws(() => chunk([1, 2], NaN), RangeError);
});

test('detectIncomeSource matches known payers by any token, case-insensitive', () => {
  assert.equal(detectIncomeSource('BLENKO GLASS CO', 'PAYROLL'), 'Blenko');
  assert.equal(detectIncomeSource('', 'redshirt cloud llc invoice 12'), 'Redshirt Cloud');
  // Redshirt pays personal checking under its payroll entity "WV CSP LLC".
  assert.equal(detectIncomeSource('WV CSP LLC PAYROLL'), 'Redshirt Cloud');
  // Neptune is a client of Redshirt (business, upstream), never a personal source.
  assert.equal(detectIncomeSource('NEPTUNE POLITICAL'), null);
  assert.equal(detectIncomeSource('CHASE BANK', 'interest payment'), null);
  assert.equal(detectIncomeSource(null, undefined, ''), null);
});

test('extraTagsFor applies policy tags by category', () => {
  assert.deepEqual(extraTagsFor('Income', 'Blenko'), ['income-source:blenko']);
  assert.deepEqual(extraTagsFor('Income', null), []);
  assert.deepEqual(extraTagsFor('Business Expense'), ['reimbursable']);
  assert.deepEqual(extraTagsFor('Groceries', 'Blenko'), []);
});

test('normalizeGuess clamps model output to the known taxonomy', () => {
  const good = normalizeGuess({ tx_id: 1, journal_id: 2, category: 'Groceries', confidence: 0.9, alternatives: ['Dining', 'Bogus'], income_source: null });
  assert.equal(good.category, 'Groceries');
  assert.equal(good.journal_id, '2');
  assert.deepEqual(good.alternatives, ['Dining']); // invented alternative dropped

  // An invented category routes to review: Uncategorized at zero confidence.
  const invented = normalizeGuess({ tx_id: 1, journal_id: 2, category: 'Shopping', confidence: 0.95 });
  assert.equal(invented.category, 'Uncategorized');
  assert.equal(invented.confidence, 0);

  // An invented income source is dropped; a known one passes.
  assert.equal(normalizeGuess({ tx_id: 1, journal_id: 2, category: 'Income', confidence: 0.9, income_source: 'Chase Bank' }).income_source, null);
  assert.equal(normalizeGuess({ tx_id: 1, journal_id: 2, category: 'Income', confidence: 0.9, income_source: 'Blenko' }).income_source, 'Blenko');
  assert.ok(CATEGORY_SET.has('Income'));
});

test('extractJson tolerates fences and surrounding prose', () => {
  assert.deepEqual(extractJson('```json\n[{"a":1}]\n```'), [{ a: 1 }]);
  assert.deepEqual(extractJson('Here you go: [{"a":1},{"b":2}] hope that helps'), [{ a: 1 }, { b: 2 }]);
  assert.throws(() => extractJson('[{"a":1},{"b":'), SyntaxError); // truncated output must fail loudly
});

test('catButton refuses to truncate an over-long custom_id', () => {
  const ok = catButton('123', '456', 'Groceries', true);
  assert.equal(ok.custom_id, 'cat|123|456|Groceries');
  assert.equal(ok.style, 1);
  const tooLong = catButton('9'.repeat(40), '9'.repeat(40), 'Business Expense');
  assert.equal(tooLong, null);
});

test('buildAsk dedupes categories, drops unfit buttons, keeps Other', () => {
  const item = { tx_id: '11', journal_id: '22', type: 'withdrawal', merchant: 'KROGER', amount: '42.10', currency: 'USD', date: '2026-07-10', account: 'Checking' };
  const guess = { category: 'Groceries', confidence: 0.55, alternatives: ['Groceries', 'Dining'] };
  const ask = buildAsk(item, guess);
  const buttons = ask.components[0].components;
  assert.equal(buttons.length, 3); // Groceries, Dining, Other
  assert.equal(buttons[0].custom_id, 'cat|11|22|Groceries');
  assert.equal(buttons[2].custom_id, 'other|11|22');
  assert.equal(ask.embeds[0].fields[0].name, 'Merchant');
});

test('generic counterparties never seed rules', () => {
  assert.equal(isGenericCounterparty('Cash account'), true);
  assert.equal(isGenericCounterparty('cash wallet'), true);
  assert.equal(isGenericCounterparty('(cash)'), true);
  assert.equal(isGenericCounterparty(''), true);
  assert.equal(isGenericCounterparty('KROGER'), false);
  assert.equal(isGenericCounterparty('Cash App *Payment'), false); // a real merchant containing cash still passes
});

test('formatAmount renders money to 2 decimals and survives junk', () => {
  assert.equal(formatAmount('12.340000000000', 'USD'), '12.34 USD');
  assert.equal(formatAmount('1499.9', 'USD'), '1,499.90 USD');
  assert.equal(formatAmount('garbage', 'USD'), 'garbage USD'); // never hide the raw value
  assert.equal(formatAmount(5, ''), '5.00');
  assert.equal(formatAmount(null, 'USD'), 'n/a USD'); // missing is missing, never a fabricated 0.00
  assert.equal(formatAmount('', 'USD'), 'n/a USD');
  assert.equal(formatAmount(0, 'USD'), '0.00 USD'); // a real zero still renders
});

test('buildHeartbeat v2 leads with the snapshot and colors by attention', () => {
  const calm = buildHeartbeat('Fincore daily: 3 auto-categorized, 0 need your review.\nSnapshot: net worth $10.00, DTI 30.0%.');
  assert.equal(calm.embeds[0].title, 'Fincore daily');
  // Snapshot headline first; routine head counts fold into the quiet plumbing line.
  assert.ok(calm.embeds[0].description.startsWith('📊 Net worth $10.00 · DTI 30.0%'));
  assert.ok(calm.embeds[0].description.includes('🔧 3 categorized · 0 to review'));
  assert.equal(calm.embeds[0].color, 0x2e8b57);

  const alarmed = buildHeartbeat('Fincore daily: 0 auto-categorized, 0 need your review.\nSTALE FEEDS: bank:1:Checking (9d)');
  assert.equal(alarmed.embeds[0].color, 0xe0a500);
  assert.ok(alarmed.embeds[0].description.includes('⚠️ stale feed: Checking (9d)'));

  // Other jobs keep their own name in the title, and failures read as failures.
  const backup = buildHeartbeat('Fincore backup FAILED: FINCORE_BACKUP_DIR /mnt/backups does not exist. Is the backup mount down?');
  assert.equal(backup.embeds[0].title, 'Fincore backup');
  assert.equal(backup.embeds[0].color, 0xe0a500);
  assert.ok(backup.embeds[0].description.includes('FAILED'));
});

test('buildHeartbeat exposes hasAttention so quiet mode can gate the send', () => {
  // Calm daily: routine counts + healthy snapshot -> no attention, no send.
  const calm = buildHeartbeat('Fincore daily: 3 auto-categorized, 2 queued for review.\nSnapshot: net worth $10.00, DTI 30.0%.');
  assert.equal(calm.hasAttention, false);

  // A stale feed is exactly what Discord is still for.
  const stale = buildHeartbeat('Fincore daily: 0 auto-categorized, 0 queued for review.\nSTALE FEEDS: bank:1:Checking (9d)');
  assert.equal(stale.hasAttention, true);

  // Failures always alert, whichever job they come from.
  const failed = buildHeartbeat('Fincore backup FAILED: mount missing');
  assert.equal(failed.hasAttention, true);

  // Loud playbook lines (windfall, overdue influx, reconcile drift) alert too.
  const loud = buildHeartbeat('Fincore daily: 1 auto-categorized, 0 queued for review.\nInflux overdue: OVERDUE: day 61 of the draw cycle');
  assert.equal(loud.hasAttention, true);
});

test('buildHeartbeat v2 compresses plumbing, keeps attention loud, dedupes prefixes and the Schwab nag', () => {
  const msg = [
    'Fincore daily: no new transactions to categorize.',
    'Sync: 2 imported.',
    'Matching: 1 transfers matched, 5 ambiguous queued.',
    'Valuations: 16 account balances ingested.',
    'Loans: 2 loan balance(s) already exact.',
    'Tax set-aside: Tax set-aside short $13,599.24, 158d to checkpoint 2027-01-15.',
    'Influx overdue: OVERDUE: no Redshirt deposit in 60d since 2026-06-11; expected by 2026-08-06. Buffer runway ~5.2 weeks.',
    'Debts (avalanche): Discover $20,672 (~$491/mo) -> Apple $5,003 (~$106/mo) -> Affirm $4,483 (~$86/mo). Next strike target: Discover.',
    'Playbook flag: STRAGGLER on Discover: 2026-08-04 $115.46 STATE FARM INSURANCE',
    'Schwab flag: Schwab analytics token expired (net worth unaffected). Renew when convenient: npm run schwab-auth',
    'Schwab flag: Schwab token missing or expired; run: npm run schwab-auth',
    'Snapshot: net worth $98,641.37, DTI 15.4% (partial basis). 12 data flags; run npm run snapshot for detail. STALE: schwab, schwab-positions/analytics-only (as of 2026-07-30).',
  ].join('\n');
  const d = buildHeartbeat(msg).embeds[0].description;
  const groups = d.split('\n\n');
  // Snapshot headline, attention, plan, quiet plumbing: exactly four groups.
  assert.equal(groups.length, 4);
  assert.equal(groups[0], '📊 Net worth $98,641.37 · DTI 15.4% (partial)');
  assert.ok(groups[1].includes('Influx OVERDUE: no Redshirt deposit in 60d'));
  assert.ok(groups[1].includes('🚨 STRAGGLER on Discover'));
  assert.ok(groups[2].includes('🧾 Tax set-aside: short $13,599.24'));
  assert.ok(!d.includes('Tax set-aside: Tax set-aside')); // prefix rendered once
  assert.ok(groups[3].includes('🔧 0 to review · sync 2 · match 1 · 5 held · val 16 · loans ✓'));
  assert.ok(groups[3].includes('⚠️ 12 flags (npm run snapshot) · stale: schwab'));
  assert.ok(!groups[3].includes('schwab-positions')); // detail entry collapsed into schwab
  // The chronic Schwab nag survives exactly once, compact.
  assert.equal((d.match(/Schwab token expired/g) || []).length, 1);
});

test('buildAsk labels deposits as deposits', () => {
  const item = { tx_id: '11', journal_id: '22', type: 'deposit', merchant: 'BLENKO GLASS', amount: '1500.00', currency: 'USD', date: '2026-07-10', account: 'Checking' };
  const ask = buildAsk(item, { category: 'Income', confidence: 0.6, alternatives: [] });
  assert.equal(ask.embeds[0].fields[0].name, 'Deposit from');
});
