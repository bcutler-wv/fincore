// Deliberate baseline scope adjustment: shift the frozen baseline by exactly the
// balances that join (or leave) the household picture, so the scoreboard's delta
// stays attributable to behavior rather than to the scope change. First use:
// Mikalia's personal CNB accounts + cards joining (decided 2026-09-11, FACTS.md).
// Unlike correct-baseline.js this works AFTER the 30-day window: it is a re-basing
// of what "the household" means, not a correction of a mismeasured past, and it is
// only honest because the shift equals exactly what joined. Audited, disclosed via
// the cumulative meta total.
//
//   node adjust-baseline-scope.js <delta> "<reason>"                    DRY RUN
//   node adjust-baseline-scope.js <delta> "<reason>" apply              adjust (audited)
//   node adjust-baseline-scope.js <delta> "<reason>" --dti 0.171 --dti-basis "<basis>" apply
//
// <delta> is the signed net worth of the joining accounts (assets positive, card
// balances negative), e.g. 2314.55 or -820.10. Run on pm2-prod (needs fincore.db).
import 'dotenv/config';
import { openStore, baselineState, adjustBaselineScope, getMeta } from './lib/store.js';

const args = process.argv.slice(2);
const apply = args.includes('apply');
const flagVal = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : null;
};
const positional = args.filter((a, i) => a !== 'apply' && !a.startsWith('--') && args[i - 1] !== '--dti' && args[i - 1] !== '--dti-basis');
const delta = Number(positional[0]);
const reason = positional[1];
const dtiRaw = flagVal('--dti');
const dti = dtiRaw === null ? null : Number(dtiRaw);
const dtiBasis = flagVal('--dti-basis');
const ACTOR = 'adjust-baseline-scope';
const money = (n) => (n == null ? 'n/a' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function main() {
  if (!Number.isFinite(delta) || delta === 0 || !reason) {
    console.error('Usage: node adjust-baseline-scope.js <nonzero-delta> "<reason>" [--dti X.XXX] [--dti-basis "..."] [apply]');
    process.exit(1);
  }
  if (dtiRaw !== null && !Number.isFinite(dti)) {
    console.error('--dti must be a number (e.g. 0.171)');
    process.exit(1);
  }

  const db = openStore();
  const state = baselineState(db);
  if (!state.locked) { console.log('No baseline is locked — nothing to adjust.'); db.close(); return; }

  const snapshotDate = getMeta(db, 'baseline_snapshot_date');
  const before = db.prepare('SELECT net_worth, dti, dti_basis FROM nw_dti_series WHERE snapshot_date = ?').get(snapshotDate);
  const priorTotal = Number(getMeta(db, 'baseline_scope_adjust_total') || 0);

  console.log(`Baseline ${snapshotDate}: net worth ${money(before?.net_worth)} | DTI ${before?.dti != null ? (before.dti * 100).toFixed(1) + '%' : 'n/a'}`);
  console.log(`Prior cumulative scope adjustments: ${money(priorTotal)}`);
  console.log(`\nWould adjust: ${money(before?.net_worth)} ${delta >= 0 ? '+' : '-'} ${money(Math.abs(delta))} -> ${money(before.net_worth + delta)}`);
  if (dti !== null) console.log(`Would re-base DTI: ${(before.dti * 100).toFixed(1)}% -> ${(dti * 100).toFixed(1)}%${dtiBasis ? ` (${dtiBasis})` : ''}`);
  console.log(`Reason: ${reason}`);

  if (!apply) { console.log('\nDRY RUN. Re-run with "apply" to adjust (audited).'); db.close(); return; }

  const out = adjustBaselineScope(db, { delta, dti, dtiBasis, reason, actor: ACTOR });
  console.log(`\nBaseline adjusted to ${money(out.netWorth)} (audited; cumulative scope shift ${money(priorTotal + delta)}).`);
  db.close();
}

try { main(); } catch (e) { console.error(e); process.exit(1); }
