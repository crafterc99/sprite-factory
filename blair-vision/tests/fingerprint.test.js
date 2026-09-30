import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { sha256, normalizeText, fingerprintQuestion } from '../src/content/fingerprint.js';

describe('sha256', () => {
  it.each(['', 'abc', 'What planet is largest?', 'x'.repeat(1000), 'héllo wörld ✓'])('matches node crypto for %j', (s) => {
    expect(sha256(s)).toBe(createHash('sha256').update(s).digest('hex'));
  });
});

describe('fingerprintQuestion', () => {
  const choices = [{ id: 'A', text: 'Earth' }, { id: 'B', text: 'Mars' }, { id: 'C', text: 'Jupiter' }];
  it('is deterministic and ignores whitespace/case noise', () => {
    const a = fingerprintQuestion('What planet is largest?', choices);
    const b = fingerprintQuestion('  what   PLANET is largest? ', choices.map((c) => ({ ...c, text: ` ${c.text.toUpperCase()}\n` })));
    expect(a).toEqual(b);
  });
  it('changes when the question changes', () => {
    expect(fingerprintQuestion('Q1', choices).fingerprint).not.toBe(fingerprintQuestion('Q2', choices).fingerprint);
  });
  it('reordering changes fingerprint (letter must be re-evaluated) but not contentKey (cache still valid)', () => {
    const reordered = [choices[2], choices[0], choices[1]].map((c, i) => ({ ...c, id: 'ABC'[i] }));
    const a = fingerprintQuestion('Q', choices), b = fingerprintQuestion('Q', reordered);
    expect(a.fingerprint).not.toBe(b.fingerprint);
    expect(a.contentKey).toBe(b.contentKey);
  });
  it('normalizeText strips zero-width chars', () => {
    expect(normalizeText('a​b  c')).toBe('ab c');
  });
});
