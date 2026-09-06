import { HttpError, parseBody, router } from '@cre/platform';
import { z } from 'zod';
import { getProfile, updateProfile } from './repo.js';

const patchSchema = z
  .object({
    name: z.string().min(1).max(120),
    company: z.string().max(160),
    industryRole: z.string().max(80),
    phone: z.string().max(40),
  })
  .partial();

/** `GET /v1/me` and `PUT /v1/me` — the caller's own profile. */
export const handler = router({
  'GET /v1/me': async (ctx) => {
    const profile = await getProfile(ctx.userId);
    if (!profile) {
      // The post-confirmation trigger writes the profile; immediately after a
      // first sign-in there can be a brief window where it isn't there yet.
      throw new HttpError(404, 'profile not provisioned yet');
    }
    return { body: profile };
  },

  'PUT /v1/me': async (ctx) => {
    const patch = parseBody(patchSchema, ctx.body ?? {});
    const updated = await updateProfile(ctx.userId, patch);
    return { body: updated };
  },
});
