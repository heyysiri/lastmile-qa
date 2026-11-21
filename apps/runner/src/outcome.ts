import type { AssertionResult, Verdict } from '@lastmile/contracts';
export function classifyOutcome(assertions:AssertionResult[],executionComplete:boolean):Verdict {
  if(!executionComplete||!assertions.length||assertions.some(a=>a.status==='not_evaluated')) return 'inconclusive';
  return assertions.every(a=>a.status==='passed')?'passed':'failed';
}
