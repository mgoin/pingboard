import test from 'node:test';
import assert from 'node:assert/strict';
import { GitHubClient } from '../src/github.mjs';

const pin = { repo: 'acme/widget', number: 7 };
const profile = { ciPrefix: 'buildkite/', mainPipeline: 'main', ciCommands: { run: '/ci run', retry: '/ci retry', cancel: '/ci cancel', stale: '/ci run --allow-stale' } };
const status = (name, state = 'SUCCESS') => ({ __typename: 'StatusContext', context: name, state, description: '', targetUrl: 'https://buildkite.com/acme/build/1', createdAt: '2026-01-02T00:00:00Z' });
const connection = (nodes, hasNextPage = false, endCursor = null) => ({ totalCount: nodes.length, nodes, pageInfo: { hasNextPage, endCursor } });

function pullRequest({ head = 'a'.repeat(40), base = 'release', checks = connection([status('buildkite/main/pr/test')]), ...overrides } = {}) {
  return {
    id: 'PR_7', number: 7, title: 'A pull request', url: 'https://github.com/acme/widget/pull/7',
    state: 'OPEN', isDraft: false, updatedAt: '2026-01-02T00:00:00Z', author: { login: 'alice' },
    authorAssociation: 'MEMBER', baseRefName: base, headRefOid: head,
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: 'APPROVED', viewerCanUpdateBranch: true,
    autoMergeRequest: null, additions: 3, deletions: 2, changedFiles: 1,
    labels: { nodes: [{ name: 'ready', color: '00ff00' }] },
    latestOpinionatedReviews: { nodes: [{ author: { login: 'bob' }, state: 'APPROVED' }] },
    reviewRequests: { pageInfo: { hasNextPage: false }, nodes: [
      { requestedReviewer: { __typename: 'User', login: 'carol' } },
      { requestedReviewer: { __typename: 'Team', slug: 'reviewers', name: 'Reviewers', organization: { login: 'acme' } } },
    ] },
    comments: { nodes: [{ author: { login: 'bob' }, bodyText: 'Looks good', createdAt: '2026-01-02T00:00:00Z', url: 'https://github.com/acme/widget/pull/7#issuecomment-1' }] },
    commits: { nodes: [{ commit: { oid: head, committedDate: '2026-01-02T00:00:00Z', statusCheckRollup: checks === null ? null : { state: 'SUCCESS', contexts: checks } } }] },
    ...overrides,
  };
}

const response = (json, statusCode = 200) => ({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, statusText: 'Error', json: async () => json });

function fixture(options = {}) {
  const calls = [];
  const sleeps = [];
  let prIndex = 0;
  let lastPrIndex = 0;
  const prs = options.prs || [pullRequest()];
  const client = new GitHubClient({
    token: options.token ?? 'test-secret-token', pollAttempts: options.pollAttempts ?? 2, pollIntervalMs: 1,
    sleep: async ms => { sleeps.push(ms); },
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, ...init, body });
      if (!url.endsWith('/graphql')) {
        if (options.rest) return options.rest(url, init, body);
        if (init.method === 'PUT') return response({ message: 'Updating pull request branch.' }, 202);
        return response({ html_url: 'https://github.com/acme/widget/pull/7#issuecomment-2' }, 201);
      }
      if (options.graphql) {
        const handled = options.graphql(body);
        if (handled) return handled;
      }
      if (body.query.includes('query PingboardPullRequest')) {
        lastPrIndex = Math.min(prIndex++, prs.length - 1);
        return response({ data: { repository: { pullRequest: prs[lastPrIndex] } } });
      }
      if (body.query.includes('query PingboardCompare')) {
        const behind = Array.isArray(options.behind) ? options.behind[lastPrIndex] : (options.behind ?? 0);
        return response({ data: { repository: { ref: { compare: { behindBy: behind, aheadBy: 1 } } } } });
      }
      throw new Error(`Unexpected query ${body.query.slice(0, 60)}`);
    },
  });
  return { client, calls, sleeps, writes: () => calls.filter(call => !call.url.endsWith('/graphql')) };
}

