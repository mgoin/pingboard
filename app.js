const STORAGE_KEY = "pingboard.githubToken";
const SESSION_KEY = "pingboard.sessionToken";
const API_ROOT = "https://api.github.com";
const API_VERSION = "2022-11-28";
const MAX_PAGES = 3;

const icons = {
  bell: ["M10.268 21a2 2 0 0 0 3.464 0", "M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.674C19.41 13.956 18 12.499 18 8a6 6 0 1 0-12 0c0 4.499-1.411 5.956-2.738 7.326"],
  search: ["M21 21l-4.34-4.34", "M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z"],
  refresh: ["M21 12a9 9 0 0 0-15-6.7L3 8", "M3 3v5h5", "M3 12a9 9 0 0 0 15 6.7L21 16", "M16 16h5v5"],
  logOut: ["M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4", "M16 17l5-5-5-5", "M21 12H9"],
  user: ["M19 21a7 7 0 0 0-14 0", "M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z"],
  users: ["M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2", "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z", "M22 21v-2a4 4 0 0 0-3-3.87", "M16 3.13a4 4 0 0 1 0 7.75"],
  gitPullRequest: ["M18 18a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 6a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", "M6 21V6", "M18 21v-3", "M18 12V9a3 3 0 0 0-3-3h-1"],
  inbox: ["M22 12h-6l-2 3h-4l-2-3H2", "M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"],
  activity: ["M22 12h-4l-3 9L9 3l-3 9H2"],
  check: ["M20 6 9 17l-5-5"],
  external: ["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"],
  eyeOff: ["M10.733 5.076A10.744 10.744 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68", "M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61", "M2 2l20 20", "M9.88 9.88a3 3 0 1 0 4.24 4.24"],
  shield: ["M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1Z"],
  circle: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z"],
  zap: ["M13 2 3 14h9l-1 8 10-12h-9l1-8Z"],
  filter: ["M22 3H2l8 9.46V19l4 2v-8.54L22 3Z"],
  lock: ["M6 10V8a6 6 0 0 1 12 0v2", "M5 10h14v11H5z"]
};

const lanes = [
  {
    id: "all",
    name: "All",
    hint: "Everything fetched",
    color: "var(--ambient)",
    icon: "inbox"
  },
  {
    id: "direct",
    name: "Direct",
    hint: "@, assigned, authored",
    color: "var(--direct)",
    icon: "user"
  },
  {
    id: "review",
    name: "Review",
    hint: "Personal asks",
    color: "var(--review)",
    icon: "gitPullRequest"
  },
  {
    id: "ambient",
    name: "Ambient",
    hint: "Watching and comments",
    color: "var(--ambient)",
    icon: "activity"
  },
  {
    id: "system",
    name: "System",
    hint: "CI, security, admin",
    color: "var(--system)",
    icon: "shield"
  }
];

const state = {
  token: localStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(SESSION_KEY) || "",
  remember: Boolean(localStorage.getItem(STORAGE_KEY)),
  demo: false,
  user: null,
  notifications: [],
  enriched: new Map(),
  selectedId: null,
  filter: "all",
  includeRead: false,
  participating: false,
  query: "",
  loading: false,
  authLoading: false,
  error: "",
  toast: ""
};

const app = document.querySelector("#app");

function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  for (const d of icons[name] || icons.circle) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

function el(tag, options = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined || value === null) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (key === "style" && typeof value === "object") Object.assign(node.style, value);
    else node.setAttribute(key, value);
  }
  for (const child of Array.isArray(children) ? children : [children]) {
    if (child === undefined || child === null) continue;
    node.append(child);
  }
  return node;
}

function button({ className = "icon-button", label, title, iconName, pressed, onClick, text }) {
  const children = [];
  if (iconName) children.push(icon(iconName));
  if (text) children.push(el("span", { text }));
  const node = el("button", {
    class: className,
    type: "button",
    title: title || label,
    "aria-label": label,
    "aria-pressed": pressed === undefined ? undefined : String(pressed),
    onclick: onClick
  }, children);
  return node;
}

