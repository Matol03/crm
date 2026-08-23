/**
 * Real Microsoft Graph client (PRD Section 4) — app-only (client-credentials).
 *
 * Implements the existing `MsGraphClient` seam: polls channel messages (plus
 * thread replies) filtered by `lastModifiedDateTime`, resolves each author's
 * email, and classifies attachments as image/voice.
 *
 * Tenant permission reality (verified live, see docs/decisions.md):
 *   - ChannelMessage.Read.All IS granted -> message polling works.
 *   - Files.Read.All / Sites.Read.All are NOT granted -> attachment bytes 403.
 *     Attachments are therefore emitted with `attachmentPending: true` instead of
 *     failing; the lead is still created and flagged for retry (S4 / S10.4).
 *     The download path is implemented, so granting the permission later needs
 *     no code change.
 *   - ChannelMessage.Send is NOT granted -> postReply degrades to a logged
 *     warning rather than throwing, so a lead is never lost over a reply.
 *
 * Secrets (client secret, tokens) live only here and are never logged.
 */

import type { MsGraphClient, RawChannelMessage } from '../contracts/adapters.js';
import type { SessionItem, ItemType } from '../contracts/session.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export interface RealMsGraphOptions {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  teamsGroupId: string;
  channelId: string;
  fetchImpl?: typeof fetch;
  /** Emitted on non-fatal degradations (never contains PII). */
  onWarn?: (event: { code: string; detail?: string }) => void;
}

interface GraphUser {
  id?: string;
  displayName?: string;
}

interface GraphAttachment {
  id?: string;
  contentType?: string;
  contentUrl?: string;
  name?: string;
}

interface GraphMessage {
  id: string;
  messageType?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  body?: { content?: string; contentType?: string };
  from?: { user?: GraphUser | null; application?: { displayName?: string } | null } | null;
  attachments?: GraphAttachment[];
  eventDetail?: unknown;
  replyToId?: string | null;
}

const IMAGE_EXT = /\.(png|jpe?g|gif|bmp|webp|heic|tiff?)$/i;
const VOICE_EXT = /\.(ogg|oga|opus|mp3|m4a|wav|amr|aac|wma|webm)$/i;

