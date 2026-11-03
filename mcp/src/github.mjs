import core from '../../core.js';

const { normalizeChecks, summarizeCi, isCiCheck, safeUrl, pinKey } = core;
const API_ROOT = 'https://api.github.com';
const MAX_CONTEXT_PAGES = 15;
const BASELINE_COMMITS = 30;
const BASELINE_TTL_MS = 10 * 60 * 1000;
const MAX_BASELINE_CACHE_ENTRIES = 100;
const GENERIC_PROFILE = { ciPrefix: null, mainPipeline: null, ciCommands: null };
const CONTEXT_FIELDS = `
  __typename
  ... on StatusContext { context state description targetUrl createdAt }
  ... on CheckRun { name status conclusion detailsUrl startedAt checkSuite { app { slug } } }`;

const PR_QUERY = `query PingboardPullRequest($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      id number title url state isDraft updatedAt
      author { login } authorAssociation baseRefName headRefOid
      mergeable mergeStateStatus reviewDecision viewerCanUpdateBranch
      autoMergeRequest { enabledAt }
      additions deletions changedFiles
      labels(first: 40) { nodes { name color } }
      latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
      reviewRequests(first: 100) {
        pageInfo { hasNextPage }
        nodes { requestedReviewer {
          __typename
          ... on User { login }
          ... on Team { slug name organization { login } }
        } }
      }
      comments(last: 5) { nodes { author { login } bodyText createdAt url } }
      commits(last: 1) { nodes { commit {
        oid committedDate
        statusCheckRollup { state contexts(first: 100) {
          totalCount pageInfo { hasNextPage endCursor }
          nodes { ${CONTEXT_FIELDS} }
        } }
      } } }
    }
  }
}`;

const COMPARE_QUERY = `query PingboardCompare($owner: String!, $name: String!, $baseRef: String!, $headRef: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $baseRef) { compare(headRef: $headRef) { aheadBy behindBy } }
  }
}`;

const CONTEXTS_QUERY = `query PingboardContexts($owner: String!, $name: String!, $oid: GitObjectID!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) { ... on Commit { statusCheckRollup { contexts(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${CONTEXT_FIELDS} }
    } } } }
  }
}`;

const BASE_HISTORY_QUERY = `query PingboardBaseHistory($owner: String!, $name: String!, $ref: String!, $count: Int!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) { target { ... on Commit { history(first: $count) {
      nodes { oid statusCheckRollup { state } }
    } } } }
  }
}`;

const SEARCH_QUERY = `query PingboardSearch($query: String!, $limit: Int!, $cursor: String) {
  search(type: ISSUE, first: $limit, after: $cursor, query: $query) {
    issueCount pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest {
      number title state isDraft updatedAt url
      author { login } reviewDecision
      repository { nameWithOwner }
      labels(first: 8) { nodes { name color } }
      commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    } }
  }
}`;

function repositoryParts(repo) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error('Repository must be owner/name on github.com.');
  }
  return repo.split('/');
}

function validatePin(pin) {
  const [owner, name] = repositoryParts(pin?.repo);
  if (!Number.isSafeInteger(pin.number) || pin.number < 1) throw new Error('Pull request number must be a positive integer.');
  return { owner, name };
}

function commandFor(profile, kind) {
  if (!['run', 'retry', 'cancel', 'stale'].includes(kind)) throw new Error('CI command must be run, retry, cancel, or stale.');
  const command = profile?.ciCommands?.[kind];
  if (typeof command !== 'string' || !command.trim()) throw new Error(`No ${kind} CI command configured for this repository.`);
  return command.trim();
}

function guardPR(pr, expectedHeadOid) {
  if (pr.state !== 'OPEN') throw new Error(`Pull request is ${pr.state.toLowerCase()}; no action was taken.`);
  if (!pr.headOid) throw new Error('GitHub did not return a head commit; no action was taken.');
  if (expectedHeadOid !== undefined && expectedHeadOid !== pr.headOid) {
    throw new Error(`Pull request head changed (expected ${expectedHeadOid}, found ${pr.headOid}); inspect it again before acting.`);
  }
}

/** GitHub.com transport. All mutations first re-read the PR; no credentials enter results. */
export class GitHubClient {
  #token;
  #baselineCache = new Map();

  constructor({ token, fetchImpl = globalThis.fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    pollAttempts = 15, pollIntervalMs = 2000, requestTimeoutMs = 15000 } = {}) {
    this.#token = typeof token === 'string' ? token.trim() : '';
    this.fetchImpl = fetchImpl;
    this.sleep = sleep;
    this.pollAttempts = Math.min(30, Math.max(1, Math.trunc(pollAttempts) || 15));
    this.pollIntervalMs = Math.min(5000, Math.max(0, Number(pollIntervalMs) || 0));
    this.requestTimeoutMs = Math.min(60000, Math.max(1, Number(requestTimeoutMs) || 15000));
  }