test('getPR loads its actual base, normalizes checks and reports requested people and teams', async () => {
  const { client, calls } = fixture();
  const pr = await client.getPR(pin, profile);
  assert.equal(pr.key, 'acme/widget#7');
  assert.equal(pr.base, 'release');
  assert.equal(pr.ci.state, 'passed');
  assert.equal(pr.checks[0].jobKey, 'main/test');
  assert.equal(pr.reviews[0].login, 'bob');
  assert.deepEqual(pr.requestedReviewers, [
    { type: 'user', login: 'carol' }, { type: 'team', slug: 'reviewers', name: 'Reviewers', organization: 'acme' },
  ]);
  assert.equal(calls[1].body.variables.baseRef, 'refs/heads/release');
  assert.equal(calls[0].redirect, 'error');
  assert.equal(calls[0].url, 'https://api.github.com/graphql');
});

test('getPR pages every check before reporting CI; a later failing page cannot appear green', async () => {
  const { client, calls } = fixture({
    prs: [pullRequest({ checks: connection([status('buildkite/main/pr/unit')], true, 'page-2') })],
    graphql: body => body.query.includes('query PingboardContexts') && response({ data: { repository: { object: { statusCheckRollup: { contexts: connection([status('buildkite/main/pr/integration', 'FAILURE')]) } } } } }),
  });
  const pr = await client.getPR(pin, profile);
  assert.equal(pr.ci.state, 'failed');
  assert.equal(pr.ci.fail, 1);
  assert.equal(pr.checks.length, 2);
  assert.equal(calls[1].body.variables.cursor, 'page-2');
  assert.equal(calls[1].body.variables.oid, pr.headOid);
});

test('partial GraphQL errors fail the read and redact the token', async () => {
  const { client } = fixture({ graphql: () => response({ data: { repository: { pullRequest: pullRequest() } }, errors: [{ message: 'Denied test-secret-token' }] }) });
  await assert.rejects(client.getPR(pin, profile), error => error.message.includes('[redacted]') && !error.message.includes('test-secret-token'));
});

test('a pagination error fails the entire read', async () => {
  const { client } = fixture({
    prs: [pullRequest({ checks: connection([status('buildkite/main/pr/test')], true, 'next') })],
    graphql: body => body.query.includes('query PingboardContexts') && response({ errors: [{ message: 'Rate limit reached' }] }),
  });
  await assert.rejects(client.getPR(pin, profile), /Rate limit reached/);
});

test('non-advancing pagination fails without silently truncating checks', async () => {
  const { client, calls } = fixture({
    prs: [pullRequest({ checks: connection([], true, 'same') })],
    graphql: body => body.query.includes('query PingboardContexts') && response({ data: { repository: { object: { statusCheckRollup: { contexts: connection([], true, 'same') } } } } }),
  });
  await assert.rejects(client.getPR(pin, profile), /pagination did not advance/);
  assert.equal(calls.length, 2);
});

test('null check nodes fail instead of dropping potentially failing checks', async () => {
  const { client } = fixture({ prs: [pullRequest({ checks: connection([null]) })] });
  await assert.rejects(client.getPR(pin, profile), /unreadable check/);
});

test('a missing rollup is no CI, and inconsistent commit data fails', async () => {
  const first = fixture({ prs: [pullRequest({ checks: null })] });
  assert.equal((await first.client.getPR(pin, profile)).ci.state, 'none');
  const second = fixture({ prs: [pullRequest({ headRefOid: 'different' })] });
  await assert.rejects(second.client.getPR(pin, profile), /consistent PR head/);
});

test('HTTP failures are surfaced and credentials are redacted', async () => {
  const { client } = fixture({ graphql: () => response({ message: 'Forbidden test-secret-token' }, 403) });
  await assert.rejects(client.getPR(pin, profile), /GitHub HTTP 403: Forbidden \[redacted\]/);
});

test('review search uses GitHub review-requested semantics and returns a continuation cursor', async () => {
  const { client, calls } = fixture({ graphql: body => {
    if (!body.query.includes('query PingboardSearch')) return null;
    return response({ data: { search: { issueCount: 40, pageInfo: { hasNextPage: true, endCursor: 'next-page' }, nodes: [{ ...pullRequest(), repository: { nameWithOwner: 'acme/widget' } }] } } });
  } });
  const results = await client.searchPRs({ repo: 'acme/widget', limit: 12, cursor: 'old-page' });
  assert.equal(results.total, 40);
  assert.equal(results.nextCursor, 'next-page');
  assert.equal(results.items[0].repo, 'acme/widget');
  assert.equal(results.items[0].ciState, 'SUCCESS');
  assert.match(calls[0].body.variables.query, /review-requested:@me/);
  assert.doesNotMatch(calls[0].body.variables.query, /user-review-requested/);
  assert.equal(calls[0].body.variables.limit, 12);
  assert.equal(calls[0].body.variables.cursor, 'old-page');
});

