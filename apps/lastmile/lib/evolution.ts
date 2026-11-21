import { useEffect } from 'react';
import type { PopulationExecutionDetail } from '@lastmile/contracts/populations';

export const repairHref = (id: string) => `/repairs/${encodeURIComponent(id)}`;

export function canPrepareRepair(execution: PopulationExecutionDetail) {
  if (execution.mode !== 'checkpoint' || execution.status !== 'completed') return false;
  const comparisons = execution.comparisons ?? [];
  return comparisons.some(item => item.outcome === 'regression')
    && comparisons.some(item => item.outcome === 'still_passing')
    && !comparisons.some(item => item.outcome === 'inconclusive');
}

export function useJobPolling(active: boolean, loading: boolean, reload: () => Promise<void>) {
  useEffect(() => {
    if (!active || loading) return;
    const timer = setTimeout(() => void reload(), 1500);
    return () => clearTimeout(timer);
  }, [active, loading, reload]);
}
