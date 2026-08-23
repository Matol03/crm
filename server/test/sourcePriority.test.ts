import { describe, it, expect } from 'vitest';
import { parseCardName, reconcileName } from '../src/extraction/sourcePriority.js';

describe('parseCardName', () => {
  it('reads a Name: line (EN and RU labels)', () => {
    expect(parseCardName('Name: Anna Weber\nCompany: BMW')).toBe('Anna Weber');
    expect(parseCardName('Имя: Иван Петров')).toBe('Иван Петров');
    expect(parseCardName('Company: X')).toBeNull();
    expect(parseCardName(null)).toBeNull();
  });
});

describe('reconcileName (card > text > voice, S8)', () => {
  it('keeps the name when card agrees (or no card name)', () => {
    expect(reconcileName('Anna Weber', 'Name: Anna Weber').warning).toBeNull();
    expect(reconcileName('Anna Weber', 'Company: BMW').warning).toBeNull();
  });

  it('resolves a genuine conflict in favor of the card, with a warning', () => {
    const r = reconcileName('Sasha Petrov', 'Name: Aleksandr Ivanovich Petrov');
    expect(r.name).toBe('Aleksandr Ivanovich Petrov');
    expect(r.warning).toMatch(/name conflict/);
  });

  it('adopts the card name when the extractor dropped it', () => {
    const r = reconcileName(null, 'Name: Yuki Tanaka');
    expect(r.name).toBe('Yuki Tanaka');
    expect(r.warning).toMatch(/business card/);
  });
});
