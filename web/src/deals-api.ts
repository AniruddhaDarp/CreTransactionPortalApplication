import { apiFetch } from './api.js';
import type { AppConfig } from './config.js';

export interface Deal {
  dealId: string;
  address: string;
  propertyType: string;
  label?: string;
  price: number;
  status: string;
  currentStage: number;
  firm: boolean;
  createdBy: string;
  targetClosingDate?: string;
  description?: string;
  myRole?: string;
}

export interface Member {
  userId: string;
  role: string;
  side: string;
  status: string;
  isAdmin: boolean;
}

export interface Invite {
  token: string;
  email: string;
  role: string;
  side: string;
  status: string;
}

export type Capabilities = Record<string, boolean>;

export interface Stage {
  n: number;
  key: string;
  name: string;
  status: 'not_started' | 'in_progress' | 'completed';
  targetDate?: string;
  notes?: string;
}

export interface ChecklistItem {
  itemId: string;
  n: number;
  title: string;
  done: boolean;
  doneBy?: string;
  fromTemplate: boolean;
}

export interface Handshake {
  hsId: string;
  dealId: string;
  action: string;
  status: 'pending' | 'approved' | 'rejected' | 'completed';
  initiatedBy: string;
  initiatedSide: string;
  decisionReason?: string;
}

export interface ChatThread {
  threadId: string;
  subject: string;
  scope: string;
  stageTag?: number;
  createdBy: string;
}

export interface ChatMessage {
  msgId: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
  system?: boolean;
}

export interface FeedItem {
  kind: string;
  summary: string;
  actorId?: string;
  createdAt: string;
}

export interface DocVersion {
  n: number;
  filename: string;
  contentType: string;
  uploadedBy: string;
  uploadedAt: string;
  note?: string;
}

export interface DocumentRow {
  docId: string;
  category: string;
  title: string;
  description?: string;
  scope: string;
  stageTag?: number;
  currentVersion: number;
  versionCount: number;
  uploadedBy: string;
  createdAt: string;
  archivedAt?: string;
}

export interface DocRequest {
  reqId: string;
  category: string;
  note?: string;
  targetUserId?: string;
  targetRole?: string;
  dueDate?: string;
  scope: string;
  status: 'open' | 'fulfilled' | 'declined' | 'cancelled';
  fulfilledDocId?: string;
  declineReason?: string;
  createdBy: string;
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  dealId?: string;
  actorId?: string;
  targetType?: string;
  targetId?: string;
  readAt?: string;
  occurredAt: string;
}

export interface AuditEvent {
  eventId: string;
  occurredAt: string;
  actorId?: string;
  detailType: string;
  action: string;
  targetType: string;
  targetId?: string;
  scope: string;
  summary: string;
  correlationId: string;
}

