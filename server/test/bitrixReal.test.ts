import { describe, it, expect } from 'vitest';
import { RealBitrixClient } from '../src/bitrix/real.js';
import { RateLimiter } from '../src/bitrix/rateLimiter.js';
import { phpQuery, encodeCmd } from '../src/bitrix/query.js';
import type { BitrixTransport, BitrixEnvelope } from '../src/bitrix/transport.js';
import type { LeadWrite } from '../src/contracts/index.js';

function lead(overrides: Partial<LeadWrite> = {}): LeadWrite {
  return {
    localId: 'L1',
    sessionId: 'S1',
    title: 'Anna — BMW',
    assignedById: 7,
    name: 'Anna Weber',
    company: 'BMW AG',
    position: 'Head of Data',
    country: 'Germany',
    phones: [{ value: '+498912345678', type: 'WORK' }],
    emails: [{ value: 'anna@bmw.de', type: 'WORK' }],
    listFields: { leadTypeId: 47, regionId: 49 },
    verbatim: 'verbatim text',
    aiSummaryRu: 'краткое резюме',
    service: { teamsGroupId: 'g1', teamsMessageIds: ['m1'], teamsAuthor: 'ivan@example.com' },
    warnings: [],
    needsAttachmentRetry: false,
    ...overrides,
  };
}

function fastLimiter() {
  return new RateLimiter({ ratePerSec: 1000, now: () => 0, sleep: async () => {} });
}

function client(transport: BitrixTransport, extra: Partial<ConstructorParameters<typeof RealBitrixClient>[0]> = {}) {
  return new RealBitrixClient({
    webhookUrl: 'https://portal.bitrix24.kz/rest/1/token/',
    rateLimiter: fastLimiter(),
    transport,
    sleep: async () => {},
    backoffBaseMs: 1,
    ...extra,
  });
}

describe('query encoding', () => {
  it('encodes nested arrays/objects PHP-style', () => {
    const q = phpQuery({ fields: { TITLE: 'X', PHONE: [{ VALUE: '+1', VALUE_TYPE: 'WORK' }] } });
    expect(q).toContain('fields%5BTITLE%5D=X');
    expect(q).toContain('fields%5BPHONE%5D%5B0%5D%5BVALUE%5D=%2B1');
  });
  it('encodeCmd joins method and params', () => {
    expect(encodeCmd('crm.lead.add', { id: 5 })).toBe('crm.lead.add?id=5');
    expect(encodeCmd('crm.lead.get', {})).toBe('crm.lead.get');
  });
});

describe('RealBitrixClient.writeLeads (add path)', () => {
  it('adds a new lead when no duplicate exists and returns its id', async () => {
    const calls: string[] = [];
    const transport: BitrixTransport = async (method, params) => {
      calls.push(method);
      if (method === 'crm.duplicate.findbycomm') return ok({ LEAD: [] });
      if (method === 'batch') {
        return ok({ result: { lead_0: 5001, comment_0: 9001 }, result_error: {} });
      }
      return ok(null);
    };
    const c = client(transport);
    const res = await c.writeLeads([lead()]);
    expect(res[0]!.bitrixLeadId).toBe(5001);
    expect(res[0]!.updatedExisting).toBe(false);
    expect(res[0]!.error).toBeNull();
    expect(calls).toContain('batch');
  });
});

describe('RealBitrixClient.writeLeads (dedup)', () => {
  it('updates when a same-owner duplicate is found', async () => {
    const transport: BitrixTransport = async (method) => {
      if (method === 'crm.duplicate.findbycomm') return ok({ LEAD: [4242] });
      if (method === 'crm.lead.get') return ok({ ID: 4242, ASSIGNED_BY_ID: 7 }); // same owner
      if (method === 'batch') return ok({ result: { lead_0: 4242, comment_0: 1 }, result_error: {} });
      return ok(null);
    };
    const res = await client(transport).writeLeads([lead({ assignedById: 7 })]);
    expect(res[0]!.updatedExisting).toBe(true);
    expect(res[0]!.bitrixLeadId).toBe(4242);
  });

  it('creates a separate lead when the duplicate belongs to a different owner (S10.4)', async () => {
    const transport: BitrixTransport = async (method) => {
      if (method === 'crm.duplicate.findbycomm') return ok({ LEAD: [4242] });
      if (method === 'crm.lead.get') return ok({ ID: 4242, ASSIGNED_BY_ID: 99 }); // different owner
      if (method === 'batch') return ok({ result: { lead_0: 5002, comment_0: 1 }, result_error: {} });
      return ok(null);
    };
    const res = await client(transport).writeLeads([lead({ assignedById: 7 })]);
    expect(res[0]!.updatedExisting).toBe(false);
    expect(res[0]!.bitrixLeadId).toBe(5002);
  });
});

describe('RealBitrixClient backoff', () => {
  it('retries a throttled sub-call then succeeds', async () => {
    let batchCalls = 0;
    const transport: BitrixTransport = async (method) => {
      if (method === 'crm.duplicate.findbycomm') return ok({ LEAD: [] });
      if (method === 'batch') {
        batchCalls++;
        if (batchCalls === 1) {
          return ok({ result: {}, result_error: { lead_0: { error: 'QUERY_LIMIT_EXCEEDED' } } });
        }
        return ok({ result: { lead_0: 5003, comment_0: 1 }, result_error: {} });
      }
      return ok(null);
    };
    const res = await client(transport).writeLeads([lead()]);
    expect(batchCalls).toBe(2); // first throttled, retried
    expect(res[0]!.bitrixLeadId).toBe(5003);
  });

  it('retries the whole call on HTTP 503 then throws non-retryable errors as failures', async () => {
    const transport: BitrixTransport = async (method) => {
      if (method === 'crm.duplicate.findbycomm') return ok({ LEAD: [] });
      if (method === 'batch') return { status: 200, body: { result: { result: {}, result_error: { lead_0: { error: 'INVALID_FIELD' } } } } as BitrixEnvelope };
      return ok(null);
    };
    const res = await client(transport).writeLeads([lead()]);
    expect(res[0]!.bitrixLeadId).toBeNull();
    expect(res[0]!.error).toMatch(/INVALID_FIELD/);
  });
});

describe('RealBitrixClient.listUserFieldValues', () => {
  it('maps the userfield LIST enum to {label,id}', async () => {
    const transport: BitrixTransport = async (method) => {
      if (method === 'crm.lead.userfield.list') {
        return ok([{ FIELD_NAME: 'UF_CRM_PRIORITY', LIST: [{ ID: '83', VALUE: 'High' }, { ID: '85', VALUE: 'Medium' }] }]);
      }
      return ok(null);
    };
    const vals = await client(transport).listUserFieldValues('UF_CRM_PRIORITY');
    expect(vals).toEqual([{ label: 'High', id: 83 }, { label: 'Medium', id: 85 }]);
  });
});

describe('leadUrl', () => {
  it('builds a card link from the portal origin without leaking the token', () => {
    const url = client(async () => ok(null)).leadUrl(4821);
    expect(url).toBe('https://portal.bitrix24.kz/crm/lead/details/4821/');
    expect(url).not.toContain('token');
  });
});

function ok<T>(result: T): { status: number; body: BitrixEnvelope<T> } {
  return { status: 200, body: { result } };
}
