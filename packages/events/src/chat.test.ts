import { describe, expect, it } from 'vitest';
import { chatEventSchemas, messagePostedSchema } from './chat.js';

describe('chat event schemas', () => {
  it('accepts a well-formed message.posted detail', () => {
    const ok = messagePostedSchema.parse({
      dealId: 'd1',
      threadId: 't1',
      msgId: 'm1',
      authorId: 'u1',
      scope: 'side_private:buy',
      mentions: ['u2'],
    });
    expect(ok.mentions).toEqual(['u2']);
  });

  it('rejects an unknown scope', () => {
    expect(() =>
      messagePostedSchema.parse({
        dealId: 'd1',
        threadId: 't1',
        msgId: 'm1',
        authorId: 'u1',
        scope: 'everyone',
        mentions: [],
      }),
    ).toThrow();
  });

  it('every registry entry parses its fixture', () => {
    const fixtures: Record<string, unknown> = {
      'thread.created': { dealId: 'd', threadId: 't', scope: 'deal_wide', subject: 'General' },
      'thread.converted': { dealId: 'd', threadId: 't', toScope: 'side_private:sell', droppedUserId: 'u9' },
      'message.posted': {
        dealId: 'd',
        threadId: 't',
        msgId: 'm',
        authorId: 'u',
        scope: 'deal_wide',
        mentions: [],
      },
      'message.edited': { dealId: 'd', threadId: 't', msgId: 'm', scope: 'deal_wide' },
      'message.deleted': { dealId: 'd', threadId: 't', msgId: 'm', scope: 'side_private:buy' },
    };
    for (const [type, schema] of Object.entries(chatEventSchemas)) {
      expect(() => schema.parse(fixtures[type]), type).not.toThrow();
    }
  });
});
