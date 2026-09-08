import { describe, expect, it } from 'vitest';
import {
  applyMention,
  collectMentions,
  filterMentionables,
  mentionLabel,
  mentionQueryAt,
  mentionToken,
  splitMentions,
} from './mentions.js';

const bianca = { userId: 'aaaaaa11-1111', role: 'BUYER', name: 'Bianca Cho' };
const agent = { userId: 'bbbbbb22-2222', role: 'BUYER_AGENT' };
const selena = { userId: 'cccccc33-3333', role: 'SELLER_AGENT', name: 'Selena Ortiz' };
const members = [bianca, agent, selena];

describe('mentionLabel / mentionToken', () => {
  it('is "Name (ROLE)" when named, else just the role — never a raw id', () => {
    expect(mentionLabel(bianca)).toBe('Bianca Cho (Buyer)');
    expect(mentionLabel(agent)).toBe("Buyer's Agent");
    expect(mentionToken(bianca)).toBe('@Bianca Cho (Buyer)');
    expect(mentionToken(agent)).toBe("@Buyer's Agent");
  });
});

describe('mentionQueryAt', () => {
  it('opens on a bare @ at the caret', () => {
    expect(mentionQueryAt('hey @', 5)).toEqual({ query: '', start: 4 });
  });
  it('captures the partial query and the @ position', () => {
    expect(mentionQueryAt('ping @bia', 9)).toEqual({ query: 'bia', start: 5 });
  });
  it('needs whitespace (or start) before the @', () => {
    expect(mentionQueryAt('email me@x', 10)).toBeNull();
  });
  it('closes once the caret moves past a space', () => {
    expect(mentionQueryAt('ping @bia now', 13)).toBeNull();
  });
});

describe('filterMentionables', () => {
  it('matches on name, case-insensitive', () => {
    expect(filterMentionables(members, 'ortiz').map((m) => m.userId)).toEqual(['cccccc33-3333']);
  });
  it('matches on role substring', () => {
    expect(filterMentionables(members, 'agent').map((m) => m.role)).toEqual([
      'BUYER_AGENT',
      'SELLER_AGENT',
    ]);
  });
  it('empty query returns everyone', () => {
    expect(filterMentionables(members, '')).toHaveLength(3);
  });
});

describe('applyMention', () => {
  it('inserts the token and a trailing space at end of input', () => {
    const r = applyMention('hi @bia', 3, 7, '@Bianca Cho (BUYER)');
    expect(r.text).toBe('hi @Bianca Cho (BUYER) ');
    expect(r.text.slice(0, r.caret)).toBe('hi @Bianca Cho (BUYER) ');
  });
  it('does not double the space when text already follows', () => {
    const r = applyMention('hi @bia there', 3, 7, '@Bianca Cho (BUYER)');
    expect(r.text).toBe('hi @Bianca Cho (BUYER) there');
  });
});

describe('collectMentions', () => {
  it('keeps only picked ids whose token still appears verbatim', () => {
    const picked = { 'aaaaaa11-1111': '@Bianca Cho (BUYER)', 'cccccc33-3333': '@Selena Ortiz (SELLER_AGENT)' };
    expect(collectMentions('thanks @Bianca Cho (BUYER)', picked)).toEqual(['aaaaaa11-1111']);
  });
});

describe('splitMentions', () => {
  it('marks a known "@Name (ROLE)" label as a single mention', () => {
    const segs = splitMentions('hey @Bianca Cho (BUYER) please review', ['Bianca Cho (BUYER)']);
    expect(segs).toEqual([
      { text: 'hey ', mention: false },
      { text: '@Bianca Cho (BUYER)', mention: true },
      { text: ' please review', mention: false },
    ]);
  });
  it('falls back to @word / @ROLE·id when no labels match', () => {
    const segs = splitMentions('ping @BUYER_AGENT·bbbb now', []);
    expect(segs.find((s) => s.mention)?.text).toBe('@BUYER_AGENT·bbbb');
  });
});
