import { describe, it, expect } from 'vitest';
import { learnForkWords, isGenericForkWord } from '../../../src/domain/forkWords.js';
import { FORK_TITLE_MENTIONS } from '../../fixtures/structuralWords.js';

const titled = (title, name, url = title) => ({ title, url, enrichment: { fork: { name } } });

describe('generic fork-name words, learned from the feeds', () => {
  it('learns the words the classifier drops from the names of the forks titled with them', () => {
    learnForkWords(FORK_TITLE_MENTIONS);
    for (const w of ['upgrade', 'hard', 'fork', 'mandatory', 'release', 'node', 'the', 'Mainnet']) expect(isGenericForkWord(w)).toBe(true);
    for (const w of ['glamsterdam', 'celadon', 'jenner', 'v0']) expect(isGenericForkWord(w)).toBe(false);
  });

  it('keeps a codename, and does not judge a word on too few titles', () => {
    learnForkWords([
      titled('Gravity Alpha upgrade', 'Alpha'), titled('Alpha hard fork live', 'Alpha'), titled('Alpha release', 'Alpha'),
      titled('Rare word once', 'X')
    ]);
    expect(isGenericForkWord('alpha')).toBe(false);
    expect(isGenericForkWord('rare')).toBe(false);
  });

  it('counts an item announcing several forks once', () => {
    // A roadmap post listing seven forks is one title carrying "maxwell", kept in one of its names.
    const roadmap = (url) => ['Maxwell', 'A1', 'A2', 'A3', 'A4', 'A5', 'A6'].map((name) => titled('Roadmap: Maxwell and six more', name, url));
    learnForkWords([...roadmap('u1'), ...roadmap('u2'), ...roadmap('u3')]);
    expect(isGenericForkWord('maxwell')).toBe(false);
    expect(isGenericForkWord('roadmap')).toBe(true);
  });
});
