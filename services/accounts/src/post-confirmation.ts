import { createLogger, publish } from '@cre/platform';
import type { PostConfirmationTriggerHandler } from 'aws-lambda';
import { createProfile } from './repo.js';

/**
 * Cognito post-confirmation trigger. On a completed sign-up it provisions the
 * user's profile row and publishes `account.created`. Must return the event.
 */
export const handler: PostConfirmationTriggerHandler = async (event) => {
  const log = createLogger({ trigger: event.triggerSource });

  if (event.triggerSource !== 'PostConfirmation_ConfirmSignUp') {
    return event; // e.g. forgot-password confirmation — nothing to provision
  }

  const attrs = event.request.userAttributes;
  const userId = attrs.sub;
  const email = attrs.email;
  if (!userId || !email) {
    log.error('post-confirmation event missing sub/email', { hasSub: Boolean(userId) });
    return event;
  }
  const name = attrs.name || attrs.given_name || email.split('@')[0] || email;
  const correlationId = `postconf-${userId}`;
  const busName = process.env.EVENT_BUS_NAME ?? '';

  try {
    await createProfile({ userId, email, name });
    await publish(busName, [
      {
        service: 'accounts',
        type: 'account.created',
        correlationId,
        actorId: userId,
        detail: { userId, email },
      },
    ]);
    log.info('profile provisioned', { userId });
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      log.info('profile already exists — trigger retry, ignoring', { userId });
    } else {
      log.error('post-confirmation failed', { userId, message: (err as Error).message });
      throw err; // let Cognito retry
    }
  }

  return event;
};
