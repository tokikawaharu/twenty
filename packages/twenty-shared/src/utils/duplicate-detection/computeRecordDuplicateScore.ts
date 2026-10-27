type DuplicateFieldValue = string | null | undefined;

export type RecordForDuplicateCheck = {
  name?: DuplicateFieldValue;
  emails?: DuplicateFieldValue[];
  phones?: DuplicateFieldValue[];
  domainName?: DuplicateFieldValue;
};

export type DuplicateSignal = {
  kind: 'legalName' | 'normalizedName' | 'email' | 'phone' | 'domain';
  weight: number;
  detail: string;
};

export type DuplicateScore = {
  score: number;
  signals: DuplicateSignal[];
  verdict: 'duplicate' | 'review' | 'distinct';
};

// Legal suffixes are noise for comparison: "Acme Ltd" and "Acme" are the same buyer,
// and a CRM that treats them as two companies splits the pipeline across both.
const LEGAL_SUFFIXES = [
  'ltd',
  'limited',
  'llc',
  'inc',
  'incorporated',
  'gmbh',
  'sarl',
  'bv',
  'ag',
  'sa',
  'pte',
  'pty',
  'co',
  'corp',
  'corporation',
  'company',
  '有限公司',
  '有限责任公司',
  '股份有限公司',
  '集团',
  '公司',
];

const DUPLICATE_THRESHOLD = 0.75;
const REVIEW_THRESHOLD = 0.45;

export const normalizeName = (value: DuplicateFieldValue): string => {
  if (typeof value !== 'string') {
    return '';
  }

  let normalized = value
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_.,'"()&/\\]+/g, '');

  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (normalized.length > suffix.length && normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        changed = true;
      }
    }
  }

  return normalized;
};

export const normalizeEmail = (value: DuplicateFieldValue): string => {
  if (typeof value !== 'string') {
    return '';
  }

  return value.trim().toLowerCase();
};

export const normalizePhone = (value: DuplicateFieldValue): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const digits = value.replace(/\D+/g, '');

  // Keep the last 9 digits: country and trunk prefixes vary while the subscriber
  // number stays stable, so "+86 138 0013 8000" and "013800138000" can match.
  return digits.length > 9 ? digits.slice(-9) : digits;
};

export const normalizeDomain = (value: DuplicateFieldValue): string => {
  if (typeof value !== 'string') {
    return '';
  }

  const withoutScheme = value
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/^www\./, '')
    .replace(/\/.*$/, '');

  return withoutScheme;
};

const intersect = (left: string[], right: string[]): string[] => {
  const rightSet = new Set(right);

  return [...new Set(left.filter((value) => value !== '' && rightSet.has(value)))];
};

export const computeRecordDuplicateScore = ({
  left,
  right,
}: {
  left: RecordForDuplicateCheck;
  right: RecordForDuplicateCheck;
}): DuplicateScore => {
  const signals: DuplicateSignal[] = [];

  const leftName = normalizeName(left.name);
  const rightName = normalizeName(right.name);

  if (leftName !== '' && leftName === rightName) {
    signals.push({ kind: 'legalName', weight: 0.8, detail: `names are identical after suffix removal: ${leftName}` });
  }

  const sharedEmails = intersect(
    (left.emails ?? []).map(normalizeEmail),
    (right.emails ?? []).map(normalizeEmail),
  );

  if (sharedEmails.length > 0) {
    signals.push({ kind: 'email', weight: 0.8, detail: `shared email(s): ${sharedEmails.join(', ')}` });
  }

  const sharedPhones = intersect(
    (left.phones ?? []).map(normalizePhone),
    (right.phones ?? []).map(normalizePhone),
  );

  if (sharedPhones.length > 0) {
    signals.push({ kind: 'phone', weight: 0.5, detail: `shared phone(s): ${sharedPhones.join(', ')}` });
  }

  const leftDomain = normalizeDomain(left.domainName);
  const rightDomain = normalizeDomain(right.domainName);

  if (leftDomain !== '' && leftDomain === rightDomain) {
    signals.push({ kind: 'domain', weight: 0.45, detail: `same domain: ${leftDomain}` });
  }

  // Substring overlap on the normalised name is weaker than an exact match but
  // still worth surfacing: "Shanghai Acme Trading" and "Acme Trading Co" are the
  // same buyer written by two salespeople.
  if (leftName !== '' && rightName !== '' && leftName !== rightName) {
    const [shorter, longer] = leftName.length <= rightName.length ? [leftName, rightName] : [rightName, leftName];

    if (shorter.length >= 4 && longer.includes(shorter)) {
      signals.push({ kind: 'normalizedName', weight: 0.5, detail: `name contained: ${shorter}` });
    }
  }

  // Independent signals must not compound past certainty, so the weights are
  // combined as a noisy-or rather than summed.
  const score = signals.reduce((accumulator, signal) => accumulator + (1 - accumulator) * signal.weight, 0);
  const rounded = Math.round(score * 1000) / 1000;

  const verdict: DuplicateScore['verdict'] =
    rounded >= DUPLICATE_THRESHOLD ? 'duplicate' : rounded >= REVIEW_THRESHOLD ? 'review' : 'distinct';

  return { score: rounded, signals, verdict };
};

export const findDuplicateCandidates = <RecordType extends RecordForDuplicateCheck & { id: string }>({
  target,
  pool,
  minimumVerdict = 'review',
}: {
  target: RecordType;
  pool: RecordType[];
  minimumVerdict?: DuplicateScore['verdict'];
}): { record: RecordType; score: DuplicateScore }[] => {
  const order: DuplicateScore['verdict'][] = ['distinct', 'review', 'duplicate'];
  const minimumIndex = order.indexOf(minimumVerdict);

  return pool
    .filter((candidate) => candidate.id !== target.id)
    .map((candidate) => ({ record: candidate, score: computeRecordDuplicateScore({ left: target, right: candidate }) }))
    .filter((entry) => order.indexOf(entry.score.verdict) >= minimumIndex)
    .sort((first, second) => second.score.score - first.score.score);
};
