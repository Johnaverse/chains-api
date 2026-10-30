import { getCachedData } from '../store/cache.js';
import { validateChainData } from './validation.js';

// The report runs every rule over every chain. A chain profile asks for its own slice on each
// visit, so the full report is kept for a short while per data load instead of rebuilt per call.
const REPORT_TTL_MS = 60000;
let memo = null;

/**
 * The validation report, reused for REPORT_TTL_MS while the loaded data is unchanged. `validate`
 * is the caller's own validateChainData (the MCP tools take theirs from dataService.js).
 */
export function validationReport(validate = validateChainData, now = Date.now()) {
  const key = getCachedData()?.lastUpdated ?? null;
  if (key != null && memo && memo.key === key && memo.validate === validate && now - memo.at < REPORT_TTL_MS) return memo.results;
  const results = validate();
  // Kept only for a loaded data set; an error ("data not loaded") is never kept.
  memo = key != null && !results?.error ? { key, validate, at: now, results } : null;
  return results;
}

export function clearValidationReport() { memo = null; }

/** One chain's slice of the report: its findings, by rule, with only the rules that have any. */
export function findingsForChain(results, chainId) {
  const allErrors = (results.allErrors || []).filter(e => e.chainId === chainId);
  const errorsByRule = {};
  for (const [rule, list] of Object.entries(results.errorsByRule || {})) {
    const mine = (list || []).filter(e => e.chainId === chainId);
    if (mine.length) errorsByRule[rule] = mine;
  }
  const bySeverity = { error: 0, notice: 0 };
  for (const e of allErrors) bySeverity[e.severity === 'notice' ? 'notice' : 'error'] += 1;
  return { chainId, totalErrors: allErrors.length, bySeverity, errorsByRule, allErrors };
}
