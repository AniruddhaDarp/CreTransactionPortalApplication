import { canSee, type Scope, type Side } from '@cre/authz';
import { HttpError } from '@cre/platform';
import type { MemberView } from './repo.js';
import * as repo from './repo.js';

export async function requireViewer(dealId: string, userId: string): Promise<MemberView> {
  const mv = await repo.getMemberView(dealId, userId);
  if (!mv || mv.status !== 'active') {
    throw new HttpError(403, 'not an active member of this deal (membership may not be synced yet)');
  }
  return mv;
}

export function sideOfScope(scope: Scope): Side | null {
  if (scope === 'side_private:buy') return 'buy';
  if (scope === 'side_private:sell') return 'sell';
  return null;
}

const asScopeMember = (mv: MemberView) => ({ role: mv.role, side: mv.side, status: mv.status });

export function assertCanSee(mv: MemberView, scope: Scope): void {
  if (!canSee(asScopeMember(mv), scope)) {
    throw new HttpError(403, 'you cannot see this thread');
  }
}

/** Active members whose visibility includes `scope` — the frozen recipient set. */
export async function scopeParticipants(dealId: string, scope: Scope): Promise<MemberView[]> {
  const all = (await repo.listMemberViews(dealId)).filter((m) => m.status === 'active');
  return all.filter((m) => canSee(asScopeMember(m), scope));
}