test('search supports mine, reviewed, involved, ready and recent and rejects unknown views', async () => {
  const { client, calls } = fixture({ graphql: () => response({ data: { search: { issueCount: 0, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }) });
  for (const [view, qualifier] of [['mine', 'author:@me'], ['reviewed', 'reviewed-by:@me'], ['involved', 'involves:@me'], ['ready', 'label:ready'], ['recent', 'is:open']]) {
    const result = await client.searchPRs({ view, query: 'label:bug' });
    assert.ok(result.query.includes(qualifier));
    assert.ok(result.query.includes('label:bug'));
    assert.equal(result.nextCursor, null);
  }
  await assert.rejects(client.searchPRs({ view: 'nope' }), /Unknown search view/);
  await assert.rejects(client.searchPRs({ limit: 101 }), /limit/);
  assert.equal(calls.length, 5);
});

test('CI commands use configured comments and return comment evidence', async () => {
  const { client, writes } = fixture();
  const result = await client.command(pin, 'retry', profile, { expectedHeadOid: 'a'.repeat(40) });
  assert.equal(result.action, 'retry');
  assert.equal(result.command, '/ci retry');
  assert.equal(result.commentUrl, 'https://github.com/acme/widget/pull/7#issuecomment-2');
  assert.equal(writes()[0].url, 'https://api.github.com/repos/acme/widget/issues/7/comments');
  assert.deepEqual(writes()[0].body, { body: '/ci retry' });
});

test('missing and unknown commands fail before any request or mutation', async () => {
  const { client, calls } = fixture();
  await assert.rejects(client.command(pin, 'retry', {}), /No retry CI command/);
  await assert.rejects(client.command(pin, '__proto__', profile), /CI command must be/);
  await assert.rejects(client.updateBranch(pin, {}, { runCi: true }), /No run CI command/);
  assert.equal(calls.length, 0);
});

test('a changed expected SHA or closed PR never receives a command', async () => {
  const first = fixture();
  await assert.rejects(first.client.command(pin, 'cancel', profile, { expectedHeadOid: 'old-sha' }), /head changed/);
  assert.equal(first.writes().length, 0);
  const second = fixture({ prs: [pullRequest({ state: 'MERGED' })] });
  await assert.rejects(second.client.command(pin, 'run', profile), /is merged/);
  assert.equal(second.writes().length, 0);
});

test('normal run refuses a stale branch while the explicit stale command works', async () => {
  const { client, writes } = fixture({ behind: 2 });
  await assert.rejects(client.command(pin, 'run', profile), /behind its base/);
  assert.equal(writes().length, 0);
  await client.command(pin, 'stale', profile);
  assert.deepEqual(writes()[0].body, { body: '/ci run --allow-stale' });
});

test('normal run refuses unknown freshness', async () => {
  const { client, writes } = fixture({ graphql: body => body.query.includes('query PingboardCompare') && response({ data: { repository: { ref: null } } }) });
  await assert.rejects(client.command(pin, 'run', profile), /freshness is unknown/);
  assert.equal(writes().length, 0);
});

test('comparison failures keep closed and merged PRs readable for board cleanup', async () => {
  for (const state of ['CLOSED', 'MERGED']) {
    const { client } = fixture({ prs: [pullRequest({ state })], graphql: body => body.query.includes('query PingboardCompare') && response({ errors: [{ message: 'Could not resolve head ref' }] }) });
    const result = await client.getPR(pin, profile);
    assert.equal(result.state, state);
    assert.equal(result.behind, null);
    assert.match(result.branchComparisonError, /Could not resolve head ref/);
    assert.equal(result.ci.state, 'passed');
  }
});

test('comparison errors cannot be mistaken for a current branch when running CI', async () => {
  const { client, writes } = fixture({ graphql: body => body.query.includes('query PingboardCompare') && response({ errors: [{ message: 'Comparison unavailable' }] }) });
  await assert.rejects(client.command(pin, 'run', profile), /freshness is unknown/);
  assert.equal(writes().length, 0);
});

test('branch update uses the fresh expected SHA and reports an accepted async request', async () => {
  const { client, writes } = fixture({ behind: 2 });
  const result = await client.updateBranch(pin, profile, { expectedHeadOid: 'a'.repeat(40) });
  assert.equal(result.status, 'accepted');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'PUT');
  assert.deepEqual(writes()[0].body, { expected_head_sha: 'a'.repeat(40) });
});

test('update then CI waits for a new head caught up to the base before posting', async () => {
  const newHead = 'b'.repeat(40);
  const { client, writes, sleeps } = fixture({ prs: [pullRequest(), pullRequest(), pullRequest({ head: newHead })], behind: [2, 2, 0], pollAttempts: 3 });
  const result = await client.updateBranch(pin, profile, { runCi: true });
  assert.equal(result.status, 'updated');
  assert.equal(result.headOid, newHead);
  assert.equal(result.ci.headOid, newHead);
  assert.equal(sleeps.length, 2);
  assert.deepEqual(writes().map(write => write.method), ['PUT', 'POST']);
  assert.deepEqual(writes()[1].body, { body: '/ci run' });
});

test('update polling timeout reports the accepted mutation without posting CI', async () => {
  const { client, writes, sleeps } = fixture({ behind: 2 });
  await assert.rejects(client.updateBranch(pin, profile, { runCi: true }), /accepted the branch update.*CI was not posted/);
  assert.equal(sleeps.length, 2);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'PUT');
});