function routeColor(laneId) {
  return (lanes.find((lane) => lane.id === laneId) || lanes[0]).color;
}

function formatTime(value) {
  if (!value) return "unknown";
  const date = new Date(value);
  const seconds = Math.max(1, Math.floor((Date.now() - date.getTime()) / 1000));
  const units = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60]
  ];
  for (const [unit, size] of units) {
    const amount = Math.floor(seconds / size);
    if (amount >= 1) return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

function textFromMarkdown(input = "") {
  return input
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function mentionRegex(login) {
  return new RegExp(`(^|[^\\w-])@${escapeRegExp(login)}\\b`, "i");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function htmlUrlFromApi(url) {
  if (!url) return "";
  return url
    .replace("https://api.github.com/repos/", "https://github.com/")
    .replace("/pulls/", "/pull/")
    .replace("/issues/comments/", "/issues/comment/")
    .replace("/pulls/comments/", "/pull/")
    .replace("/commits/", "/commit/");
}

async function github(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_ROOT}${pathOrUrl}`;
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${state.token}`,
      "X-GitHub-Api-Version": API_VERSION,
      ...(options.headers || {})
    }
  });

  if (response.status === 204 || response.status === 205 || response.status === 304) {
    return null;
  }

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message = data?.message || `${response.status} ${response.statusText}`;
    throw new Error(message);
  }
  return data;
}

async function fetchNotifications() {
  if (state.demo) {
    loadDemo();
    return;
  }

  state.loading = true;
  state.error = "";
  render();

  try {
    const pages = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const params = new URLSearchParams({
        all: String(state.includeRead),
        participating: String(state.participating),
        per_page: "50",
        page: String(page)
      });
      const rows = await github(`/notifications?${params}`);
      if (!Array.isArray(rows) || rows.length === 0) break;
      pages.push(...rows);
      if (rows.length < 50) break;
    }

    state.notifications = pages;
    state.enriched = new Map();
    state.selectedId = pages[0]?.id || null;
    render();

    await enrichVisibleNotifications(pages);
  } catch (error) {
    state.error = error.message;
  } finally {
    state.loading = false;
    render();
  }
}

async function enrichVisibleNotifications(rows) {
  const queue = [...rows];
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const notification = queue.shift();
      try {
        const enriched = await enrichNotification(notification);
        state.enriched.set(notification.id, enriched);
        render();
      } catch (error) {
        state.enriched.set(notification.id, {
          notification,
          lane: classify(notification).lane,
          reasonLabel: classify(notification).reasonLabel,
          context: "GitHub returned a notification, but the linked thread could not be enriched.",
          error: error.message,
          pills: [notification.reason],
          snippet: "",
          actor: null,
          htmlUrl: htmlUrlFromApi(notification.subject?.url)
        });
        render();
      }
    }
  });
  await Promise.all(workers);
}

