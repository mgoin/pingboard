import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github.mjs';

const pin = { repo: 'acme/widget', number: 7 };
const head = 'a'.repeat(40);
const nextHead = 'b'.repeat(40);
const profile = {
  ciPrefix: 'buildkite/', mainPipeline: 'main',
  ciCommands: { run: '/ci run', retry: '/ci retry', stale: '/ci run --allow-stale' },
};
const check = (name, state = 'SUCCESS') => ({ __typename: 'StatusContext', context: name, state });
const page = (nodes, cursor = null) => ({ nodes, pageInfo: { hasNextPage: Boolean(cursor), endCursor: cursor } });
const reply = (json, status = 200) => Response.json(json, { status });
const repository = data => reply({ data: { repository: data } });
const checksReply = nodes => repository({ object: { statusCheckRollup: { contexts: page(nodes) } } });

function pullRequest({ headOid = head, checks = page([check('buildkite/main/pr/unit')]), ...fields } = {}) {
  return {
    number: 7, title: 'A pull request', state: 'OPEN', baseRefName: 'release', headRefOid: headOid,
    viewerCanUpdateBranch: true, mergeable: 'MERGEABLE', url: 'https://github.com/acme/widget/pull/7',
    commits: { nodes: [{ commit: { oid: headOid, statusCheckRollup: { contexts: checks } } }] },
    ...fields,
  };
}

function fixture({ snapshots = [{}], route = () => undefined } = {}) {
  const calls = [];
  let reads = 0;
  let current;
  const client = new GitHubClient({
    token: 'secret-token', pollAttempts: 3, sleep: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      const operation = body.query?.match(/query Pingboard(\w+)/)?.[1];
      calls.push({ url, method: init.method, operation, body });
      const custom = route(operation, body.variables);
      if (custom) return custom;
      if (!operation) return reply({ html_url: pullRequest().url + '#issuecomment-1' });
      if (operation === 'PullRequest') {
        current = snapshots[Math.min(reads++, snapshots.length - 1)];
        return repository({ pullRequest: pullRequest(current) });
      }
      if (operation === 'Compare') return repository({ ref: { compare: { behindBy: current.behind ?? 0 } } });
      throw new Error('Unexpected query: ' + operation);
    },
  });
  return { client, calls, writes: () => calls.filter(call => !call.operation) };
}

test('checks are fully paged; a later failure or API error cannot look green', async () => {
  const options = { snapshots: [{ checks: page([check('buildkite/main/pr/unit')], 'next') }] };
  const { client, calls } = fixture({ ...options, route: op => op === 'Contexts' && checksReply([check('buildkite/main/pr/integration', 'FAILURE')]) });
  const pr = await client.getPR(pin, profile);
  assert.equal(pr.ci.state, 'failed');
  assert.equal(pr.checks.length, 2);
  assert.deepEqual(calls[1].body.variables, { owner: 'acme', name: 'widget', oid: head, cursor: 'next' });
  assert.equal(calls[2].body.variables.baseRef, 'refs/heads/release');
  const failed = fixture({ ...options, route: op => op === 'Contexts' && reply({ errors: [{ message: 'Rate limited' }] }) });
  await assert.rejects(failed.client.getPR(pin, profile), /Rate limited/);
});

test('comparison failures leave PRs readable but forbid running CI with unknown freshness', async () => {
  const route = op => op === 'Compare' && reply({ errors: [{ message: 'Ref unavailable' }] });
  const { client, writes } = fixture({ route });
  const pr = await client.getPR(pin, profile);
  assert.equal(pr.behind, null);
  assert.match(pr.branchComparisonError, /Ref unavailable/);
  await assert.rejects(client.command(pin, 'run', profile), /freshness is unknown/);
  assert.equal(writes().length, 0);
  const merged = fixture({ route, snapshots: [{ state: 'MERGED' }] });
  assert.equal((await merged.client.getPR(pin, profile)).state, 'MERGED');
});

test('review search preserves GitHub qualifiers and pagination', async () => {
  const { client, calls } = fixture({ route: () => reply({ data: { search: {
    issueCount: 40, ...page([{ ...pullRequest(), repository: { nameWithOwner: pin.repo } }], 'next'),
  } } }) });
  const result = await client.searchPRs({ repo: pin.repo, limit: 12, cursor: 'previous' });
  assert.equal(result.items[0].repo, pin.repo);
  assert.equal(result.nextCursor, 'next');
  assert.equal(result.total, 40);
  assert.match(result.query, /review-requested:@me/);
  assert.equal(calls[0].body.variables.cursor, 'previous');
  assert.match((await client.searchPRs({ view: 'ready' })).query, /label:ready/);
});

