import type { MembershipStatus, Role, Side } from '@cre/authz';
import { getMemberView, HttpError, listMemberViews, type MemberViewRecord } from '@cre/platform';
import { tableName } from './repo.js';

export interface Viewer {
  userId: string;
  role: Role;
  side: Side;
  status: MembershipStatus;
}

export async function requireViewer(dealId: string, userId: string): Promise<Viewer> {
  const mv = await getMemberView(tableName(), dealId, userId);
  if (!mv || mv.status !== 'active') {
    throw new HttpError(403, 'not an active member of this deal (membership may not be synced yet)');
  }
  return { userId, role: mv.role as Role, side: mv.side as Side, status: mv.status };
}

export const scopeMember = (v: Viewer) => ({ role: v.role, side: v.side, status: v.status });

export async function activeMembers(dealId: string): Promise<MemberViewRecord[]> {
  return (await listMemberViews(tableName(), dealId)).filter((m) => m.status === 'active');
}
