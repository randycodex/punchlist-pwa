import assert from 'node:assert/strict';

export function validateHostedAcceptanceTarget(env) {
  const ref = env.PUNCHLIST_TEST_PROJECT_REF;
  assert(ref && /^[a-z]{20}$/.test(ref), 'Set an explicit disposable Supabase project ref.');
  assert.notEqual(ref, 'wwutemmdbimzucrijckg', 'Production is never a hosted acceptance target.');
  assert.equal(env.PUNCHLIST_DISPOSABLE_TEST_PROJECT, 'yes', 'Confirm disposable test data.');
  assert.equal(env.PUNCHLIST_HOSTED_WRITE_APPROVED, ref,
    'Obtain approval for this disposable project, then set PUNCHLIST_HOSTED_WRITE_APPROVED to its exact ref. This harness creates users/data.');
  assert(env.PUNCHLIST_TEST_KEYS_FILE, 'Provide an existing private JSON keys file; the harness does not create credentials.');
  return { ref, base: `https://${ref}.supabase.co`, keysFile: env.PUNCHLIST_TEST_KEYS_FILE };
}

/** No mutation retries: a timed-out write may have committed. Keep its identity. */
export async function boundedAcceptanceFetch(url, init, { fetcher = fetch, timeoutMs = 30_000 } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let timeout;
  const deadline = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error('Hosted acceptance request timed out; its write outcome is unknown.'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetcher(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { status: response.status, text };
    })(), deadline]);
  } catch (error) {
    if (timedOut) throw new Error('Hosted acceptance request timed out; its write outcome is unknown.');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