async function enrichNotification(notification) {
  const [subject, latest] = await Promise.all([
    safeGithub(notification.subject?.url),
    notification.subject?.latest_comment_url ? safeGithub(notification.subject.latest_comment_url) : null
  ]);

  let pull = null;
  if (notification.subject?.type === "PullRequest") {
    pull = subject;
  } else if (subject?.pull_request?.url) {
    pull = await safeGithub(subject.pull_request.url);
  }

  const issue = subject?.pull_request ? subject : pull?.issue_url ? await safeGithub(pull.issue_url) : subject;
  const classification = classify(notification, subject, latest, pull);
  const actor = latest?.user || subject?.user || pull?.user || notification.repository?.owner || null;
  const title = subject?.title || pull?.title || notification.subject?.title || "Untitled thread";
  const snippet = textFromMarkdown(latest?.body || subject?.body || pull?.body || "");
  const htmlUrl = latest?.html_url || subject?.html_url || pull?.html_url || htmlUrlFromApi(notification.subject?.url);

  return {
    notification,
    subject,
    latest,
    pull,
    issue,
    actor,
    title,
    snippet,
    htmlUrl,
    lane: classification.lane,
    reasonLabel: classification.reasonLabel,
    context: classification.context,
    pills: classification.pills,
    reviewStyle: classification.reviewStyle
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

function classify(notification, subject = null, latest = null, pull = null) {
  const reason = notification.reason || "unknown";
  const login = state.user?.login || "";
  const latestBody = latest?.body || "";
  const subjectBody = subject?.body || pull?.body || "";
  const mentionedInLatest = Boolean(login && mentionRegex(login).test(latestBody));
  const mentionedInSubject = Boolean(login && mentionRegex(login).test(subjectBody));
  const requestedReviewers = pull?.requested_reviewers || [];
  const requestedTeams = pull?.requested_teams || [];
  const personallyRequested = requestedReviewers.some((reviewer) => reviewer.login?.toLowerCase() === login.toLowerCase());
  const teamRequested = requestedTeams.length > 0;

  if (reason === "mention" || mentionedInLatest || mentionedInSubject) {
    return {
      lane: "direct",
      reasonLabel: reason === "team_mention" ? "Team mention" : "Direct mention",
      context: mentionedInLatest
        ? "The newest comment names you directly."
        : "This thread reached you through an @mention.",
      pills: ["@", reason]
    };
  }

  if (reason === "team_mention") {
    return {
      lane: "direct",
      reasonLabel: "Team mention",
      context: "A team you belong to was mentioned.",
      pills: ["team", reason]
    };
  }

  if (reason === "assign") {
    return {
      lane: "direct",
      reasonLabel: "Assigned",
      context: "You were assigned to this issue or pull request.",
      pills: ["assigned", reason]
    };
  }

  if (reason === "author") {
    return {
      lane: "direct",
      reasonLabel: "Your thread",
      context: "You created this thread, so later activity comes back to you.",
      pills: ["author", reason]
    };
  }

  if (reason === "review_requested") {
    if (personallyRequested) {
      return {
        lane: "review",
        reasonLabel: "Personal review",
        context: "You are individually listed as a requested reviewer.",
        pills: ["personal review", reason],
        reviewStyle: "personal"
      };
    }

    if (teamRequested) {
      return {
        lane: "ambient",
        reasonLabel: "Team review",
        context: `A team review request is active: ${requestedTeams.map((team) => team.name || team.slug).join(", ")}.`,
        pills: ["team review", "possible CODEOWNERS", reason],
        reviewStyle: "team"
      };
    }

    return {
      lane: "review",
      reasonLabel: "Review request",
      context: "GitHub says you or one of your teams was requested for review.",
      pills: ["review", reason],
      reviewStyle: "unknown"
    };
  }

  if (reason === "approval_requested") {
    return {
      lane: "review",
      reasonLabel: "Deployment approval",
      context: "A deployment is waiting on your approval.",
      pills: ["deployment", reason]
    };
  }

  if (["ci_activity", "security_alert", "security_advisory_credit", "member_feature_requested", "invitation", "state_change"].includes(reason)) {
    return {
      lane: "system",
      reasonLabel: systemLabel(reason),
      context: systemContext(reason),
      pills: [reason.replaceAll("_", " ")]
    };
  }

  if (reason === "manual") {
    return {
      lane: "ambient",
      reasonLabel: "Manual subscription",
      context: "You manually subscribed to this thread.",
      pills: ["manual", reason]
    };
  }

  if (reason === "comment") {
    return {
      lane: "ambient",
      reasonLabel: "Comment follow-up",
      context: "You commented earlier, so this is follow-up activity.",
      pills: ["comment", reason]
    };
  }

  return {
    lane: "ambient",
    reasonLabel: "Watching",
    context: "This is coming from repository watch settings or a broad subscription.",
    pills: [reason]
  };
}

function systemLabel(reason) {
  return {
    ci_activity: "CI activity",
    security_alert: "Security alert",
    security_advisory_credit: "Advisory credit",
    member_feature_requested: "Org request",
    invitation: "Invitation",
    state_change: "State change"
  }[reason] || "System";
}

function systemContext(reason) {
  return {
    ci_activity: "A workflow run that you triggered completed.",
    security_alert: "GitHub detected a security vulnerability in a repository.",
    security_advisory_credit: "You were credited for a security advisory.",
    member_feature_requested: "Organization members requested a feature change.",
    invitation: "You accepted a repository invitation.",
    state_change: "You changed this thread state earlier."
  }[reason] || "GitHub generated this notification from account or repository activity.";
}

function getEnriched(notification) {
  return state.enriched.get(notification.id) || {
    notification,
    title: notification.subject?.title || "Untitled thread",
    lane: classify(notification).lane,
    reasonLabel: classify(notification).reasonLabel,
    context: classify(notification).context,
    pills: [notification.reason],
    snippet: "",
    actor: notification.repository?.owner,
    htmlUrl: htmlUrlFromApi(notification.subject?.url)
  };
}

function filteredNotifications() {
  const query = state.query.trim().toLowerCase();
  return state.notifications.filter((notification) => {
    const enriched = getEnriched(notification);
    const laneMatch = state.filter === "all" || enriched.lane === state.filter;
    if (!laneMatch) return false;
    if (!query) return true;
    const haystack = [
      enriched.title,
      enriched.snippet,
      notification.repository?.full_name,
      notification.reason,
      enriched.reasonLabel
    ].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function countsByLane() {
  const counts = Object.fromEntries(lanes.map((lane) => [lane.id, 0]));
  counts.all = state.notifications.length;
  for (const notification of state.notifications) {
    counts[getEnriched(notification).lane] += 1;
  }
  return counts;
}

function render() {
  app.replaceChildren(state.token && state.user ? renderDashboard() : renderAuth());
  if (state.toast || state.error) {
    app.append(el("div", { class: "toast", role: "alert", text: state.toast || state.error }));
  }
}

function renderAuth() {
  const tokenInput = el("input", {
    id: "token",
    type: "password",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "ghp_...",
    value: state.token,
    oninput: (event) => {
      state.token = event.target.value.trim();
    },
    onkeydown: (event) => {
      if (event.key === "Enter") connect();
    }
  });

  const remember = el("input", {
    id: "remember",
    type: "checkbox",
    checked: state.remember ? "checked" : undefined,
    onchange: (event) => {
      state.remember = event.target.checked;
    }
  });

  return el("section", { class: "auth" }, [
    el("div", { class: "auth-header" }, [
      el("p", { class: "eyebrow", text: "GitHub notifications" }),
      el("h1", { class: "section-title", text: "Pingboard" })
    ]),
    el("div", { class: "auth-body" }, [
      el("div", { class: "callout" }, [
        icon("lock"),
        el("span", {
          html: "<strong>Use a classic token.</strong> Minimum scope is <code>notifications</code>. Add <code>repo</code> if private repositories should show full issue, PR, and comment context."
        })
      ]),
      el("div", { class: "token-field" }, [
        el("label", { for: "token", text: "GitHub token" }),
        tokenInput
      ]),
      el("label", { class: "check-row", for: "remember" }, [
        remember,
        el("span", { text: "Keep token after closing this tab" })
      ]),
      el("div", { class: "auth-actions" }, [
        button({
          className: "text-button",
          label: "Try demo data",
          iconName: "zap",
          text: "Demo",
          onClick: loadDemo
        }),
        button({
          className: "primary-button",
          label: "Connect",
          iconName: "bell",
          text: state.authLoading ? "Connecting" : "Connect",
          onClick: connect
        })
      ])
    ])
  ]);
}

function renderDashboard() {
  const rows = filteredNotifications();
  if (rows.length && !rows.some((row) => row.id === state.selectedId)) {
    state.selectedId = rows[0].id;
  }

  return el("div", { class: "frame" }, [
    renderTopbar(),
    el("section", { class: "grid" }, [
      renderSidebar(),
      renderList(rows),
      renderDetail(rows)
    ])
  ]);
}

function renderTopbar() {
  const avatar = state.user?.avatar_url
    ? el("img", { class: "avatar", src: state.user.avatar_url, alt: "" })
    : icon("user");

  const search = el("label", { class: "search" }, [
    icon("search"),
    el("input", {
      type: "search",
      placeholder: "Search repo, title, reason",
      value: state.query,
      oninput: (event) => {
        state.query = event.target.value;
        render();
      }
    })
  ]);

  const mode = el("div", { class: "segmented", role: "group", "aria-label": "Fetch mode" }, [
    button({
      className: "",
      label: "Unread",
      text: "Unread",
      pressed: !state.includeRead,
      onClick: () => {
        state.includeRead = false;
        fetchNotifications();
      }
    }),
    button({
      className: "",
      label: "All",
      text: "All",
      pressed: state.includeRead,
      onClick: () => {
        state.includeRead = true;
        fetchNotifications();
      }
    }),
    button({
      className: "",
      label: "Participating",
      text: "Mine",
      pressed: state.participating,
      onClick: () => {
        state.participating = !state.participating;
        fetchNotifications();
      }
    })
  ]);

  return el("header", { class: "topbar" }, [
    el("div", { class: "brand" }, [
      el("div", { class: "brand-mark" }, [icon("bell")]),
      el("div", {}, [
        el("h1", { text: "Pingboard" }),
        el("p", { text: `Signed in as ${state.user?.login || "GitHub"}` })
      ])
    ]),
    el("div", { class: "toolbar" }, [search, mode]),
    el("div", { class: "top-actions" }, [
      avatar,
      button({
        label: "Refresh",
        title: "Refresh",
        iconName: "refresh",
        onClick: fetchNotifications
      }),
      button({
        label: "Sign out",
        title: "Sign out",
        iconName: "logOut",
        onClick: signOut
      })
    ])
  ]);
}

function renderSidebar() {
  const counts = countsByLane();
  const unread = state.notifications.filter((item) => item.unread).length;
  const direct = state.notifications.filter((item) => getEnriched(item).lane === "direct").length;

  return el("aside", { class: "panel side" }, [
    el("div", { class: "side-header" }, [
      el("p", { class: "eyebrow", text: "Activity" }),
      el("h2", { class: "section-title", text: "Lanes" })
    ]),
    el("div", { class: "lane-list" }, lanes.map((lane) => (
      el("button", {
        class: "lane-button",
        type: "button",
        style: { "--lane-color": lane.color },
        "aria-pressed": String(state.filter === lane.id),
        onclick: () => {
          state.filter = lane.id;
          render();
        }
      }, [
        el("span", { class: "lane-dot" }, [icon(lane.icon)]),
        el("span", { class: "lane-copy" }, [
          el("span", { class: "lane-name", text: lane.name }),
          el("span", { class: "lane-hint", text: lane.hint })
        ]),
        el("span", { class: "count", text: String(counts[lane.id] || 0) })
      ])
    ))),
    el("div", { class: "stats" }, [
      el("div", { class: "stat" }, [
        el("strong", { text: String(unread) }),
        el("span", { text: "Unread" })
      ]),
      el("div", { class: "stat" }, [
        el("strong", { text: String(direct) }),
        el("span", { text: "Direct" })
      ])
    ])
  ]);
}

function renderList(rows) {
  return el("section", { class: "panel" }, [
    el("div", { class: "list-header" }, [
      el("div", {}, [
        el("p", { class: "eyebrow", text: lanes.find((lane) => lane.id === state.filter)?.name || "All" }),
        el("h2", { class: "section-title", text: state.loading ? "Loading activity" : "Notification stream" })
      ]),
      el("span", { class: "list-meta", text: `${rows.length} shown` })
    ]),
    state.loading && state.notifications.length === 0
      ? renderLoading()
      : rows.length
        ? el("div", { class: "notification-list" }, rows.map(renderNotification))
        : renderEmpty()
  ]);
}

function renderNotification(notification) {
  const enriched = getEnriched(notification);
  const lane = lanes.find((item) => item.id === enriched.lane) || lanes[0];
  const actor = enriched.actor;
  const actorNode = actor
    ? el("span", { class: "actor" }, [
      actor.avatar_url ? el("img", { class: "avatar", src: actor.avatar_url, alt: "" }) : icon("user"),
      el("span", { text: actor.login || actor.name || notification.repository?.owner?.login || "GitHub" })
    ])
    : el("span", { class: "actor" }, [icon("user"), el("span", { text: "GitHub" })]);

  return el("button", {
    class: "notification",
    type: "button",
    style: { "--lane-color": lane.color },
    "aria-selected": String(state.selectedId === notification.id),
    onclick: () => {
      state.selectedId = notification.id;
      render();
    }
  }, [
    el("span", { class: "notification-accent" }),
    el("span", { class: "notification-body" }, [
      el("span", { class: "notification-top" }, [
        el("span", { class: "repo", text: notification.repository?.full_name || "unknown repository" }),
        el("span", { class: "time", text: formatTime(notification.updated_at) })
      ]),
      el("span", { class: "title-row" }, [
        notification.unread ? el("span", { class: "unread-dot" }) : null,
        el("strong", { class: "title", text: enriched.title || notification.subject?.title || "Untitled thread" })
      ]),
      el("span", { class: "pill-row" }, [
        el("span", { class: "pill strong", text: enriched.reasonLabel }),
        ...(enriched.pills || []).slice(0, 3).map((pill) => el("span", { class: "pill", text: pill }))
      ]),
      enriched.snippet ? el("span", { class: "snippet", text: enriched.snippet }) : null,
      el("span", { class: "notification-bottom" }, [
        actorNode,
        el("span", { class: "time", text: notification.subject?.type || "" })
      ])
    ])
  ]);
}

function renderDetail(rows) {
  const notification = rows.find((row) => row.id === state.selectedId) || rows[0];
  if (!notification) {
    return el("aside", { class: "panel detail" }, [
      el("div", { class: "detail-header" }, [
        el("p", { class: "eyebrow", text: "Context" }),
        el("h2", { class: "detail-title", text: "No notification selected" })
      ]),
      renderEmpty()
    ]);
  }

  const enriched = getEnriched(notification);
  const lane = lanes.find((item) => item.id === enriched.lane) || lanes[0];
  const openedUrl = enriched.htmlUrl || notification.repository?.html_url || "";

  return el("aside", { class: "panel detail", style: { "--lane-color": lane.color } }, [
    el("div", { class: "detail-header" }, [
      el("p", { class: "eyebrow", text: enriched.reasonLabel }),
      el("h2", { class: "detail-title", text: enriched.title || notification.subject?.title || "Untitled thread" }),
      el("div", { class: "pill-row" }, [
        el("span", { class: "pill strong", text: lane.name }),
        el("span", { class: "pill", text: notification.reason }),
        el("span", { class: "pill", text: notification.subject?.type || "Thread" })
      ])
    ]),
    el("div", { class: "detail-content" }, [
      el("div", { class: "detail-actions" }, [
        button({
          className: "primary-button",
          label: "Open on GitHub",
          iconName: "external",
          text: "Open",
          onClick: () => openedUrl && window.open(openedUrl, "_blank", "noopener")
        }),
        button({
          className: "text-button",
          label: "Mark read",
          iconName: "check",
          text: "Read",
          onClick: () => markThread(notification.id, "read")
        }),
        button({
          className: "text-button",
          label: "Mark done",
          iconName: "inbox",
          text: "Done",
          onClick: () => markThread(notification.id, "done")
        }),
        button({
          className: "text-button",
          label: "Ignore",
          iconName: "eyeOff",
          text: "Ignore",
          onClick: () => ignoreThread(notification.id)
        })
      ]),
      el("div", { class: "context-block" }, [
        el("h3", { text: "Why this ping exists" }),
        el("p", { text: enriched.context || "GitHub did not return more context for this thread." })
      ]),
      el("div", { class: "meta-grid" }, [
        meta("Repository", notification.repository?.full_name || "unknown"),
        meta("Updated", new Date(notification.updated_at).toLocaleString()),
        meta("Thread", notification.subject?.type || "unknown"),
        meta("State", enriched.subject?.state || enriched.pull?.state || (notification.unread ? "unread" : "read"))
      ]),
      enriched.pull ? renderPullContext(enriched.pull) : null,
      enriched.latest || enriched.snippet ? el("div", { class: "context-block" }, [
        el("h3", { text: "Latest visible text" }),
        el("pre", { text: enriched.snippet || textFromMarkdown(enriched.latest?.body || "") || "No body text returned." })
      ]) : null
    ])
  ]);
}

function renderPullContext(pull) {
  const reviewers = (pull.requested_reviewers || []).map((user) => user.login).join(", ") || "none";
  const teams = (pull.requested_teams || []).map((team) => team.name || team.slug).join(", ") || "none";
  return el("div", { class: "context-block" }, [
    el("h3", { text: "Review request shape" }),
    el("p", { text: `Individual reviewers: ${reviewers}` }),
    el("p", { text: `Team reviewers: ${teams}` })
  ]);
}

function meta(label, value) {
  return el("div", { class: "meta-item" }, [
    el("span", { class: "meta-label", text: label }),
    el("span", { class: "meta-value", text: value })
  ]);
}

function renderEmpty() {
  return el("div", { class: "empty" }, [
    el("div", { class: "empty-inner" }, [
      el("div", { class: "large-icon" }, [icon("inbox")]),
      el("strong", { text: "Nothing in this lane" }),
      el("span", { text: "Change filters or refresh when GitHub has new activity." })
    ])
  ]);
}

function renderLoading() {
  return el("div", { class: "loading" }, [
    el("div", { class: "loading-inner" }, [
      el("div", { class: "spinner" }),
      el("span", { text: "Fetching GitHub activity" })
    ])
  ]);
}

async function connect() {
  if (!state.token) {
    state.toast = "Paste a GitHub token first.";
    render();
    clearToast();
    return;
  }

  state.authLoading = true;
  state.error = "";
  render();

  try {
    state.user = await github("/user");
    if (state.remember) {
      localStorage.setItem(STORAGE_KEY, state.token);
      sessionStorage.removeItem(SESSION_KEY);
    } else {
      sessionStorage.setItem(SESSION_KEY, state.token);
      localStorage.removeItem(STORAGE_KEY);
    }
    await fetchNotifications();
  } catch (error) {
    state.error = error.message;
  } finally {
    state.authLoading = false;
    render();
  }
}

function signOut() {
  state.token = "";
  state.demo = false;
  state.user = null;
  state.notifications = [];
  state.enriched = new Map();
  state.selectedId = null;
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(SESSION_KEY);
  render();
}

async function markThread(id, mode) {
  if (state.demo) {
    removeLocalThread(id, mode === "read" ? "Marked read in demo." : "Marked done in demo.");
    return;
  }

  try {
    if (mode === "read") {
      await github(`/notifications/threads/${id}`, { method: "PATCH" });
    } else {
      await github(`/notifications/threads/${id}`, { method: "DELETE" });
    }
    state.notifications = state.notifications.filter((item) => item.id !== id);
    state.enriched.delete(id);
    state.selectedId = state.notifications[0]?.id || null;
    state.toast = mode === "read" ? "Marked read." : "Marked done.";
    render();
    clearToast();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

async function ignoreThread(id) {
  if (state.demo) {
    removeLocalThread(id, "Thread ignored in demo.");
    return;
  }

  try {
    await github(`/notifications/threads/${id}/subscription`, {
      method: "PUT",
      body: JSON.stringify({ ignored: true }),
      headers: { "Content-Type": "application/json" }
    });
    state.notifications = state.notifications.filter((item) => item.id !== id);
    state.enriched.delete(id);
    state.selectedId = state.notifications[0]?.id || null;
    state.toast = "Thread ignored.";
    render();
    clearToast();
  } catch (error) {
    state.error = error.message;
    render();
  }
}

function clearToast() {
  window.setTimeout(() => {
    state.toast = "";
    state.error = "";
    render();
  }, 3200);
}

function removeLocalThread(id, message) {
  state.notifications = state.notifications.filter((item) => item.id !== id);
  state.enriched.delete(id);
  state.selectedId = state.notifications[0]?.id || null;
  state.toast = message;
  render();
  clearToast();
}

function loadDemo() {
  state.demo = true;
  state.token = "demo";
  state.user = {
    login: "mgoin",
    avatar_url: ""
  };

  const now = Date.now();
  state.notifications = [
    demoNotification("demo-1", "mention", "openai/pingboard", "Can you sanity check the prod alert copy?", "Issue", now - 8 * 60 * 1000),
    demoNotification("demo-2", "review_requested", "openai/runtime", "Refactor notification threading", "PullRequest", now - 42 * 60 * 1000),
    demoNotification("demo-3", "review_requested", "openai/codeowners-heavy", "Update CODEOWNERS routing for platform", "PullRequest", now - 2 * 60 * 60 * 1000),
    demoNotification("demo-4", "subscribed", "openai/docs", "Release notes discussion", "Discussion", now - 3 * 60 * 60 * 1000),
    demoNotification("demo-5", "ci_activity", "openai/service", "Deploy preview completed", "CheckSuite", now - 4 * 60 * 60 * 1000)
  ];

  state.enriched = new Map([
    ["demo-1", demoEnriched(0, "direct", "Direct mention", "The newest comment names you directly.", ["@", "mention"], "@mgoin can you check whether this alert title is too noisy?", "nora")],
    ["demo-2", {
      ...demoEnriched(1, "review", "Personal review", "You are individually listed as a requested reviewer.", ["personal review", "review_requested"], "This is waiting on your review before merge.", "sam"),
      pull: { requested_reviewers: [{ login: "mgoin" }], requested_teams: [] }
    }],
    ["demo-3", {
      ...demoEnriched(2, "ambient", "Team review", "A team review request is active: Platform. This often means CODEOWNERS or broad team routing.", ["team review", "possible CODEOWNERS", "review_requested"], "CODEOWNERS requested the Platform team, but you are not individually requested.", "github-actions"),
      pull: { requested_reviewers: [], requested_teams: [{ name: "Platform", slug: "platform" }] }
    }],
    ["demo-4", demoEnriched(3, "ambient", "Watching", "This is coming from repository watch settings or a broad subscription.", ["subscribed"], "A new comment landed on a watched discussion.", "ava")],
    ["demo-5", demoEnriched(4, "system", "CI activity", "A workflow run that you triggered completed.", ["ci activity"], "Deploy preview completed successfully.", "github-actions")]
  ]);
  state.selectedId = "demo-1";
  state.query = "";
  state.filter = "all";
  state.error = "";
  state.toast = "";
  render();
}

function demoNotification(id, reason, repo, title, type, updatedAt) {
  return {
    id,
    unread: id !== "demo-4",
    reason,
    updated_at: new Date(updatedAt).toISOString(),
    repository: {
      full_name: repo,
      html_url: "https://github.com/" + repo,
      owner: { login: repo.split("/")[0] }
    },
    subject: {
      title,
      type,
      url: "https://api.github.com/repos/" + repo + "/issues/1"
    }
  };
}

function demoEnriched(index, lane, reasonLabel, context, pills, snippet, actor) {
  const notification = state.notifications[index];
  return {
    notification,
    lane,
    reasonLabel,
    context,
    pills,
    title: notification.subject.title,
    snippet,
    actor: { login: actor, avatar_url: "" },
    htmlUrl: notification.repository.html_url
  };
}

async function boot() {
  render();
  if (state.token) {
    try {
      state.user = await github("/user");
      await fetchNotifications();
    } catch {
      signOut();
    }
  }
}

boot();
