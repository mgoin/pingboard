const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_PAGES = Number(process.env.PINGBOARD_PAGES || 2);
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;

if (!token) {
  console.error("Set GITHUB_TOKEN or GH_TOKEN to a classic GitHub token with the notifications scope.");
  process.exit(2);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": API_VERSION
};

const user = await github("/user");
const notifications = await fetchNotifications();
const enriched = await Promise.all(notifications.map(enrichNotification));
const lanes = groupBy(enriched, (item) => item.lane);

printSummary(enriched);
for (const lane of ["direct", "review", "ambient", "system"]) {
  printLane(lane, lanes.get(lane) || []);
}

async function github(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_ROOT}${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      ...headers,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(data?.message || `${response.status} ${response.statusText}`);
  }
  return data;
}

async function fetchNotifications() {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      all: String(process.argv.includes("--all")),
      participating: String(process.argv.includes("--mine")),
      per_page: "50",
      page: String(page)
    });
    const pageRows = await github(`/notifications?${params}`);
    rows.push(...pageRows);
    if (pageRows.length < 50) break;
  }
  return rows;
}

async function enrichNotification(notification) {
  const subject = await safeGithub(notification.subject?.url);
  const latest = await safeGithub(notification.subject?.latest_comment_url);
  const pull = notification.subject?.type === "PullRequest"
    ? subject
    : subject?.pull_request?.url
      ? await safeGithub(subject.pull_request.url)
      : null;
  const classification = classify(notification, subject, latest, pull);
  return {
    ...classification,
    notification,
    subject,
    latest,
    pull,
    actor: latest?.user?.login || subject?.user?.login || pull?.user?.login || "github",
    title: subject?.title || pull?.title || notification.subject?.title || "Untitled thread",
    repo: notification.repository?.full_name || "unknown/repo",
    updated: notification.updated_at,
    url: latest?.html_url || subject?.html_url || pull?.html_url || notification.repository?.html_url
  };
}

async function safeGithub(url) {
  if (!url) return null;
  try {
    return await github(url);
  } catch {
    return null;
  }
}

function classify(notification, subject, latest, pull) {
  const reason = notification.reason || "unknown";
  const latestBody = latest?.body || "";
  const subjectBody = subject?.body || pull?.body || "";
  const login = user.login || "";
  const mentioned = login && new RegExp(`(^|[^\\w-])@${escapeRegExp(login)}\\b`, "i").test(`${latestBody}\n${subjectBody}`);
  const requestedReviewers = pull?.requested_reviewers || [];
  const requestedTeams = pull?.requested_teams || [];
  const personalReview = requestedReviewers.some((reviewer) => reviewer.login?.toLowerCase() === login.toLowerCase());

  if (reason === "mention" || reason === "team_mention" || mentioned) {
    return { lane: "direct", why: reason === "team_mention" ? "team mention" : "direct mention" };
  }
  if (reason === "assign" || reason === "author") {
    return { lane: "direct", why: reason === "assign" ? "assigned to you" : "you authored the thread" };
  }
  if (reason === "review_requested") {
    if (personalReview) return { lane: "review", why: "you are individually requested" };
    if (requestedTeams.length) return { lane: "ambient", why: `team review request: ${requestedTeams.map((team) => team.name || team.slug).join(", ")}` };
    return { lane: "review", why: "review requested" };
  }
  if (["ci_activity", "security_alert", "security_advisory_credit", "member_feature_requested", "invitation", "state_change"].includes(reason)) {
    return { lane: "system", why: reason.replaceAll("_", " ") };
  }
  return { lane: "ambient", why: reason };
}

function groupBy(items, keyFn) {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    map.set(key, [...(map.get(key) || []), item]);
  }
  return map;
}

function printSummary(items) {
  console.log(`# GitHub Notifications for ${user.login}`);
  console.log("");
  console.log(`Fetched ${items.length} notification${items.length === 1 ? "" : "s"}.`);
  console.log("");
}

function printLane(name, items) {
  console.log(`## ${capitalize(name)} (${items.length})`);
  if (!items.length) {
    console.log("");
    return;
  }
  for (const item of items) {
    console.log(`- ${item.repo}: ${item.title}`);
    console.log(`  ${item.why} - ${timeAgo(item.updated)} - ${item.actor}`);
    if (item.url) console.log(`  ${item.url}`);
  }
  console.log("");
}

function timeAgo(value) {
  const minutes = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function capitalize(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