  cleanMessage(message) {
    const value = String(message || 'Unknown GitHub error');
    return (this.#token ? value.split(this.#token).join('[redacted]') : value).replace(/[\r\n]+/g, ' ').slice(0, 600);
  }

  async request(method, path, body) {
    if (!this.#token) throw new Error('Set GITHUB_TOKEN or GH_TOKEN to access GitHub.');
    // Paths are generated by this client, and redirects cannot send credentials elsewhere.
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error('Invalid GitHub API path.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    let json;
    try {
      response = await this.fetchImpl(`${API_ROOT}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'pingboard-mcp',
        },
        redirect: 'error',
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      json = await response.json().catch(() => null);
    } catch {
      const message = controller.signal.aborted ? 'GitHub request timed out.' : 'GitHub request failed; check connectivity.';
      const write = path !== '/graphql' && method !== 'GET';
      throw new Error(`${message}${write ? ' The write outcome may be unknown; inspect the PR before retrying.' : ''}`);
    } finally {
      clearTimeout(timeout);
    }
    if (!response.ok) {
      if (response.status === 401) throw new Error('GitHub rejected the token (HTTP 401).');
      throw new Error(`GitHub HTTP ${response.status}: ${this.cleanMessage(json?.message || response.statusText)}`);
    }
    if (json === null) throw new Error('GitHub returned an invalid JSON response.');
    return json;
  }

  async gql(query, variables) {
    const json = await this.request('POST', '/graphql', { query, variables });
    if (json.errors?.length || !json.data) {
      throw new Error(`GitHub GraphQL: ${this.cleanMessage(json.errors?.[0]?.message || 'No data returned')}`);
    }
    return json.data;
  }

  async contextNodes(owner, name, oid, initial) {
    const nodes = [];
    const seen = new Set();
    let connection = initial;
    let cursor = null;
    for (let page = 0; page < MAX_CONTEXT_PAGES; page += 1) {
      if (!connection) {
        const data = await this.gql(CONTEXTS_QUERY, { owner, name, oid, cursor });
        const commit = data.repository?.object;
        if (!commit) throw new Error('GitHub did not return the commit while loading checks.');
        if (!commit.statusCheckRollup) {
          if (!cursor) return [];
          throw new Error('GitHub checks disappeared during pagination; refresh the PR.');
        }
        connection = commit.statusCheckRollup.contexts;
      }
      if (!Array.isArray(connection?.nodes) || typeof connection?.pageInfo?.hasNextPage !== 'boolean') {
        throw new Error('GitHub returned incomplete check data; CI status is unavailable.');
      }
      if (connection.nodes.some(node => !node)) throw new Error('GitHub returned an unreadable check; CI status is unavailable.');
      nodes.push(...connection.nodes);
      if (!connection.pageInfo.hasNextPage) return nodes;
      const next = connection.pageInfo.endCursor;
      if (!next || seen.has(next)) throw new Error('GitHub check pagination did not advance; CI status is unavailable.');
      seen.add(next);
      cursor = next;
      connection = null;
    }
    throw new Error(`Checks exceeded the ${MAX_CONTEXT_PAGES * 100}-entry safety limit; CI status is unavailable.`);
  }

  async getPR(pin, profile = GENERIC_PROFILE) {
    const { owner, name } = validatePin(pin);
    const data = await this.gql(PR_QUERY, { owner, name, number: pin.number });
    const pr = data.repository?.pullRequest;
    if (!pr) throw new Error('Pull request not found, or the token cannot see it.');
    const commit = pr.commits?.nodes?.[0]?.commit;
    if (!commit || !pr.headRefOid || commit.oid !== pr.headRefOid) {
      throw new Error('GitHub did not return a consistent PR head commit; refresh the PR.');
    }
    const contexts = commit.statusCheckRollup?.contexts;
    if (commit.statusCheckRollup && !contexts) throw new Error('GitHub returned incomplete check data; CI status is unavailable.');
    const checks = normalizeChecks(contexts ? await this.contextNodes(owner, name, commit.oid, contexts) : []);
    // The real base may be something other than main. A missing comparison remains unknown.
    let behind = null;
    let branchComparisonError = null;
    try {
      const compared = await this.gql(COMPARE_QUERY, { owner, name, baseRef: `refs/heads/${pr.baseRefName}`, headRef: `refs/pull/${pin.number}/head` });
      behind = compared.repository?.ref?.compare?.behindBy ?? null;
      if (behind === null) branchComparisonError = 'GitHub did not return a branch comparison.';
    } catch (error) {
      // Deleted refs and inaccessible comparisons must not hide an otherwise readable PR.
      branchComparisonError = this.cleanMessage(error.message);
    }
    const requestedReviewers = (pr.reviewRequests?.nodes || []).flatMap(request => {
      const reviewer = request?.requestedReviewer;
      if (reviewer?.__typename === 'User') return [{ type: 'user', login: reviewer.login }];
      if (reviewer?.__typename === 'Team') return [{ type: 'team', slug: reviewer.slug, name: reviewer.name, organization: reviewer.organization?.login }];
      return [];
    });
    return {
      key: pinKey(pin.repo, pin.number), repo: pin.repo, number: pr.number, id: pr.id,
      title: pr.title, url: safeUrl(pr.url), state: pr.state, isDraft: pr.isDraft,
      updatedAt: pr.updatedAt, author: pr.author?.login || 'ghost', authorAssociation: pr.authorAssociation,
      base: pr.baseRefName, headOid: pr.headRefOid, headDate: commit.committedDate,
      mergeable: pr.mergeable, mergeState: pr.mergeStateStatus, reviewDecision: pr.reviewDecision,
      canUpdate: pr.viewerCanUpdateBranch, autoMerge: Boolean(pr.autoMergeRequest),
      additions: pr.additions, deletions: pr.deletions, files: pr.changedFiles,
      labels: pr.labels?.nodes || [],
      reviews: (pr.latestOpinionatedReviews?.nodes || []).filter(Boolean).map(review => ({ login: review.author?.login || 'ghost', state: review.state })),
      requestedReviewers, requestedReviewersTruncated: Boolean(pr.reviewRequests?.pageInfo?.hasNextPage),
      comments: (pr.comments?.nodes || []).filter(Boolean).map(comment => ({ login: comment.author?.login || 'ghost', text: (comment.bodyText || '').slice(0, 700), at: comment.createdAt, url: safeUrl(comment.url) })),
      behind, branchComparisonError,
      checks, ci: summarizeCi(checks, profile),
    };
  }

  async getBaseline(repo, base, profile = GENERIC_PROFILE) {
    const [owner, name] = repositoryParts(repo);
    if (typeof base !== 'string' || !base || base.length > 1024) throw new Error('A base branch name is required.');
    const cacheKey = JSON.stringify([repo.toLowerCase(), base, profile]);
    const cached = this.#baselineCache.get(cacheKey);
    if (cached && Date.now() - cached.at < BASELINE_TTL_MS) return { ...cached, counts: new Map(cached.counts) };
    if (cached) this.#baselineCache.delete(cacheKey);
    const data = await this.gql(BASE_HISTORY_QUERY, { owner, name, ref: `refs/heads/${base}`, count: BASELINE_COMMITS });
    const commits = data.repository?.ref?.target?.history?.nodes;
    if (!Array.isArray(commits)) throw new Error('Base branch history is unavailable.');
    const counts = new Map();
    let total = 0;
    const withChecks = commits.filter(commit => commit?.statusCheckRollup);
    // Four requests in flight at most, and only the most recent 30 commits.
    for (let start = 0; start < withChecks.length; start += 4) {
      const results = await Promise.all(withChecks.slice(start, start + 4).map(async commit => {
        const checks = normalizeChecks(await this.contextNodes(owner, name, commit.oid)).filter(check => isCiCheck(check, profile));
        const jobs = checks.filter(check => !check.isBuild);
        return { finished: jobs.length > 0 && !checks.some(check => check.state === 'pending'), failed: jobs.filter(check => check.state === 'fail').map(check => check.jobKey) };
      }));
      for (const result of results) {
        if (!result.finished && !result.failed.length) continue;
        total += 1;
        for (const jobKey of new Set(result.failed)) counts.set(jobKey, (counts.get(jobKey) || 0) + 1);
      }
    }
    const result = { at: Date.now(), total, counts };
    this.#baselineCache.set(cacheKey, result);
    while (this.#baselineCache.size > MAX_BASELINE_CACHE_ENTRIES) {
      this.#baselineCache.delete(this.#baselineCache.keys().next().value);
    }
    return { ...result, counts: new Map(counts) };
  }

  async searchPRs({ repo, view = 'review_requested', query = '', limit = 30, cursor = null } = {}) {
    if (repo) repositoryParts(repo);
    const views = {
      review_requested: 'review-requested:@me', mine: 'author:@me', reviewed: 'reviewed-by:@me',
      involved: 'involves:@me', ready: 'label:ready', recent: '',
    };
    if (!Object.hasOwn(views, view)) throw new Error(`Unknown search view: ${view}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('Search limit must be from 1 to 100.');
    if (typeof query !== 'string' || query.length > 2000) throw new Error('Search query must contain at most 2000 characters.');
    if (cursor !== null && (typeof cursor !== 'string' || cursor.length > 1024)) throw new Error('Invalid search cursor.');
    const searchQuery = ['is:pr is:open', repo && `repo:${repo}`, views[view], query.trim(), 'sort:updated-desc'].filter(Boolean).join(' ');
    const data = await this.gql(SEARCH_QUERY, { query: searchQuery, limit, cursor });
    if (!Array.isArray(data.search?.nodes) || typeof data.search?.pageInfo?.hasNextPage !== 'boolean') throw new Error('GitHub returned incomplete search results.');
    if (data.search.pageInfo.hasNextPage && !data.search.pageInfo.endCursor) throw new Error('GitHub did not return the next search cursor.');
    const items = data.search.nodes.filter(pr => pr?.number && pr?.repository?.nameWithOwner).map(pr => ({
      key: pinKey(pr.repository.nameWithOwner, pr.number), repo: pr.repository.nameWithOwner,
      number: pr.number, title: pr.title, state: pr.state, isDraft: pr.isDraft, updatedAt: pr.updatedAt,
      url: safeUrl(pr.url), author: pr.author?.login || 'ghost', reviewDecision: pr.reviewDecision,
      labels: pr.labels?.nodes || [], ciState: pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null,
    }));
    return { items, total: data.search.issueCount, nextCursor: data.search.pageInfo.hasNextPage ? data.search.pageInfo.endCursor : null, query: searchQuery };
  }

  async postCommand(pr, kind, command) {
    const comment = await this.request('POST', `/repos/${pr.repo}/issues/${pr.number}/comments`, { body: command });
    return { action: kind, repo: pr.repo, number: pr.number, headOid: pr.headOid, command, commentUrl: safeUrl(comment.html_url) };
  }

  async command(pin, kind, profile = GENERIC_PROFILE, { expectedHeadOid } = {}) {
    validatePin(pin);
    const command = commandFor(profile, kind);
    const pr = await this.getPR(pin, profile);
    guardPR(pr, expectedHeadOid);
    if (kind === 'run' && pr.behind === null) throw new Error('Branch freshness is unknown; inspect it before running CI.');
    if (kind === 'run' && pr.behind > 0) throw new Error('Branch is behind its base; use the stale CI command or update the branch and run CI.');
    return this.postCommand(pr, kind, command);
  }

  async updateBranch(pin, profile = GENERIC_PROFILE, { runCi = false, expectedHeadOid } = {}) {
    validatePin(pin);
    // Validate before update: missing command must never leave a half-completed workflow.
    const command = runCi ? commandFor(profile, 'run') : null;
    const pr = await this.getPR(pin, profile);
    guardPR(pr, expectedHeadOid);
    if (pr.behind === 0) {
      const ci = runCi ? await this.postCommand(pr, 'run', command) : undefined;
      return { action: 'update_branch', repo: pr.repo, number: pr.number, status: 'already_current', previousHeadOid: pr.headOid, headOid: pr.headOid, ...(ci ? { ci } : {}) };
    }
    if (!pr.canUpdate) throw new Error('GitHub says you cannot update this branch; no action was taken.');
    if (pr.mergeable === 'CONFLICTING') throw new Error('Pull request has merge conflicts; no action was taken.');
    await this.request('PUT', `/repos/${pr.repo}/pulls/${pr.number}/update-branch`, { expected_head_sha: pr.headOid });
    if (!runCi) return { action: 'update_branch', repo: pr.repo, number: pr.number, status: 'accepted', previousHeadOid: pr.headOid };
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      await this.sleep(this.pollIntervalMs);
      let fresh;
      try {
        fresh = await this.getPR(pin, profile);
        guardPR(fresh);
      } catch (error) {
        throw new Error(`GitHub accepted the branch update, but polling failed: ${this.cleanMessage(error.message)} CI was not posted. Inspect the PR before retrying.`);
      }
      if (fresh.headOid === pr.headOid || fresh.behind !== 0) continue;
      const ci = await this.postCommand(fresh, 'run', command);
      return { action: 'update_branch', repo: pr.repo, number: pr.number, status: 'updated', previousHeadOid: pr.headOid, headOid: fresh.headOid, ci };
    }
    throw new Error('GitHub accepted the branch update, but an updated head caught up to the base was not observed before the polling limit. CI was not posted. Inspect the PR before retrying.');
  }
}