export function dealsApi(cfg: AppConfig, token: string) {
  const f = <T>(path: string, init?: RequestInit) => apiFetch<T>(cfg, token, path, init);
  return {
    list: () => f<{ deals: Deal[] }>('/v1/deals'),
    get: (id: string) =>
      f<Deal & { membership: Member; capabilities: Capabilities }>(`/v1/deals/${id}`),
    create: (body: Record<string, unknown>) =>
      f<Deal & { membership: Member }>('/v1/deals', { method: 'POST', body: JSON.stringify(body) }),
    members: (id: string) => f<{ members: Member[] }>(`/v1/deals/${id}/members`),
    invites: (id: string) => f<{ invites: Invite[] }>(`/v1/deals/${id}/invites`),
    invite: (id: string, body: Record<string, unknown>) =>
      f<{ token: string; acceptUrl: string; email: string; role: string }>(
        `/v1/deals/${id}/invites`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    revokeInvite: (id: string, tok: string) =>
      f<{ revoked: boolean }>(`/v1/deals/${id}/invites/${tok}`, { method: 'DELETE' }),
    removeMember: (id: string, uid: string) =>
      f<{ removed: boolean }>(`/v1/deals/${id}/members/${uid}`, { method: 'DELETE' }),
    previewInvite: (id: string, tok: string) =>
      f<{ dealAddress: string | null; role: string; side: string; status: string; expired: boolean }>(
        `/v1/deals/${id}/invites/${tok}`,
      ),
    accept: (id: string, tok: string) =>
      f<Member>(`/v1/deals/${id}/invites/${tok}/accept`, { method: 'POST' }),

    // --- milestones + handshakes (Module 5) ---
    stages: (id: string) =>
      f<{ stages: Stage[]; currentStage: number; firm: boolean }>(`/v1/deals/${id}/stages`),
    advance: (id: string) =>
      f<{ handshakeId: string; status: string }>(`/v1/deals/${id}/advance`, { method: 'POST' }),
    checklist: (id: string, n: number) =>
      f<{ items: ChecklistItem[] }>(`/v1/deals/${id}/stages/${n}/checklist`),
    toggleChecklistItem: (id: string, n: number, itemId: string, done: boolean) =>
      f<ChecklistItem>(`/v1/deals/${id}/stages/${n}/checklist/${itemId}`, {
        method: 'PATCH',
        body: JSON.stringify({ done }),
      }),
    handshakes: (id: string) => f<{ handshakes: Handshake[] }>(`/v1/deals/${id}/handshakes`),
    myApprovals: () => f<{ handshakes: Handshake[] }>('/v1/handshakes'),
    approveHandshake: (id: string, hsId: string) =>
      f<{ status: string }>(`/v1/deals/${id}/handshakes/${hsId}/approve`, { method: 'POST' }),
    rejectHandshake: (id: string, hsId: string, reason?: string) =>
      f<{ status: string }>(`/v1/deals/${id}/handshakes/${hsId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),

    // --- chat (Module 6) ---
    threads: (id: string) => f<{ threads: ChatThread[] }>(`/v1/deals/${id}/threads`),
    createThread: (id: string, body: Record<string, unknown>) =>
      f<ChatThread>(`/v1/deals/${id}/threads`, { method: 'POST', body: JSON.stringify(body) }),
    messages: (id: string, tid: string, after?: string) =>
      f<{ messages: ChatMessage[] }>(
        `/v1/deals/${id}/threads/${tid}/messages${after ? `?after=${encodeURIComponent(after)}` : ''}`,
      ),
    postMessage: (id: string, tid: string, body: string) =>
      f<{ msgId: string }>(`/v1/deals/${id}/threads/${tid}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    markThreadRead: (id: string, tid: string) =>
      f<{ readTs: string }>(`/v1/deals/${id}/threads/${tid}/read`, { method: 'POST' }),
    convertThread: (id: string, tid: string, toSide: 'buy' | 'sell') =>
      f<ChatThread>(`/v1/deals/${id}/threads/${tid}/convert`, {
        method: 'POST',
        body: JSON.stringify({ toSide }),
      }),
    activity: (id: string) => f<{ activity: FeedItem[] }>(`/v1/deals/${id}/activity`),

    // --- documents (Module 7) ---
    documents: (id: string) => f<{ documents: DocumentRow[] }>(`/v1/deals/${id}/documents`),
    document: (id: string, docId: string) =>
      f<DocumentRow & { versions: DocVersion[] }>(`/v1/deals/${id}/documents/${docId}`),
    createDocument: (id: string, body: Record<string, unknown>) =>
      f<{ docId: string; version: number; uploadUrl: string }>(`/v1/deals/${id}/documents`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    addDocumentVersion: (id: string, docId: string, body: Record<string, unknown>) =>
      f<{ version: number; uploadUrl: string }>(`/v1/deals/${id}/documents/${docId}/versions`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    documentDownloadUrl: (id: string, docId: string, n: number) =>
      f<{ url: string; filename: string }>(
        `/v1/deals/${id}/documents/${docId}/versions/${n}/download`,
      ),
    documentViewUrl: (id: string, docId: string, n: number) =>
      f<{ url: string; filename: string }>(`/v1/deals/${id}/documents/${docId}/versions/${n}/view`),
    promoteDocument: (id: string, docId: string) =>
      f<DocumentRow>(`/v1/deals/${id}/documents/${docId}/promote`, { method: 'POST' }),
    deleteDocument: (id: string, docId: string) =>
      f<{ status: string }>(`/v1/deals/${id}/documents/${docId}`, { method: 'DELETE' }),
    docRequests: (id: string) => f<{ requests: DocRequest[] }>(`/v1/deals/${id}/doc-requests`),
    createDocRequest: (id: string, body: Record<string, unknown>) =>
      f<{ reqId: string }>(`/v1/deals/${id}/doc-requests`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    fulfillDocRequest: (id: string, reqId: string, docId: string) =>
      f<{ status: string }>(`/v1/deals/${id}/doc-requests/${reqId}/fulfill`, {
        method: 'POST',
        body: JSON.stringify({ docId }),
      }),
    declineDocRequest: (id: string, reqId: string, reason?: string) =>
      f<{ status: string }>(`/v1/deals/${id}/doc-requests/${reqId}/decline`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    cancelDocRequest: (id: string, reqId: string) =>
      f<{ status: string }>(`/v1/deals/${id}/doc-requests/${reqId}/cancel`, { method: 'POST' }),

    // --- audit (Module 8) ---
    audit: (id: string, params: Record<string, string> = {}) => {
      const qs = new URLSearchParams(params).toString();
      return f<{ events: AuditEvent[]; nextCursor?: string; scopes: string[] }>(
        `/v1/deals/${id}/audit${qs ? `?${qs}` : ''}`,
      );
    },
    // --- notifications (Module 9) ---
    notifications: () =>
      f<{ notifications: NotificationItem[]; unreadCount: number }>('/v1/notifications'),
    markNotificationRead: (notifId: string) =>
      f<{ marked: number }>('/v1/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ id: notifId }),
      }),
    markAllNotificationsRead: () =>
      f<{ marked: number }>('/v1/notifications/read', {
        method: 'POST',
        body: JSON.stringify({ all: true }),
      }),

    auditExport: async (id: string, format: 'csv' | 'json', params: Record<string, string> = {}) => {
      const qs = new URLSearchParams({ ...params, format }).toString();
      const res = await fetch(`${cfg.apiBaseUrl}/v1/deals/${id}/audit/export?${qs}`, {
        headers: { authorization: `Bearer ${token}`, 'x-correlation-id': crypto.randomUUID() },
      });
      if (!res.ok) throw new Error(`${res.status}: ${await res.text()}`);
      const cd = res.headers.get('content-disposition') ?? '';
      const filename = /filename="([^"]+)"/.exec(cd)?.[1] ?? `audit-${id}.${format}`;
      return { blob: await res.blob(), filename };
    },
  };
}

export type DealsApi = ReturnType<typeof dealsApi>;
