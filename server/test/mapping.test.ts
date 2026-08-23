import { describe, it, expect } from 'vitest';
import { mapToListId, editDistance, similarity } from '../src/mapping/index.js';
import { SEED_USERFIELD_VALUES } from '../src/bitrix/mock.js';

const INTEREST = SEED_USERFIELD_VALUES.UF_CRM_PRODUCT_INTEREST!;
const PRIORITY = SEED_USERFIELD_VALUES.UF_CRM_PRIORITY!;
const REGION = SEED_USERFIELD_VALUES.UF_CRM_REGION!;

describe('mapping helpers', () => {
  it('editDistance basic', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('', 'abc')).toBe(3);
    expect(similarity('abc', 'abc')).toBe(1);
  });
});

describe('mapToListId', () => {
  it('exact match (case-insensitive)', () => {
    const r = mapToListId('UF_CRM_PRODUCT_INTEREST', 'analytics', INTEREST);
    expect(r.method).toBe('exact');
    expect(r.id).toBe(73);
  });

  it('synonym match', () => {
    const r = mapToListId('UF_CRM_PRODUCT_INTEREST', 'integration', INTEREST);
    expect(r.method).toBe('synonym');
    expect(r.matchedLabel).toBe('Integration Services');
    expect(r.id).toBe(75);
  });

  it('priority urgent -> High via synonym', () => {
    const r = mapToListId('UF_CRM_PRIORITY', 'urgent', PRIORITY);
    expect(r.id).toBe(83);
  });

  it('region from country synonym', () => {
    expect(mapToListId('UF_CRM_REGION', 'Germany', REGION).id).toBe(49);
    expect(mapToListId('UF_CRM_REGION', 'Kazakhstan', REGION).id).toBe(51);
  });

  it('fuzzy match on a misspelled label (not a synonym substring)', () => {
    const r = mapToListId('UF_CRM_PRODUCT_INTEREST', 'Analitics', INTEREST); // vs "Analytics"
    expect(r.method).toBe('fuzzy');
    expect(r.matchedLabel).toBe('Analytics');
  });

  it('no match -> null (empty beats wrong)', () => {
    const r = mapToListId('UF_CRM_REGION', 'Antarctica', REGION);
    expect(r.id).toBeNull();
    expect(r.method).toBe('none');
  });

  it('empty input -> null', () => {
    expect(mapToListId('UF_CRM_PRIORITY', null, PRIORITY).id).toBeNull();
    expect(mapToListId('UF_CRM_PRIORITY', '   ', PRIORITY).id).toBeNull();
  });
});
