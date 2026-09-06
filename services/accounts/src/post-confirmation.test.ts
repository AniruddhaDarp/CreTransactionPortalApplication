import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './post-confirmation.js';

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});

const ddb = mockClient(DynamoDBDocumentClient);
const eb = mockClient(EventBridgeClient);
process.env.ACCOUNTS_TABLE = 'accounts-test';
process.env.EVENT_BUS_NAME = 'cre-portal-bus';

beforeEach(() => {
  ddb.reset();
  eb.reset();
});

function event(over: { triggerSource?: string; attrs?: Record<string, string> } = {}) {
  return {
    triggerSource: over.triggerSource ?? 'PostConfirmation_ConfirmSignUp',
    request: { userAttributes: { sub: 'u-1', email: 'a@b.com', name: 'Ann', ...over.attrs } },
  } as never;
}
const run = (e: never) => (handler as unknown as (e: never) => Promise<unknown>)(e);

describe('accounts post-confirmation trigger', () => {
  it('provisions the profile and publishes account.created', async () => {
    ddb.on(PutCommand).resolves({});
    eb.on(PutEventsCommand).resolves({ FailedEntryCount: 0 });
    await run(event());
    expect(ddb.commandCalls(PutCommand)).toHaveLength(1);
    const entry = eb.commandCalls(PutEventsCommand)[0]!.args[0].input.Entries![0]!;
    expect(entry.DetailType).toBe('account.created');
    expect(entry.Source).toBe('cre.accounts');
  });

  it('is idempotent when the profile already exists (trigger retry)', async () => {
    ddb.on(PutCommand).rejects(
      Object.assign(new Error('exists'), { name: 'ConditionalCheckFailedException' }),
    );
    await expect(run(event())).resolves.toBeDefined();
    expect(eb.commandCalls(PutEventsCommand)).toHaveLength(0);
  });

  it('does nothing for a non-signup trigger source', async () => {
    await run(event({ triggerSource: 'PostConfirmation_ConfirmForgotPassword' }));
    expect(ddb.commandCalls(PutCommand)).toHaveLength(0);
  });
});
