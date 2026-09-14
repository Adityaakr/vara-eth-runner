import { describe, expect, it } from 'vitest';
import { statsFor, summarize, type WriteRecord } from '../src/timeline.js';

describe('timeline stats', () => {
  it('summarize computes order statistics', () => {
    expect(summarize([])).toBeNull();
    expect(summarize([5, 1, 3])).toEqual({ count: 3, p50: 3, p95: 5, min: 1, max: 5 });
    expect(summarize([1, 2])?.p50).toBe(1);
    expect(summarize(Array.from({ length: 20 }, (_, i) => i + 1))?.p95).toBe(19);
  });

  it('statsFor only uses records with both endpoints and no error', () => {
    const base = { path: 'injected' as const, label: '', payload: '0x' as const, submittedAt: 0 };
    const records: WriteRecord[] = [
      { ...base, n: 1, tSubmit: 0, tPreconf: 10, tCommitted: 1000 },
      { ...base, n: 2, tSubmit: 0, tPreconf: 30 },
      { ...base, n: 3, tSubmit: 0, tPreconf: 999, error: 'purged' },
      { ...base, n: 4, path: 'l1', tSubmit: 0, tL1Mined: 500, tCommitted: 1500 },
    ];
    const inj = statsFor(records, 'injected');
    expect(inj.submitToPreconf).toEqual({ count: 2, p50: 10, p95: 30, min: 10, max: 30 });
    expect(inj.preconfToCommitted).toEqual({ count: 1, p50: 990, p95: 990, min: 990, max: 990 });
    expect(inj.submitToL1Mined).toBeNull();
    expect(inj.excluded).toEqual({ errored: 1, uncommitted: 1 });
    const l1 = statsFor(records, 'l1');
    expect(l1.submitToCommitted?.p50).toBe(1500);
  });
});
