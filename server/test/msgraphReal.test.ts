import { describe, it, expect } from 'vitest';
import { RealMsGraphClient, htmlToText, classifyAttachment } from '../src/msgraph/real.js';

const TEAM = 'team-1';
const CHAN = '19:abc@thread.tacv2';

/** Stub fetch: token + Graph routes, no network. */
function stubFetch(routes: {
  messages?: unknown[];
  replies?: Record<string, unknown[]>;
  user?: { mail?: string; userPrincipalName?: string };
  postStatus?: number;
}): { fetchImpl: typeof fetch; posts: string[] } {
  const posts: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    const ok = (body: unknown, status = 200) =>
      ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

    if (u.includes('login.microsoftonline.com')) return ok({ access_token: 't', expires_in: 3600 });
    if (init?.method === 'POST') {
      posts.push(u);
      return ok({}, routes.postStatus ?? 201);
    }
    if (u.includes('/replies')) {
      const id = u.match(/messages\/([^/]+)\/replies/)?.[1] ?? '';
      return ok({ value: routes.replies?.[id] ?? [] });
    }
    if (u.includes('/messages')) return ok({ value: routes.messages ?? [] });
    if (u.includes('/users/')) return ok(routes.user ?? { mail: 'ivan@example.com' });
    return ok({});
  }) as unknown as typeof fetch;
  return { fetchImpl, posts };
}

function client(routes: Parameters<typeof stubFetch>[0], onWarn?: (e: { code: string }) => void) {
  const { fetchImpl, posts } = stubFetch(routes);
  const c = new RealMsGraphClient({
    tenantId: 'tid',
    clientId: 'cid',
    clientSecret: 'secret',
    teamsGroupId: TEAM,
    channelId: CHAN,
    fetchImpl,
    ...(onWarn ? { onWarn } : {}),
  });
  return { c, posts };
}

describe('htmlToText', () => {
  it('strips tags and entities', () => {
    expect(htmlToText('<p>Hello&nbsp;<b>world</b></p>')).toBe('Hello world');
    expect(htmlToText('a<br/>b')).toBe('a\nb');
  });
});

describe('classifyAttachment', () => {
  it('detects images and voice by name or content type', () => {
    expect(classifyAttachment({ name: 'card.PNG' })).toBe('image');
    expect(classifyAttachment({ name: 'note.ogg' })).toBe('voice');
    expect(classifyAttachment({ contentType: 'image/jpeg' })).toBe('image');
    expect(classifyAttachment({ name: 'doc.pdf' })).toBeNull();
  });
});

describe('RealMsGraphClient.getNewChannelMessages', () => {
  const userMsg = {
    id: 'm1',
    messageType: 'message',
    createdDateTime: '2026-08-23T10:00:00Z',
    lastModifiedDateTime: '2026-08-23T10:00:00Z',
    body: { content: '<p>Met Anna Weber from BMW</p>', contentType: 'html' },
    from: { user: { id: 'u1', displayName: 'Ivan Petrov' } },
  };

  it('maps a user text message and resolves the author email', async () => {
    const { c } = client({ messages: [userMsg] });
    const out = await c.getNewChannelMessages('2026-08-23T09:00:00Z');
    expect(out).toHaveLength(1);
    expect(out[0]!.author.email).toBe('ivan@example.com');
    expect(out[0]!.items[0]!.text).toBe('Met Anna Weber from BMW');
  });

  it('filters out messages at or before the watermark', async () => {
    const { c } = client({ messages: [userMsg] });
    expect(await c.getNewChannelMessages('2026-08-23T11:00:00Z')).toHaveLength(0);
  });

  it('skips system events and bot posts', async () => {
    const { c } = client({
      messages: [
        { id: 's1', eventDetail: { '@odata.type': 'memberAdded' }, from: null },
        { id: 'b1', from: { application: { displayName: 'Bot' }, user: null }, body: { content: 'beep' } },
      ],
    });
    expect(await c.getNewChannelMessages('2020-01-01T00:00:00Z')).toHaveLength(0);
  });

  it('emits attachments as attachmentPending with a distinct messageId', async () => {
    const warns: string[] = [];
    const { c } = client(
      {
        messages: [{ ...userMsg, attachments: [{ name: 'card.png', contentUrl: 'https://sp/card.png' }] }],
      },
      (e) => warns.push(e.code),
    );
    const out = await c.getNewChannelMessages('2020-01-01T00:00:00Z');
    const items = out[0]!.items;
    expect(items).toHaveLength(2); // text + image
    const img = items.find((i) => i.type === 'image')!;
    expect(img.attachmentPending).toBe(true);
    expect(img.messageId).toBe('m1:att0'); // distinct from the text item
    expect(warns).toContain('attachment_bytes_unavailable');
  });

  it('includes same-thread replies', async () => {
    const { c } = client({
      messages: [userMsg],
      replies: {
        m1: [
          {
            id: 'r1',
            messageType: 'message',
            lastModifiedDateTime: '2026-08-23T10:02:00Z',
            body: { content: 'forgot: wants a quote Friday' },
            from: { user: { id: 'u1', displayName: 'Ivan Petrov' } },
          },
        ],
      },
    });
    const out = await c.getNewChannelMessages('2020-01-01T00:00:00Z');
    expect(out).toHaveLength(2);
    expect(out[1]!.replyToId).toBe('m1');
  });
});

describe('RealMsGraphClient.postReply', () => {
  it('degrades to a warning (never throws) when Send is not permitted', async () => {
    const warns: string[] = [];
    const { c, posts } = client({ postStatus: 403 }, (e) => warns.push(e.code));
    await expect(c.postReply({ teamsGroupId: TEAM, channelId: CHAN }, null, 'done')).resolves.toBeUndefined();
    expect(posts).toHaveLength(1);
    expect(warns).toContain('reply_post_failed');
  });
});