test('commands require a configured workflow, current head and open PR', async () => {
  const missing = fixture();
  await assert.rejects(missing.client.updateBranch(pin, {}, { runCi: true }), /No run CI command/);
  assert.equal(missing.calls.length, 0);
  for (const [snapshot, options, error] of [
    [{}, { expectedHeadOid: 'old' }, /head changed/],
    [{ state: 'CLOSED' }, {}, /is closed/],
    [{ behind: 2 }, {}, /behind its base/],
  ]) {
    const { client, writes } = fixture({ snapshots: [snapshot] });
    await assert.rejects(client.command(pin, 'run', profile, options), error);
    assert.equal(writes().length, 0);
  }
  const { client, writes } = fixture({ snapshots: [{ behind: 2 }] });
  await client.command(pin, 'stale', profile);
  assert.deepEqual(writes()[0].body, { body: '/ci run --allow-stale' });
});

test('update then run waits for both a changed head and a current base', async () => {
  const { client, calls, writes } = fixture({ snapshots: [
    { behind: 2 }, { behind: 0 }, { headOid: nextHead, behind: 1 }, { headOid: nextHead, behind: 0 },
  ] });
  const result = await client.updateBranch(pin, profile, { runCi: true, expectedHeadOid: head });
  assert.equal(result.status, 'updated');
  assert.equal(result.ci.headOid, nextHead);
  assert.deepEqual(writes().map(call => call.method), ['PUT', 'POST']);
  assert.deepEqual(writes()[0].body, { expected_head_sha: head });
  assert.deepEqual(writes()[1].body, { body: '/ci run' });
  assert.equal(calls.filter(call => call.operation === 'PullRequest').length, 4);
  assert.equal(calls.at(-1), writes()[1]);
});

test('update timeouts post no CI; an already current branch needs only the CI comment', async () => {
  const waiting = fixture({ snapshots: [{ behind: 2 }] });
  await assert.rejects(waiting.client.updateBranch(pin, profile, { runCi: true }), /accepted the branch update.*CI was not posted/);
  assert.deepEqual(waiting.writes().map(call => call.method), ['PUT']);
  const current = fixture({ snapshots: [{ viewerCanUpdateBranch: false }] });
  assert.equal((await current.client.updateBranch(pin, profile, { runCi: true })).status, 'already_current');
  assert.deepEqual(current.writes().map(call => call.method), ['POST']);
});

test('baseline comparison counts completed builds and caches results per profile', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const jobs = {
    pass: [check('buildkite/main/unit')],
    fail: [check('buildkite/main/unit', 'FAILURE'), check('buildkite/main/pr/unit', 'FAILURE')],
    running: [check('buildkite/main/unit', 'PENDING')],
  };
  const { client, calls } = fixture({ route: (op, variables) => {
    if (op === 'BaseHistory') return repository({ ref: { target: { history: {
      nodes: Object.keys(jobs).map(oid => ({ oid, statusCheckRollup: { state: 'SUCCESS' } })),
    } } } });
    if (op === 'Contexts') return checksReply(jobs[variables.oid]);
  } });
  const result = await client.getBaseline(pin.repo, 'release', profile);
  assert.equal(result.total, 2);
  assert.deepEqual([...result.counts], [['main/unit', 1]]);
  await client.getBaseline(pin.repo, 'release', profile);
  assert.equal(calls.length, 4);
  now += 600_000;
  await client.getBaseline(pin.repo, 'release', profile);
  assert.equal(calls.length, 8);
  assert.equal((await client.getBaseline(pin.repo, 'release', { ...profile, mainPipeline: 'other' })).total, 0);
  assert.equal(calls.length, 12);
});

test('HTTP and partial GraphQL errors redact credentials; failed writes report an unknown outcome', async () => {
  for (const response of [
    reply({ message: 'Forbidden secret-token' }, 403),
    reply({ data: { repository: { pullRequest: pullRequest() } }, errors: [{ message: 'Denied secret-token' }] }),
  ]) {
    const { client } = fixture({ route: () => response });
    await assert.rejects(client.getPR(pin, profile), error => /\[redacted\]/.test(error.message) && !error.message.includes('secret-token'));
  }
  const { client } = fixture({ route: op => { if (!op) throw new Error('secret-token'); } });
  await assert.rejects(client.command(pin, 'retry', profile), error => /write outcome may be unknown/.test(error.message) && !error.message.includes('secret-token'));
  assert.doesNotMatch(JSON.stringify(client), /secret-token/);
});