test('an API error while polling reports the accepted update and no CI comment', async () => {
  let reads = 0;
  const { client, writes } = fixture({ behind: 2, graphql: body => {
    if (body.query.includes('query PingboardPullRequest') && ++reads > 1) return response({ errors: [{ message: 'Rate limited' }] });
    return null;
  } });
  await assert.rejects(client.updateBranch(pin, profile, { runCi: true }), /accepted the branch update.*Rate limited.*CI was not posted/);
  assert.equal(writes().length, 1);
});

test('a different head still behind its base is insufficient to run CI', async () => {
  const { client, writes } = fixture({ prs: [pullRequest(), pullRequest({ head: 'b'.repeat(40) })], behind: 2 });
  await assert.rejects(client.updateBranch(pin, profile, { runCi: true }), /CI was not posted/);
  assert.equal(writes().length, 1);
});

test('already current update-and-run runs CI without updating, even without branch edit permission', async () => {
  const { client, writes } = fixture({ prs: [pullRequest({ viewerCanUpdateBranch: false })], behind: 0 });
  const result = await client.updateBranch(pin, profile, { runCi: true });
  assert.equal(result.status, 'already_current');
  assert.equal(result.ci.command, '/ci run');
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].method, 'POST');
});

test('branch conflicts, lack of permission, stale SHA and update HTTP error block all later actions', async () => {
  for (const [overrides, error] of [[{ mergeable: 'CONFLICTING' }, /merge conflicts/], [{ viewerCanUpdateBranch: false }, /cannot update/], [{ state: 'CLOSED' }, /is closed/]]) {
    const f = fixture({ prs: [pullRequest(overrides)], behind: 2 });
    await assert.rejects(f.client.updateBranch(pin, profile, { runCi: true }), error);
    assert.equal(f.writes().length, 0);
  }
  const stale = fixture({ behind: 2 });
  await assert.rejects(stale.client.updateBranch(pin, profile, { expectedHeadOid: 'old' }), /head changed/);
  assert.equal(stale.writes().length, 0);
  const failed = fixture({ behind: 2, rest: () => response({ message: 'Head SHA mismatch' }, 422) });
  await assert.rejects(failed.client.updateBranch(pin, profile, { runCi: true }), /HTTP 422/);
  assert.equal(failed.writes().length, 1);
  assert.equal(failed.sleeps.length, 0);
});

test('baseline excludes unfinished builds without failure and counts each failing job once per commit', async () => {
  const { client } = fixture({ graphql: body => {
    if (body.query.includes('query PingboardBaseHistory')) return response({ data: { repository: { ref: { target: { history: { nodes: [
      { oid: 'pass', statusCheckRollup: { state: 'SUCCESS' } },
      { oid: 'fail', statusCheckRollup: { state: 'FAILURE' } },
      { oid: 'running', statusCheckRollup: { state: 'PENDING' } },
      { oid: 'empty', statusCheckRollup: null },
    ] } } } } } });
    if (body.query.includes('query PingboardContexts')) {
      const nodes = body.variables.oid === 'pass' ? [status('buildkite/main/unit')] : body.variables.oid === 'fail' ? [
        status('buildkite/main/unit', 'FAILURE'), status('buildkite/main/pr/unit', 'FAILURE'), status('buildkite/other/irrelevant', 'FAILURE'),
      ] : [status('buildkite/main/unit', 'PENDING')];
      return response({ data: { repository: { object: { statusCheckRollup: { contexts: connection(nodes) } } } } });
    }
    return null;
  } });
  const result = await client.getBaseline('acme/widget', 'release', profile);
  assert.equal(result.total, 2);
  assert.equal(result.counts.get('main/unit'), 1);
  assert.equal(result.counts.has('other/irrelevant'), false);
});

