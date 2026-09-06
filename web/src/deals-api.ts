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
  };
}

export type DealsApi = ReturnType<typeof dealsApi>;