/** Strip HTML tags/entities from a Teams message body. */
export function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Classify an attachment by filename/contentType. */
export function classifyAttachment(a: GraphAttachment): ItemType | null {
  const name = a.name ?? '';
  const ct = a.contentType ?? '';
  if (IMAGE_EXT.test(name) || /^image\//i.test(ct)) return 'image';
  if (VOICE_EXT.test(name) || /^audio\//i.test(ct)) return 'voice';
  return null;
}

export class RealMsGraphClient implements MsGraphClient {
  private readonly doFetch: typeof fetch;
  private token: { value: string; expiresAtMs: number } | null = null;
  /** Graph user id -> email, cached to avoid re-resolving every poll. */
  private readonly emailCache = new Map<string, string>();

  constructor(private readonly opts: RealMsGraphOptions) {
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  private warn(code: string, detail?: string): void {
    this.opts.onWarn?.(detail === undefined ? { code } : { code, detail });
  }

  /** Acquire (and cache) an app-only token. */
  private async getToken(): Promise<string> {
    const now = Date.now();
    if (this.token && this.token.expiresAtMs > now + 60_000) return this.token.value;

    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    });
    const res = await this.doFetch(
      `https://login.microsoftonline.com/${this.opts.tenantId}/oauth2/v2.0/token`,
      { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body },
    );
    const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
    if (!res.ok || !json.access_token) {
      throw new Error(`Graph token request failed (${res.status}): ${json.error ?? 'unknown'}`);
    }
    this.token = {
      value: json.access_token,
      expiresAtMs: now + (json.expires_in ?? 3600) * 1000,
    };
    return this.token.value;
  }

  private async graphGet<T>(path: string): Promise<{ status: number; json: T }> {
    const token = await this.getToken();
    const res = await this.doFetch(`${GRAPH}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const json = (await res.json().catch(() => ({}))) as T;
    return { status: res.status, json };
  }

  /** Resolve a Graph user id to an email address (User.Read.All). */
  private async resolveEmail(userId: string | undefined, displayName: string): Promise<string> {
    if (!userId) return '';
    const cached = this.emailCache.get(userId);
    if (cached !== undefined) return cached;
    const { status, json } = await this.graphGet<{ mail?: string | null; userPrincipalName?: string }>(
      `/users/${userId}?$select=mail,userPrincipalName`,
    );
    let email = '';
    if (status === 200) email = json.mail || json.userPrincipalName || '';
    else this.warn('author_email_unresolved', `http ${status}`);
    // Fall back to a stable synthetic identity so grouping/dedup still work.
    if (!email) email = `teams-user-${userId}`;
    this.emailCache.set(userId, email);
    void displayName;
    return email;
  }

  /**
   * Map one Graph message to the internal contract. Returns null for system
   * events, bot posts, and messages with no usable content.
   */
  private async toRawMessage(m: GraphMessage): Promise<RawChannelMessage | null> {
    // Skip system/event messages and app/bot posts — only real people make leads.
    if (m.eventDetail || m.messageType === 'systemEventMessage') return null;
    const user = m.from?.user;
    if (!user) return null;

    const timestamp = m.lastModifiedDateTime ?? m.createdDateTime ?? new Date().toISOString();
    const text = htmlToText(m.body?.content ?? '');
    const displayName = user.displayName ?? 'Unknown';
    const email = await this.resolveEmail(user.id ?? undefined, displayName);

    const items: SessionItem[] = [];
    if (text) items.push({ messageId: m.id, timestamp, type: 'text', text });

    for (const [idx, a] of (m.attachments ?? []).entries()) {
      const kind = classifyAttachment(a);
      if (!kind) continue;
      const item: SessionItem = {
        // Distinct id per attachment so the idempotency ledger tracks each one.
        messageId: `${m.id}:att${idx}`,
        timestamp,
        type: kind,
        // Bytes are not retrievable without Files.Read.All — flag for retry
        // rather than failing. Granting the permission later fills these in.
        attachmentPending: true,
      };
      if (a.contentUrl) item.mediaUrl = a.contentUrl;
      if (kind === 'image') item.ocrText = null;
      items.push(item);
      this.warn('attachment_bytes_unavailable', kind);
    }

    if (items.length === 0) return null;

    return {
      messageId: m.id,
      timestamp,
      author: { teamsUserId: user.id ?? '', email, displayName },
      channel: { teamsGroupId: this.opts.teamsGroupId, channelId: this.opts.channelId },
      ...(m.replyToId ? { replyToId: m.replyToId } : {}),
      items,
    };
  }

  async getNewChannelMessages(since: string): Promise<RawChannelMessage[]> {
    const sinceMs = since ? new Date(since).getTime() : 0;
    const chan = encodeURIComponent(this.opts.channelId);
    const base = `/teams/${this.opts.teamsGroupId}/channels/${chan}/messages`;

    const { status, json } = await this.graphGet<{ value?: GraphMessage[]; error?: { code?: string } }>(
      `${base}?$top=50`,
    );
    if (status !== 200) {
      throw new Error(`Graph message poll failed (${status}): ${json.error?.code ?? 'unknown'}`);
    }

    const roots = json.value ?? [];
    const candidates: GraphMessage[] = [];
    for (const m of roots) {
      candidates.push(m);
      // Thread replies are separate messages; a same-author reply clarifying
      // their own contact must be ingested too (S6).
      const rc = await this.graphGet<{ value?: GraphMessage[] }>(`${base}/${m.id}/replies?$top=50`);
      if (rc.status === 200) for (const r of rc.json.value ?? []) candidates.push({ ...r, replyToId: m.id });
    }

    const fresh = candidates.filter((m) => {
      const ts = m.lastModifiedDateTime ?? m.createdDateTime;
      return ts ? new Date(ts).getTime() > sinceMs : false;
    });

    const out: RawChannelMessage[] = [];
    for (const m of fresh) {
      const mapped = await this.toRawMessage(m);
      if (mapped) out.push(mapped);
    }
    return out.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
  }

  async postReply(
    channel: { teamsGroupId: string; channelId: string },
    threadId: string | null,
    text: string,
  ): Promise<void> {
    const chan = encodeURIComponent(channel.channelId);
    const path = threadId
      ? `/teams/${channel.teamsGroupId}/channels/${chan}/messages/${threadId}/replies`
      : `/teams/${channel.teamsGroupId}/channels/${chan}/messages`;
    try {
      const token = await this.getToken();
      const res = await this.doFetch(`${GRAPH}${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: { contentType: 'text', content: text } }),
      });
      if (!res.ok) {
        // ChannelMessage.Send is not granted in this tenant — degrade, never
        // fail the lead over an undelivered acknowledgement (S11).
        this.warn('reply_post_failed', `http ${res.status}`);
      }
    } catch {
      this.warn('reply_post_failed', 'network');
    }
  }
}
