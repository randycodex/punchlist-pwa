import { describe, expect, it, vi } from 'vitest';
import { boundedAcceptanceFetch, validateHostedAcceptanceTarget } from '../scripts/lib/hostedAcceptance.mjs';

const ref = 'abcdefghijklmnopqrst';
const approved = { PUNCHLIST_TEST_PROJECT_REF: ref, PUNCHLIST_DISPOSABLE_TEST_PROJECT: 'yes',
  PUNCHLIST_HOSTED_WRITE_APPROVED: ref, PUNCHLIST_TEST_KEYS_FILE: '/tmp/existing-private-keys.json' };
describe('hosted acceptance safety gates (no hosted requests)', () => {
  it('requires explicit approval for the exact disposable project', () => {
    expect(() => validateHostedAcceptanceTarget({ ...approved, PUNCHLIST_HOSTED_WRITE_APPROVED: '' })).toThrow('Obtain approval');
    expect(() => validateHostedAcceptanceTarget({ ...approved, PUNCHLIST_HOSTED_WRITE_APPROVED: 'anotherprojectrefxxxx' })).toThrow('Obtain approval');
    expect(() => validateHostedAcceptanceTarget({ ...approved, PUNCHLIST_DISPOSABLE_TEST_PROJECT: 'no' })).toThrow('Confirm disposable');
    expect(validateHostedAcceptanceTarget(approved).base).toBe(`https://${ref}.supabase.co`);
  });
  it('rejects production even with all confirmations', () => {
    expect(() => validateHostedAcceptanceTarget({ ...approved, PUNCHLIST_TEST_PROJECT_REF: 'wwutemmdbimzucrijckg',
      PUNCHLIST_HOSTED_WRITE_APPROVED: 'wwutemmdbimzucrijckg' })).toThrow('Production is never');
  });
  it('bounds a stalled body and never retries an ambiguous write', async () => {
    const fetcher = vi.fn(async () => new Response(new ReadableStream({ start() { /* Never resolves. */ } })));
    await expect(boundedAcceptanceFetch('https://example.invalid', { method: 'POST' }, { fetcher, timeoutMs: 10 }))
      .rejects.toThrow('write outcome is unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]).toBeDefined();
  });
  it('returns a successful response including the body', async () => {
    const fetcher = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    expect(await boundedAcceptanceFetch('https://example.invalid', {}, { fetcher, timeoutMs: 100 }))
      .toEqual({ status: 200, text: '{"ok":true}' });
  });
});