test('missing baseline history is an error, not evidence of no failures', async () => {
  const { client } = fixture({ graphql: () => response({ data: { repository: { ref: null } } }) });
  await assert.rejects(client.getBaseline('acme/widget', 'gone', profile), /history is unavailable/);
});

test('successful baselines are cached for ten minutes and a profile change refreshes them', async t => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const { client, calls } = fixture({ graphql: body => {
    if (body.query.includes('query PingboardBaseHistory')) return response({ data: { repository: { ref: { target: { history: { nodes: [{ oid: 'fail', statusCheckRollup: { state: 'FAILURE' } }] } } } } } });
    if (body.query.includes('query PingboardContexts')) return response({ data: { repository: { object: { statusCheckRollup: { contexts: connection([status('buildkite/main/test', 'FAILURE')]) } } } } });
    return null;
  } });
  const first = await client.getBaseline('acme/widget', 'release', profile);
  assert.equal(calls.length, 2);
  first.counts.clear();
  now += 599_999;
  const cached = await client.getBaseline('acme/widget', 'release', profile);
  assert.equal(cached.counts.get('main/test'), 1);
  assert.equal(calls.length, 2);
  now += 1;
  await client.getBaseline('acme/widget', 'release', profile);
  assert.equal(calls.length, 4);
  const changed = await client.getBaseline('acme/widget', 'release', { ...profile, mainPipeline: 'other' });
  assert.equal(changed.total, 0);
  assert.equal(calls.length, 6);
});

test('failed baselines are not cached', async () => {
  let reads = 0;
  const { client, calls } = fixture({ graphql: () => ++reads === 1
    ? response({ errors: [{ message: 'Unavailable' }] })
    : response({ data: { repository: { ref: { target: { history: { nodes: [] } } } } } }),
  });
  await assert.rejects(client.getBaseline('acme/widget', 'release', profile), /Unavailable/);
  assert.equal((await client.getBaseline('acme/widget', 'release', profile)).total, 0);
  assert.equal(calls.length, 2);
});

test('baseline cache evicts old entries after one hundred distinct boards', async () => {
  const { client, calls } = fixture({ graphql: () => response({ data: { repository: { ref: { target: { history: { nodes: [] } } } } } }) });
  for (let i = 0; i < 101; i += 1) await client.getBaseline('acme/widget', `branch-${i}`, profile);
  assert.equal(calls.length, 101);
  await client.getBaseline('acme/widget', 'branch-100', profile);
  assert.equal(calls.length, 101);
  await client.getBaseline('acme/widget', 'branch-0', profile);
  assert.equal(calls.length, 102);
});

test('invalid repository targets and missing credentials cannot send a request', async () => {
  const { client, calls } = fixture({ token: '' });
  await assert.rejects(client.getPR({ repo: 'https://evil.test/foo', number: 1 }), /owner\/name/);
  await assert.rejects(client.getPR({ repo: 'acme/widget', number: 0 }), /positive integer/);
  await assert.rejects(client.getPR(pin), /Set GITHUB_TOKEN/);
  assert.equal(calls.length, 0);
});

test('requests time out and transport exceptions cannot leak credentials', async () => {
  const client = new GitHubClient({
    token: 'secret-token', requestTimeoutMs: 2,
    fetchImpl: (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new Error('secret-token transport dump')));
    }),
  });
  await assert.rejects(client.getPR(pin), /^Error: GitHub request timed out\.$/);
  assert.doesNotMatch(JSON.stringify(client), /secret-token/);
});

test('an ambiguous network failure during a write reports the outcome honestly', async () => {
  const { client, writes } = fixture({ rest: () => { throw new Error('test-secret-token'); } });
  await assert.rejects(client.command(pin, 'retry', profile), error => /write outcome may be unknown/.test(error.message) && !error.message.includes('test-secret-token'));
  assert.equal(writes().length, 1);
});
