import {
  computeRecordDuplicateScore,
  findDuplicateCandidates,
  normalizeDomain,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '../computeRecordDuplicateScore';

describe('normalizeName', () => {
  it('strips legal suffixes so an acquisition is not a second company', () => {
    expect(normalizeName('Acme Ltd.')).toBe(normalizeName('Acme Limited'));
    expect(normalizeName('Acme Inc')).toBe('acme');
    expect(normalizeName('上海云帆科技有限公司')).toBe('上海云帆科技');
  });

  it('drops punctuation and casing', () => {
    expect(normalizeName('  ACME-Trading (Shanghai)  ')).toBe('acmetradingshanghai');
  });

  it('returns an empty string for missing values', () => {
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(undefined)).toBe('');
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims', () => {
    expect(normalizeEmail(' Buyer@Example.COM ')).toBe('buyer@example.com');
  });
});

describe('normalizePhone', () => {
  it('compares the last nine digits so country prefixes do not split a contact', () => {
    expect(normalizePhone('+86 138 0013 8000')).toBe(normalizePhone('013800138000'));
  });

  it('keeps short numbers untouched', () => {
    expect(normalizePhone('12345')).toBe('12345');
  });
});

describe('normalizeDomain', () => {
  it('drops scheme, www and path', () => {
    expect(normalizeDomain('https://www.Acme.com/pricing?ref=crm')).toBe('acme.com');
  });
});

describe('computeRecordDuplicateScore', () => {
  it('treats a shared email as a duplicate regardless of the name', () => {
    const score = computeRecordDuplicateScore({
      left: { name: 'Acme Trading', emails: ['buyer@acme.com'] },
      right: { name: 'Acme Trading (Shanghai)', emails: ['BUYER@acme.com'] },
    });

    expect(score.verdict).toBe('duplicate');
    expect(score.signals.map((signal) => signal.kind)).toContain('email');
  });

  it('scores an identical name with different legal suffix as a duplicate', () => {
    const score = computeRecordDuplicateScore({
      left: { name: 'Acme Trading Ltd' },
      right: { name: 'Acme Trading Limited' },
    });

    expect(score.verdict).toBe('duplicate');
    expect(score.signals).toHaveLength(1);
  });

  it('puts a contained name in the review band rather than calling it a duplicate', () => {
    const score = computeRecordDuplicateScore({
      left: { name: 'Shanghai Acme Trading Co' },
      right: { name: 'Acme Trading' },
    });

    expect(score.verdict).toBe('review');
    expect(score.signals.map((signal) => signal.kind)).toEqual(['normalizedName']);
  });

  it('combines independent signals without exceeding certainty', () => {
    const score = computeRecordDuplicateScore({
      left: { name: 'Acme Ltd', emails: ['buyer@acme.com'], phones: ['13800138000'], domainName: 'acme.com' },
      right: { name: 'Acme Limited', emails: ['buyer@acme.com'], phones: ['+86 138 0013 8000'], domainName: 'https://www.acme.com' },
    });

    expect(score.score).toBeLessThanOrEqual(1);
    expect(score.signals).toHaveLength(4);
    expect(score.verdict).toBe('duplicate');
  });

  it('keeps unrelated companies distinct', () => {
    const score = computeRecordDuplicateScore({
      left: { name: 'Acme Trading', emails: ['buyer@acme.com'], domainName: 'acme.com' },
      right: { name: 'Globex', emails: ['buyer@globex.com'], domainName: 'globex.com' },
    });

    expect(score.verdict).toBe('distinct');
    expect(score.signals).toEqual([]);
  });

  it('ignores empty strings instead of matching them', () => {
    const score = computeRecordDuplicateScore({
      left: { name: '', emails: [''], phones: [''], domainName: '' },
      right: { name: '', emails: [''], phones: [''], domainName: '' },
    });

    expect(score.score).toBe(0);
    expect(score.verdict).toBe('distinct');
  });
});

describe('findDuplicateCandidates', () => {
  const target = { id: 'a', name: 'Acme Ltd', emails: ['buyer@acme.com'], domainName: 'acme.com' };
  const pool = [
    target,
    { id: 'b', name: 'Acme Limited', emails: ['buyer@acme.com'] },
    { id: 'c', name: 'Globex', emails: ['buyer@globex.com'] },
  ];

  it('excludes the record itself and sorts by score', () => {
    const candidates = findDuplicateCandidates({ target, pool });

    expect(candidates.map((entry) => entry.record.id)).toEqual(['b']);
    expect(candidates[0].score.verdict).toBe('duplicate');
  });

  it('honours the minimum verdict threshold', () => {
    expect(findDuplicateCandidates({ target, pool, minimumVerdict: 'duplicate' }).map((entry) => entry.record.id)).toEqual([
      'b',
    ]);
    expect(findDuplicateCandidates({ target, pool, minimumVerdict: 'distinct' }).map((entry) => entry.record.id)).toEqual([
      'b',
    ]);
  });
});
