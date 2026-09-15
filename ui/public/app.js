const logEl = document.getElementById('log');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const tooltipEl = document.getElementById('tooltip');
let tooltipTarget = null;
let latestStatus = null;
let intelligenceCacheCount = null;
let connectionsCacheCount = null;
let workspaceTab = 'activity';
const sourceReview = {
  page: 1,
  pages: 1,
  query: '',
  source: 'connections',
  timer: null,
};

function showWorkspaceTab(name, options = {}) {
  const selected = name === 'analytics' ? 'analytics' : 'activity';
  workspaceTab = selected;
  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    const active = button.dataset.workspaceTab === selected;
    button.setAttribute('aria-selected', active ? 'true' : 'false');
    button.tabIndex = active ? 0 : -1;
  });
  document.getElementById('workspace-activity').hidden = selected !== 'activity';
  document.getElementById('workspace-analytics').hidden = selected !== 'analytics';
  if (selected === 'analytics') {
    showAnalyticsTab(intelligence.tab);
  }
  if (options.updateHash) {
    window.history.replaceState(null, '', selected === 'analytics' ? '#analytics' : '#activity');
  }
}

function initWorkspaceTabs() {
  const analyticsCard = document.getElementById('step-insights');
  document.getElementById('analytics-mount').append(analyticsCard);

  document.querySelectorAll('[data-workspace-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      showWorkspaceTab(button.dataset.workspaceTab, { updateHash: true });
    });
    button.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        return;
      }
      event.preventDefault();
      const next = button.dataset.workspaceTab === 'activity' ? 'analytics' : 'activity';
      showWorkspaceTab(next, { updateHash: true });
      document.querySelector(`[data-workspace-tab="${next}"]`).focus();
    });
  });

  const legacyConversationHash = window.location.hash === '#step-intelligence';
  if (legacyConversationHash) {
    intelligence.tab = 'conversations';
  }
  const analyticsHash = ['#analytics', '#step-insights', '#step-intelligence'].includes(
    window.location.hash
  );
  showWorkspaceTab(analyticsHash ? 'analytics' : 'activity');
}

function positionTooltip(target) {
  const targetRect = target.getBoundingClientRect();
  const tooltipRect = tooltipEl.getBoundingClientRect();
  const gap = 10;
  const edge = 10;
  let top = targetRect.top - tooltipRect.height - gap;

  if (top < edge) {
    top = targetRect.bottom + gap;
  }
  top = Math.max(edge, Math.min(top, window.innerHeight - tooltipRect.height - edge));

  let left = targetRect.left + targetRect.width / 2 - tooltipRect.width / 2;
  left = Math.max(edge, Math.min(left, window.innerWidth - tooltipRect.width - edge));
  tooltipEl.style.top = `${Math.round(top)}px`;
  tooltipEl.style.left = `${Math.round(left)}px`;
}

function showTooltip(target) {
  const text = target && target.dataset.tooltip;
  if (!text) {
    return;
  }
  tooltipTarget = target;
  tooltipEl.textContent = text;
  tooltipEl.hidden = false;
  target.setAttribute('aria-describedby', 'tooltip');
  positionTooltip(target);
}

function hideTooltip(target) {
  if (target && tooltipTarget !== target) {
    return;
  }
  if (tooltipTarget && tooltipTarget.getAttribute('aria-describedby') === 'tooltip') {
    tooltipTarget.removeAttribute('aria-describedby');
  }
  tooltipTarget = null;
  tooltipEl.hidden = true;
}

document.addEventListener('pointerover', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target && !target.contains(event.relatedTarget)) {
    showTooltip(target);
  }
});

document.addEventListener('pointerout', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target && !target.contains(event.relatedTarget)) {
    hideTooltip(target);
  }
});

document.addEventListener('focusin', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target) {
    showTooltip(target);
  }
});

document.addEventListener('focusout', (event) => {
  const target = event.target.closest('[data-tooltip]');
  if (target) {
    hideTooltip(target);
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hideTooltip();
    document.getElementById('source-modal').hidden = true;
  }
});

window.addEventListener('scroll', () => hideTooltip(), true);
window.addEventListener('resize', () => hideTooltip());

const rememberEl = document.getElementById('remember');
const rememberStatusEl = document.getElementById('remember-status');
const passwordHintEl = document.getElementById('password-hint');
const REMEMBER_KEY = 'connection-cleaner.password';
const REMEMBER_DAYS = 30;

function readRemembered() {
  let raw;
  try {
    raw = window.localStorage.getItem(REMEMBER_KEY);
  } catch (err) {
    console.error(err.stack || err.message);
    return null;
  }
  if (!raw) {
    return null;
  }
  try {
    const entry = JSON.parse(raw);
    if (!entry || typeof entry.value !== 'string' || !entry.expiresAt) {
      forgetPassword();
      return null;
    }
    if (Date.now() >= entry.expiresAt) {
      forgetPassword();
      return null;
    }
    return entry;
  } catch (err) {
    console.error(err.stack || err.message);
    forgetPassword();
    return null;
  }
}

function rememberPassword(value) {
  if (!value) {
    return null;
  }
  const entry = {
    value,
    expiresAt: Date.now() + REMEMBER_DAYS * 24 * 60 * 60 * 1000,
  };
  try {
    window.localStorage.setItem(REMEMBER_KEY, JSON.stringify(entry));
  } catch (err) {
    console.error(err.stack || err.message);
    appendLog(`Could not save the password in this browser: ${err.message}`);
    return null;
  }
  return entry;
}

function forgetPassword() {
  try {
    window.localStorage.removeItem(REMEMBER_KEY);
  } catch (err) {
    console.error(err.stack || err.message);
  }
}

function renderRememberState(entry) {
  const active = Boolean(entry);
  rememberEl.checked = active;
  passwordHintEl.textContent = active ? '(remembered)' : '(this run only)';
  rememberStatusEl.hidden = !active;
  if (active) {
    const expires = new Date(entry.expiresAt);
    rememberStatusEl.textContent = `Stored in this browser until ${expires.toLocaleDateString()}.`;
  }
}

function restoreRememberedPassword() {
  const entry = readRemembered();
  if (entry) {
    passwordEl.value = entry.value;
  }
  renderRememberState(entry);
}

rememberEl.addEventListener('change', () => {
  if (!rememberEl.checked) {
    forgetPassword();
    renderRememberState(null);
    appendLog('Forgot the saved password in this browser.');
    return;
  }
  if (!passwordEl.value) {
    rememberEl.checked = false;
    appendLog('Enter your password first, then tick Remember for 30 days.');
    return;
  }
  renderRememberState(rememberPassword(passwordEl.value));
});

passwordEl.addEventListener('change', () => {
  if (!rememberEl.checked) {
    return;
  }
  if (!passwordEl.value) {
    forgetPassword();
    renderRememberState(null);
    return;
  }
  renderRememberState(rememberPassword(passwordEl.value));
});

function password() {
  return passwordEl.value;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status})`);
  }
  return data;
}

const intelligence = {
  page: 1,
  limit: 40,
  timeline: 'month',
  requestId: 0,
  debounce: null,
  tab: 'connections',
};

const connectionsAnalytics = {
  timeline: 'month',
  requestId: 0,
  debounce: null,
};

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

function formatActivity(value) {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
}

function safeProfileUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && /(^|\.)linkedin\.com$/i.test(url.hostname)
      ? url.href
      : '';
  } catch (err) {
    console.error(err.stack || err.message);
    return '';
  }
}

function intelligenceParams(includePage = false) {
  const params = new URLSearchParams();
  const values = {
    q: document.getElementById('intel-q').value,
    status: document.getElementById('intel-status').value,
    from: document.getElementById('intel-from').value,
    to: document.getElementById('intel-to').value,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  const kind = document.getElementById('intel-kind').value;
  const kindParams = {
    unrequited: ['unrequited', 'true'],
    disconnected: ['disconnected', 'true'],
    protected: ['protected', 'true'],
    examined: ['examined', 'true'],
    listed: ['examined', 'false'],
    connected: ['connected', 'true'],
    unlinked: ['connected', 'false'],
  };
  if (kindParams[kind]) params.set(kindParams[kind][0], kindParams[kind][1]);
  if (includePage) {
    params.set('page', intelligence.page);
    params.set('limit', intelligence.limit);
  }
  return params;
}

function createKpi(label, value, note, color) {
  const card = document.createElement('div');
  card.className = 'intel-kpi';
  card.style.setProperty('--kpi-glow', color);
  card.append(
    textElement('span', '', label),
    textElement('strong', '', value),
    textElement('small', '', note)
  );
  return card;
}

function renderIntelligenceKpis(summary) {
  const el = document.getElementById('intel-kpis');
  const coverage = summary.total ? Math.round((summary.examined / summary.total) * 100) : 0;
  const range = summary.oldestActivity && summary.newestActivity
    ? `${formatActivity(summary.oldestActivity)} → ${formatActivity(summary.newestActivity)}`
    : 'No readable activity dates';
  el.replaceChildren(
    createKpi('Conversations', formatCount(summary.total), `${formatCount(summary.dated)} dated`, 'rgba(75,181,247,.12)'),
    createKpi('Unrequited', formatCount(summary.unrequited), 'Inbound, no reply', 'rgba(255,200,107,.13)'),
    createKpi('Replied', formatCount(summary.replied), 'Two-way threads', 'rgba(98,215,162,.12)'),
    createKpi('Examined', `${coverage}%`, `${formatCount(summary.listedOnly)} listed only`, 'rgba(154,126,255,.12)'),
    createKpi('Activity range', formatCount(summary.dated), range, 'rgba(75,181,247,.1)')
  );
}

function renderTimelineChart(containerId, data, options = {}) {
  const container = document.getElementById(containerId);
  const yearMode = Boolean(options.yearMode);
  const unit = options.unit || 'items';
  container.replaceChildren();
  if (!data.length) {
    container.append(textElement('p', 'empty-state', 'No readable dates in this selection.'));
    return;
  }

  const width = 620;
  const height = 205;
  const pad = { top: 12, right: 10, bottom: 27, left: 10 };
  const max = Math.max(...data.map((item) => item.count), 1);
  const x = (index) => pad.left + (index / Math.max(1, data.length - 1)) * (width - pad.left - pad.right);
  const y = (count) => pad.top + (1 - count / max) * (height - pad.top - pad.bottom);
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const defs = document.createElementNS(ns, 'defs');
  const gradient = document.createElementNS(ns, 'linearGradient');
  const gradientId = `${containerId}-fill`;
  gradient.id = gradientId;
  gradient.setAttribute('x1', '0');
  gradient.setAttribute('y1', '0');
  gradient.setAttribute('x2', '0');
  gradient.setAttribute('y2', '1');
  [['0%', '.28'], ['100%', '0']].forEach(([offset, opacity]) => {
    const stop = document.createElementNS(ns, 'stop');
    stop.setAttribute('offset', offset);
    stop.setAttribute('stop-color', '#4bb5f7');
    stop.setAttribute('stop-opacity', opacity);
    gradient.append(stop);
  });
  defs.append(gradient);
  svg.append(defs);
  [0, .5, 1].forEach((ratio) => {
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', pad.left);
    line.setAttribute('x2', width - pad.right);
    line.setAttribute('y1', y(max * ratio));
    line.setAttribute('y2', y(max * ratio));
    line.setAttribute('class', 'chart-grid');
    svg.append(line);
  });
  const points = data.map((item, index) => `${x(index)},${y(item.count)}`).join(' ');
  const area = document.createElementNS(ns, 'path');
  area.setAttribute('class', 'chart-area');
  area.setAttribute('d', `M ${x(0)} ${height - pad.bottom} L ${points.replace(/ /g, ' L ')} L ${x(data.length - 1)} ${height - pad.bottom} Z`);
  area.setAttribute('fill', `url(#${gradientId})`);
  const line = document.createElementNS(ns, 'polyline');
  line.setAttribute('class', 'chart-line');
  line.setAttribute('points', points);
  svg.append(area, line);
  const labelEvery = Math.max(1, Math.ceil(data.length / 6));
  data.forEach((item, index) => {
    if (index % labelEvery === 0 || index === data.length - 1) {
      const label = document.createElementNS(ns, 'text');
      label.setAttribute('class', 'axis-label');
      label.setAttribute('x', x(index));
      label.setAttribute('y', height - 6);
      label.setAttribute('text-anchor', index === 0 ? 'start' : index === data.length - 1 ? 'end' : 'middle');
      label.textContent = item.label;
      svg.append(label);
    }
    if (data.length <= 24 || index % labelEvery === 0) {
      const dot = document.createElementNS(ns, 'circle');
      dot.setAttribute('class', 'chart-dot');
      dot.setAttribute('cx', x(index));
      dot.setAttribute('cy', y(item.count));
      dot.setAttribute('r', '3');
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${item.label}: ${formatCount(item.count)} ${unit}`;
      dot.append(title);
      svg.append(dot);
    }
  });
  container.append(svg);
}

function renderTimeline(analytics) {
  const data = intelligence.timeline === 'year'
    ? analytics.charts.activityByYear
    : analytics.charts.activityByMonth;
  renderTimelineChart('activity-chart', data, {
    yearMode: intelligence.timeline === 'year',
    unit: 'conversations',
  });
}

function renderDonut(containerId, items, total, centerLabel = 'threads') {
  const el = document.getElementById(containerId);
  const colors = ['#55bcfb', '#62d7a2', '#ffc86b', '#a78bfa', '#ff707b', '#667085'];
  let cursor = 0;
  const stops = items.map((item, index) => {
    const start = cursor;
    cursor += total ? (item.count / total) * 100 : 0;
    return `${colors[index % colors.length]} ${start}% ${cursor}%`;
  });
  const donut = document.createElement('div');
  donut.className = 'donut';
  donut.style.setProperty('--donut', stops.join(',') || '#192131 0 100%');
  const center = document.createElement('div');
  center.className = 'donut-center';
  center.append(textElement('strong', '', formatCount(total)), textElement('span', '', centerLabel));
  donut.append(center);
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  items.slice(0, 6).forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'legend-row';
    const dot = document.createElement('i');
    dot.style.setProperty('--color', colors[index % colors.length]);
    row.append(dot, textElement('span', '', item.label), textElement('b', '', formatCount(item.count)));
    legend.append(row);
  });
  el.replaceChildren(donut, legend);
}

function renderRankChart(containerId, items) {
  const el = document.getElementById(containerId);
  const max = Math.max(...items.map((item) => item.count), 1);
  el.replaceChildren();
  items.slice(0, 7).forEach((item) => {
    const row = document.createElement('div');
    row.className = 'rank-row';
    const track = document.createElement('div');
    track.className = 'rank-track';
    const bar = document.createElement('i');
    bar.style.setProperty('--width', `${(item.count / max) * 100}%`);
    track.append(bar);
    row.append(textElement('span', '', item.label), track, textElement('b', '', formatCount(item.count)));
    el.append(row);
  });
}

function renderCoverage(summary) {
  const el = document.getElementById('coverage-chart');
  const items = [
    ['Threads examined', summary.examined, '#62d7a2'],
    ['Profiles linked', summary.profileLinked, '#55bcfb'],
    ['Activity date readable', summary.dated, '#a78bfa'],
    ['Protected titles', summary.protectedTitles, '#ffc86b'],
  ];
  el.replaceChildren();
  items.forEach(([label, count, color]) => {
    const pct = summary.total ? Math.round((count / summary.total) * 100) : 0;
    const item = document.createElement('div');
    item.className = 'coverage-item';
    const copy = document.createElement('div');
    copy.className = 'coverage-copy';
    copy.append(textElement('span', '', label), textElement('strong', '', `${pct}% · ${formatCount(count)}`));
    const track = document.createElement('div');
    track.className = 'coverage-track';
    const bar = document.createElement('i');
    bar.style.setProperty('--width', `${pct}%`);
    bar.style.setProperty('--color', color);
    track.append(bar);
    item.append(copy, track);
    el.append(item);
  });
}

function renderConversationList(payload) {
  const el = document.getElementById('conversation-list');
  el.replaceChildren();
  payload.rows.forEach((row) => {
    const profileUrl = safeProfileUrl(row.profileUrl);
    const item = document.createElement(profileUrl ? 'a' : 'div');
    item.className = 'conversation-row';
    if (profileUrl) {
      item.href = profileUrl;
      item.target = '_blank';
      item.rel = 'noopener';
    }
    const person = document.createElement('div');
    person.className = 'conversation-person';
    person.append(
      textElement('strong', '', row.name || 'Unnamed conversation'),
      textElement('span', '', row.profileLinked ? 'LinkedIn profile available' : 'No linked profile')
    );
    const title = document.createElement('div');
    title.className = 'conversation-title';
    title.append(
      textElement('span', '', row.title || 'Title unavailable'),
      textElement('small', '', row.protectedTitle ? 'Protected title match' : 'Standard title')
    );
    const message = document.createElement('div');
    message.className = 'conversation-message';
    message.append(
      textElement('p', '', row.snippet || 'No cached snippet'),
      textElement('small', '', `Last activity · ${formatActivity(row.lastActivityIso || row.lastActivity)}`)
    );
    const state = document.createElement('div');
    state.className = 'conversation-state';
    state.append(
      textElement('span', `status-chip ${row.status}`, row.unrequited ? 'unrequited' : row.status),
      textElement(
        'span',
        'conversation-flags',
        [
          row.disconnected ? 'Disconnected' : null,
          row.examined ? 'Examined' : 'Listed only',
        ].filter(Boolean).join(' · ')
      )
    );
    item.append(person, title, message, state);
    el.append(item);
  });
  const pagination = payload.pagination;
  document.getElementById('explorer-count').textContent = `${formatCount(pagination.total)} conversation${pagination.total === 1 ? '' : 's'}`;
  document.getElementById('explorer-page').textContent = `Page ${pagination.page} of ${pagination.pageCount}`;
  document.getElementById('explorer-prev').disabled = pagination.page <= 1;
  document.getElementById('explorer-next').disabled = pagination.page >= pagination.pageCount;
}

function renderIntelligence(analytics, conversations) {
  const empty = document.getElementById('intel-empty');
  const content = document.getElementById('intel-content');
  const hasAnyCache = latestStatus && Number(latestStatus.conversationCount) > 0;
  if (analytics.summary.total === 0) {
    empty.querySelector('h3').textContent = hasAnyCache
      ? 'No conversations match these filters'
      : 'No cached conversations yet';
    empty.querySelector('p').textContent = hasAnyCache
      ? 'Try a broader search, date range, or status.'
      : 'Run “Cache conversation list” above. This panel will populate from your private local CSV.';
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  document.getElementById('intel-result-title').textContent =
    intelligenceParams().toString() ? 'Filtered conversation view' : 'Conversation overview';
  const cacheBadge = document.getElementById('intel-cache-badge');
  cacheBadge.textContent = analytics.summary.cacheComplete ? 'Full list cached' : 'Partial cache · insights still live';
  cacheBadge.classList.toggle('complete', analytics.summary.cacheComplete);
  renderIntelligenceKpis(analytics.summary);
  renderTimeline(analytics);
  renderDonut('status-chart', analytics.charts.statuses, analytics.summary.total, 'threads');
  renderRankChart('title-chart', analytics.charts.titleBuckets);
  renderCoverage(analytics.summary);
  renderConversationList(conversations);
}

async function loadIntelligence() {
  const requestId = ++intelligence.requestId;
  const error = document.getElementById('intel-error');
  error.hidden = true;
  try {
    const analyticsQuery = intelligenceParams();
    const listQuery = intelligenceParams(true);
    const [analyticsResponse, conversationsResponse] = await Promise.all([
      fetch(`/api/inbox/analytics?${analyticsQuery}`),
      fetch(`/api/inbox/conversations?${listQuery}`),
    ]);
    if (!analyticsResponse.ok || !conversationsResponse.ok) {
      throw new Error(`Conversation data request failed (${analyticsResponse.status}/${conversationsResponse.status})`);
    }
    const [analytics, conversations] = await Promise.all([
      analyticsResponse.json(),
      conversationsResponse.json(),
    ]);
    if (requestId !== intelligence.requestId) return;
    intelligence.page = conversations.pagination.page;
    renderIntelligence(analytics, conversations);
  } catch (err) {
    console.error(err.stack || err.message);
    if (requestId !== intelligence.requestId) return;
    error.textContent = 'Conversation intelligence could not be loaded. Check the technical log and try again.';
    error.hidden = false;
  }
}

function scheduleIntelligenceLoad() {
  window.clearTimeout(intelligence.debounce);
  intelligence.debounce = window.setTimeout(() => {
    intelligence.page = 1;
    loadIntelligence();
  }, 180);
}

['intel-q', 'intel-status', 'intel-from', 'intel-to', 'intel-kind'].forEach((id) => {
  const input = document.getElementById(id);
  input.addEventListener(input.tagName === 'INPUT' && input.type === 'search' ? 'input' : 'change', scheduleIntelligenceLoad);
});
document.getElementById('intel-reset').addEventListener('click', () => {
  ['intel-q', 'intel-status', 'intel-from', 'intel-to', 'intel-kind'].forEach((id) => {
    document.getElementById(id).value = '';
  });
  intelligence.page = 1;
  loadIntelligence();
});
document.getElementById('explorer-prev').addEventListener('click', () => {
  intelligence.page -= 1;
  loadIntelligence();
});
document.getElementById('explorer-next').addEventListener('click', () => {
  intelligence.page += 1;
  loadIntelligence();
});
document.querySelectorAll('[data-timeline]').forEach((button) => {
  button.addEventListener('click', () => {
    intelligence.timeline = button.dataset.timeline;
    document.querySelectorAll('[data-timeline]').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    loadIntelligence();
  });
});

function connectionParams() {
  const params = new URLSearchParams();
  const from = document.getElementById('conn-from').value;
  const to = document.getElementById('conn-to').value;
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  return params;
}

function renderConnectionKpis(summary) {
  const el = document.getElementById('conn-kpis');
  const peak = summary.peakMonth
    ? `${summary.peakMonth.label} · ${formatCount(summary.peakMonth.count)}`
    : 'No dated peak';
  el.replaceChildren(
    createKpi('In range', formatCount(summary.matched ?? summary.total), `${formatCount(summary.sourceTotal || summary.total)} in CSV`, 'rgba(75,181,247,.12)'),
    createKpi('Still connected', formatCount(summary.connected), `${formatCount(summary.disconnected)} disconnected`, 'rgba(98,215,162,.12)'),
    createKpi('Dated', formatCount(summary.dated), `${summary.datedPct || 0}% of connected`, 'rgba(154,126,255,.12)'),
    createKpi('Last 12 months', formatCount(summary.last365Days), `${formatCount(summary.last30Days)} in 30 days`, 'rgba(255,200,107,.13)'),
    createKpi('Peak month', formatCount(summary.peakMonth ? summary.peakMonth.count : 0), peak, 'rgba(75,181,247,.1)')
  );
}

function renderConnectionsAnalytics(analytics) {
  const empty = document.getElementById('conn-empty');
  const content = document.getElementById('conn-content');
  const hasAny = latestStatus && Number(latestStatus.connectionsCount) > 0;
  if (!analytics.summary.total) {
    empty.querySelector('h3').textContent = hasAny
      ? 'No connections in this date range'
      : 'No connections yet';
    empty.querySelector('p').textContent = hasAny
      ? 'Widen the connected-on dates, or reset the filter.'
      : 'Download your connections first. This tab charts when people were added to your network.';
    empty.hidden = false;
    content.hidden = true;
    return;
  }
  empty.hidden = true;
  content.hidden = false;
  const filtered = Boolean(document.getElementById('conn-from').value || document.getElementById('conn-to').value);
  document.getElementById('conn-result-title').textContent = filtered
    ? 'Filtered connection view'
    : 'Connection overview';
  const badge = document.getElementById('conn-range-badge');
  badge.textContent = filtered
    ? `${formatCount(analytics.summary.matched)} of ${formatCount(analytics.summary.sourceTotal)}`
    : 'All dates';
  badge.classList.toggle('complete', !filtered);
  renderConnectionKpis(analytics.summary);
  const timelineData = connectionsAnalytics.timeline === 'year'
    ? analytics.charts.activityByYear
    : analytics.charts.timeline;
  renderTimelineChart('conn-activity-chart', timelineData, {
    yearMode: connectionsAnalytics.timeline === 'year',
    unit: 'connections',
  });
  renderDonut('conn-role-chart', analytics.charts.roles, analytics.summary.connected, 'roles');
  renderRankChart('conn-seniority-chart', analytics.charts.seniority);
  renderRankChart('conn-company-chart', analytics.charts.companies);
}

async function loadConnectionsAnalytics() {
  const requestId = ++connectionsAnalytics.requestId;
  const error = document.getElementById('conn-error');
  error.hidden = true;
  try {
    const response = await fetch(`/api/connections/analytics?${connectionParams()}`);
    if (!response.ok) {
      throw new Error(`Connection analytics request failed (${response.status})`);
    }
    const analytics = await response.json();
    if (requestId !== connectionsAnalytics.requestId) return;
    renderConnectionsAnalytics(analytics);
  } catch (err) {
    console.error(err.stack || err.message);
    if (requestId !== connectionsAnalytics.requestId) return;
    error.textContent = 'Connection analytics could not be loaded. Check the technical log and try again.';
    error.hidden = false;
  }
}

function scheduleConnectionsLoad() {
  window.clearTimeout(connectionsAnalytics.debounce);
  connectionsAnalytics.debounce = window.setTimeout(() => {
    loadConnectionsAnalytics();
  }, 180);
}

function showAnalyticsTab(name) {
  intelligence.tab = name;
  document.querySelectorAll('[data-analytics-tab]').forEach((button) => {
    const selected = button.dataset.analyticsTab === name;
    button.setAttribute('aria-selected', selected ? 'true' : 'false');
  });
  document.getElementById('panel-connections').hidden = name !== 'connections';
  document.getElementById('panel-conversations').hidden = name !== 'conversations';
  if (name === 'conversations') {
    loadIntelligence();
  } else {
    loadConnectionsAnalytics();
  }
}

['conn-from', 'conn-to'].forEach((id) => {
  document.getElementById(id).addEventListener('change', scheduleConnectionsLoad);
});
document.getElementById('conn-reset').addEventListener('click', () => {
  document.getElementById('conn-from').value = '';
  document.getElementById('conn-to').value = '';
  loadConnectionsAnalytics();
});
document.querySelectorAll('[data-conn-timeline]').forEach((button) => {
  button.addEventListener('click', () => {
    connectionsAnalytics.timeline = button.dataset.connTimeline;
    document.querySelectorAll('[data-conn-timeline]').forEach((item) => {
      item.classList.toggle('active', item === button);
    });
    loadConnectionsAnalytics();
  });
});
document.querySelectorAll('[data-analytics-tab]').forEach((button) => {
  button.addEventListener('click', () => showAnalyticsTab(button.dataset.analyticsTab));
});
document.getElementById('open-unrequited').addEventListener('click', openUnrequitedCandidates);
document.getElementById('success-review').addEventListener('click', () => {
  hideSuccessModal();
  openUnrequitedCandidates();
});

function appendLog(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setAnalyticsRunning(running) {
  const btn = document.getElementById('start-analytics');
  const hint = document.getElementById('analytics-status');
  btn.classList.toggle('busy', running);
  btn.textContent = running ? 'Exporting…' : 'Export HTML report';
  hint.hidden = !running;
}

function setInboxScanRunning(running, kind = 'scan') {
  const scanBtn = document.getElementById('start-inbox-scan');
  const cacheBtn = document.getElementById('start-inbox-cache');
  const hint = document.getElementById('inbox-status');
  scanBtn.classList.toggle('busy', running && kind === 'scan');
  cacheBtn.classList.toggle('busy', running && kind === 'cache');
  scanBtn.textContent = running && kind === 'scan' ? 'Searching…' : 'Search for unrequited love';
  cacheBtn.textContent =
    running && kind === 'cache'
      ? 'Caching…'
      : latestStatus && latestStatus.inboxCacheResumable
        ? 'Resume conversation cache'
        : 'Cache conversation list';
  hint.hidden = !running;
  if (running && kind === 'cache') {
    hint.textContent =
      latestStatus && latestStatus.inboxCacheResumable
        ? 'Resuming from the last saved inbox page. Use Stop / pause for now to keep progress.'
        : 'Paging through the inbox list. Use Stop / pause for now to keep progress.';
  } else if (running) {
    hint.textContent =
      'Checking the latest messages, then opening only conversations that still need a read.';
  }
}

function formatDuration(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function formatTime(value) {
  if (!value) {
    return '';
  }
  return new Date(value).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function textElement(tag, className, text) {
  const el = document.createElement(tag);
  if (className) {
    el.className = className;
  }
  el.textContent = text;
  return el;
}

function jobBodyFragment(job) {
  const elapsed = Date.now() - new Date(job.startedAt).getTime();
  const wrap = document.createDocumentFragment();
  wrap.append(
    textElement('div', 'job-name', job.label || job.name),
    textElement('p', 'job-detail', job.detail || ''),
    textElement('p', 'job-stage', job.statusLine || 'Starting…'),
    textElement(
      'p',
      'job-meta',
      `Started ${formatTime(job.startedAt)} · running for ${formatDuration(elapsed)}`
    )
  );
  return wrap;
}

function setModalsScrollLock() {
  const jobOpen = !document.getElementById('job-modal').hidden;
  const successOpen = !document.getElementById('success-modal').hidden;
  document.body.style.overflow = jobOpen || successOpen ? 'hidden' : '';
}

function showRunningModal(job) {
  const modal = document.getElementById('job-modal');
  const body = document.getElementById('job-modal-body');
  const pill = document.getElementById('job-modal-pill');
  body.replaceChildren(jobBodyFragment(job));
  pill.className = 'status-pill running';
  pill.textContent =
    job.state === 'pausing' || job.state === 'cancelling' || job.state === 'stopping'
      ? 'Pausing'
      : 'Running';
  modal.hidden = false;
  setModalsScrollLock();
}

function hideRunningModal() {
  document.getElementById('job-modal').hidden = true;
  setModalsScrollLock();
}

function parseDownloadSummaryFromLog(text) {
  const rows = [];
  const saved = text.match(/Saved in CSV:\s+([0-9,]+)/i);
  const added = text.match(/New this run:\s+([0-9,]+)/i);
  const window = text.match(/Date window:\s+(.+)/i);
  const output = text.match(/Output file:\s+(.+)/i);
  if (saved) rows.push({ label: 'Saved in CSV', value: `${saved[1]} connections` });
  if (added) rows.push({ label: 'New this run', value: `${added[1]} connections` });
  if (window) rows.push({ label: 'Date window', value: window[1].trim() });
  if (output) rows.push({ label: 'Output file', value: output[1].trim() });
  if (/Finished the last-/.test(text)) {
    rows.push({ label: 'Result', value: 'Reached the date window cutoff' });
  } else if (/All connections have been downloaded/.test(text)) {
    rows.push({ label: 'Result', value: 'Full connections list downloaded' });
  }
  return rows;
}

function showResultModal(completed, status) {
  const modal = document.getElementById('success-modal');
  const title = document.getElementById('success-title');
  const detail = document.getElementById('success-detail');
  const pill = document.getElementById('success-pill');
  const list = document.getElementById('success-stats');
  const stack = document.getElementById('success-stack');
  const summary = completed.summary || { rows: [] };
  const failed = completed.outcome === 'failed';
  const paused = completed.outcome === 'paused' || completed.outcome === 'cancelled';
  const isDownload = completed.name === 'download';
  const isInboxScan = completed.name === 'inbox-scan' || completed.name === 'inbox-cache';
  let rows = [...(summary.rows || [])];
  if (isDownload && !failed && rows.length === 0) {
    rows = parseDownloadSummaryFromLog(logEl.textContent || '');
  }

  const label = completed.label || completed.name;
  if (failed) {
    title.textContent = `${label} failed`;
  } else if (paused && completed.name === 'inbox-cache') {
    title.textContent = 'Conversation cache paused';
  } else if (paused) {
    title.textContent = `${label} paused`;
  } else if (isDownload) {
    title.textContent = 'Download complete';
  } else if (completed.name === 'inbox-cache') {
    title.textContent = 'Conversation cache complete';
  } else if (isInboxScan) {
    title.textContent = 'Unrequited love search complete';
  } else {
    title.textContent = `${label} complete`;
  }
  detail.textContent = completed.detail || '';
  pill.className = `status-pill ${failed ? 'failed' : paused ? 'paused' : 'succeeded'}`;
  pill.textContent = failed ? 'Failed' : paused ? 'Paused' : 'Succeeded';

  const trace = Array.isArray(completed.errorStack) ? completed.errorStack : [];
  if (failed && trace.length) {
    stack.textContent = trace.join('\n');
    stack.hidden = false;
  } else {
    stack.textContent = '';
    stack.hidden = true;
  }

  list.replaceChildren();
  rows.push({
    label: 'Duration',
    value: formatDuration(completed.durationMs),
  });
  if (failed && !completed.errorMessage) {
    rows.push({
      label: 'Exit code',
      value: `${completed.exitCode}${completed.signal ? ` (${completed.signal})` : ''}`,
    });
  }
  if (failed) {
    rows.push({ label: 'Next step', value: 'The full output is in the Log panel below.' });
  }
  if (!failed && isDownload && status && status.connectionsCount != null) {
    rows.push({
      label: 'connections.csv now',
      value: Number(status.connectionsCount).toLocaleString(),
    });
  }
  if (!failed && isInboxScan && status && status.unrequitedCount != null) {
    rows.push({
      label: 'unrequited-love.csv now',
      value: `${Number(status.unrequitedCount).toLocaleString()} candidates`,
    });
  }
  for (const row of rows) {
    const item = document.createElement('div');
    item.append(
      textElement('dt', '', row.label),
      textElement('dd', '', row.value)
    );
    list.append(item);
  }

  document.getElementById('success-review').hidden = failed || !isInboxScan;

  hideRunningModal();
  modal.hidden = false;
  setModalsScrollLock();
}

function hideSuccessModal() {
  document.getElementById('success-modal').hidden = true;
  setModalsScrollLock();
}

function renderJobs(status) {
  const currentEl = document.getElementById('current-job');
  const historyEl = document.getElementById('job-history');
  const summaryEl = document.getElementById('jobs-summary');
  const job = status.job;
  const history = Array.isArray(status.history) ? status.history : [];

  currentEl.replaceChildren();
  if (job) {
    currentEl.append(
      textElement('p', 'empty-state', 'Progress is shown in the window above.')
    );
    summaryEl.className = 'status-pill running';
    summaryEl.textContent =
      job.state === 'pausing' || job.state === 'cancelling' || job.state === 'stopping'
        ? 'Pausing'
        : 'Running';
    showRunningModal(job);
  } else {
    currentEl.append(textElement('p', 'empty-state', 'No job is running.'));
    const latest = history[0];
    summaryEl.className = `status-pill ${latest ? latest.outcome : 'idle'}`;
    summaryEl.textContent = latest ? latest.outcome : 'Idle';
    hideRunningModal();
  }

  historyEl.replaceChildren();
  if (!history.length) {
    historyEl.append(
      textElement('li', 'empty-state', 'No completed jobs in this session.')
    );
    return;
  }
  for (const item of history) {
    const row = document.createElement('li');
    row.append(
      textElement('span', 'job-name', item.label || item.name),
      textElement(
        'span',
        `status-pill ${item.outcome}`,
        item.outcome || 'finished'
      ),
      textElement('span', 'job-detail', item.detail || ''),
      textElement(
        'span',
        'job-stage',
        item.errorMessage ||
          item.statusLine ||
          `Process exited with code ${item.exitCode}`
      ),
      textElement(
        'span',
        'job-meta',
        `${formatTime(item.startedAt)}–${formatTime(item.endedAt)} · ${formatDuration(item.durationMs)}`
      )
    );
    historyEl.append(row);
  }
}

const jobStep = {
  download: 'download',
  analytics: 'insights',
  'inbox-scan': 'inbox',
  'inbox-cache': 'inbox',
  'remove-dry-run': 'remove',
  'remove-execute': 'remove',
};

function setStepState(name, state) {
  const card = document.querySelector(`[data-step="${name}"]`);
  const link = document.querySelector(`[data-step-link="${name}"]`);
  if (!card) {
    return;
  }
  card.classList.toggle('locked', state === 'locked');
  card.classList.toggle('current', state === 'current');
  card.classList.toggle('complete', state === 'complete');
  if (link) {
    link.classList.toggle('current', state === 'current');
    link.classList.toggle('complete', state === 'complete');
    link.setAttribute('aria-disabled', state === 'locked' ? 'true' : 'false');
  }
  const stateEl = card.querySelector('.step-state');
  stateEl.textContent = {
    locked: 'Locked',
    current: 'Current step',
    complete: 'Complete',
    available: 'Available',
  }[state];
}

function setReviewFileState(id, available) {
  const link = document.getElementById(id);
  if (!link) {
    return;
  }
  link.closest('.review-file').classList.toggle('unavailable', !available);
  link.setAttribute('aria-disabled', available ? 'false' : 'true');
  if (link.tagName === 'BUTTON') {
    link.disabled = !available;
  }
}

function openUnrequitedCandidates() {
  document.getElementById('intel-kind').value = 'unrequited';
  intelligence.page = 1;
  // showWorkspaceTab loads whichever analytics tab this names, so setting it
  // first keeps the explorer to a single fetch.
  intelligence.tab = 'conversations';
  showWorkspaceTab('analytics', { updateHash: true });
  document.getElementById('step-insights').scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

function selectedSourceAvailable(status) {
  const source = document.getElementById('csv-source').value;
  if (source === 'sales') {
    return Number(status.salesCount) > 0;
  }
  if (source === 'unrequited') {
    return Number(status.conversationCount) > 0;
  }
  return Number(status.connectionsCount) > 0;
}

function syncUnrequitedRemoveOptions() {
  const unrequited = document.getElementById('csv-source').value === 'unrequited';
  document.querySelectorAll('.unrequited-remove-option').forEach((el) => {
    el.hidden = !unrequited;
  });
}

function renderJourney(status) {
  const busy = Boolean(status.job);
  const hasEmail = Boolean(status.email);
  const hasConnections = Number(status.connectionsCount) > 0;
  const hasCacheComplete = Boolean(status.inboxCacheComplete);
  const hasInbox = hasCacheComplete || Number(status.conversationCount) > 0;
  const hasInsights = hasConnections || hasInbox;
  const hasDryRun = (status.history || []).some(
    (job) => job.name === 'remove-dry-run' && job.outcome === 'succeeded'
  );

  const states = {
    setup: hasEmail ? 'complete' : 'current',
    download: !hasEmail ? 'locked' : hasConnections ? 'complete' : 'current',
    insights: !hasConnections ? 'locked' : hasInsights ? 'complete' : 'available',
    inbox: !hasConnections ? 'locked' : hasCacheComplete ? 'complete' : 'current',
    review: !hasConnections ? 'locked' : hasDryRun ? 'complete' : hasInbox ? 'current' : 'available',
    remove: !hasConnections ? 'locked' : hasDryRun ? 'current' : 'available',
  };
  if (status.job && jobStep[status.job.name]) {
    const activeStep = jobStep[status.job.name];
    for (const name of Object.keys(states)) {
      if (name === activeStep) {
        states[name] = 'current';
      } else if (states[name] === 'current') {
        states[name] = 'available';
      }
    }
  }
  for (const [name, state] of Object.entries(states)) {
    setStepState(name, state);
  }

  document.getElementById('start-download').disabled = busy || !hasEmail;
  document.getElementById('start-analytics').disabled = busy || !hasConnections;
  const scanBtn = document.getElementById('start-inbox-scan');
  scanBtn.disabled = busy || !hasConnections || !hasCacheComplete;
  scanBtn.dataset.tooltip = hasCacheComplete
    ? 'Open only conversations that are new, changed, or unread.'
    : 'Cache the conversation list first. Search stays locked until that pass reaches the oldest conversation.';
  document.getElementById('start-inbox-cache').disabled = busy || !hasConnections;
  const sourceAvailable = selectedSourceAvailable(status);
  document.getElementById('start-dry').disabled = busy || !sourceAvailable;
  document.getElementById('start-execute').disabled = busy || !sourceAvailable || !hasDryRun;
  document.getElementById('review-source').disabled = busy || !sourceAvailable;
  document.getElementById('start-execute').title = hasDryRun
    ? ''
    : 'Complete a successful dry run first.';
  syncUnrequitedRemoveOptions();

  setReviewFileState('open-connections', hasConnections);
  setReviewFileState('open-sales', Number(status.salesCount) > 0);
  setReviewFileState('open-unrequited', Number(status.conversationCount) > 0);
  document.getElementById('open-analytics').classList.toggle(
    'unavailable',
    !status.analyticsExists
  );
  document.getElementById('review-candidate-count').textContent = Number(
    status.unrequitedCount || 0
  ).toLocaleString();

  const journeyStatus = document.getElementById('journey-status');
  const journeyDetail = document.getElementById('journey-detail');
  const heroStatus = journeyStatus.closest('.hero-status');
  heroStatus.classList.toggle('running', busy);
  if (busy) {
    journeyStatus.textContent = status.job.label || status.job.name;
    journeyDetail.textContent = status.job.statusLine || 'Starting…';
  } else if (!hasEmail) {
    journeyStatus.textContent = 'Ready when you are';
    journeyDetail.textContent = 'Begin with your login details';
  } else if (!hasConnections) {
    journeyStatus.textContent = 'Login setup complete';
    journeyDetail.textContent = 'Next: download your connections';
  } else {
    journeyStatus.textContent = `${Number(status.connectionsCount).toLocaleString()} connections ready`;
    journeyDetail.textContent = hasInbox
      ? 'Review your results or continue safely'
      : 'Next: explore insights or search your inbox';
  }
}

function renderStatus(status) {
  if (!status) {
    return;
  }
  const cacheCountChanged = intelligenceCacheCount !== Number(status.conversationCount || 0);
  const hasConnectionsChanged = connectionsCacheCount !== Number(status.connectionsCount || 0);
  latestStatus = status;
  intelligenceCacheCount = Number(status.conversationCount || 0);
  connectionsCacheCount = Number(status.connectionsCount || 0);
  document.getElementById('stat-email').textContent = status.email || 'not set';
  document.getElementById('stat-csv').textContent = String(status.connectionsCount ?? 0);
  document.getElementById('stat-sales').textContent = String(status.salesCount ?? 0);
  document.getElementById('stat-unrequited').textContent = String(
    status.unrequitedCount ?? 0
  );
  const cacheSummary = document.getElementById('inbox-cache-summary');
  if (cacheSummary) {
    const cached = Number(status.conversationCount ?? 0);
    const candidates = Number(status.unrequitedCount ?? 0);
    cacheSummary.textContent = `Conversation cache: ${cached.toLocaleString()} · candidates: ${candidates.toLocaleString()}${
      status.inboxCacheComplete
        ? ' · list complete'
        : status.inboxCacheResumable
          ? ' · resume available'
          : ''
    }`;
  }
  document.getElementById('stat-job').textContent = status.job ? status.job.name : 'idle';
  if (status.email && !emailEl.value) {
    emailEl.value = status.email;
  }
  const busy = Boolean(status.job);
  const analyticsRunning = Boolean(status.job && status.job.name === 'analytics');
  const inboxRunning = Boolean(
    status.job && (status.job.name === 'inbox-scan' || status.job.name === 'inbox-cache')
  );
  document.getElementById('start-download').disabled = busy;
  document.getElementById('start-inbox-scan').disabled =
    busy || !status.inboxCacheComplete;
  document.getElementById('start-inbox-cache').disabled = busy;
  document.getElementById('start-analytics').disabled = busy;
  document.getElementById('start-dry').disabled = busy;
  document.getElementById('start-execute').disabled = busy;
  document.getElementById('cancel').disabled = !busy;
  setAnalyticsRunning(analyticsRunning);
  setInboxScanRunning(inboxRunning, status.job && status.job.name === 'inbox-cache' ? 'cache' : 'scan');
  renderJobs(status);
  renderJourney(status);
  if (cacheCountChanged) {
    if (intelligence.tab === 'conversations') {
      loadIntelligence();
    }
  }
  if (hasConnectionsChanged) {
    if (intelligence.tab === 'connections') {
      loadConnectionsAnalytics();
    }
  }
}

async function refreshStatus() {
  const response = await fetch('/api/status');
  const status = await response.json();
  renderStatus(status);
}

function scrollJobsIntoView() {
  const running = latestStatus && latestStatus.job;
  showRunningModal(
    running || {
      name: 'job',
      label: 'Starting…',
      detail: '',
      startedAt: new Date().toISOString(),
      statusLine: 'Starting process…',
      state: 'running',
    }
  );
}

document.getElementById('save-email').addEventListener('click', async () => {
  try {
    await postJson('/api/setup', { email: emailEl.value });
    appendLog('Saved LINKEDIN_EMAIL to .env (password was not written).');
    await refreshStatus();
    document.getElementById('step-download').scrollIntoView({
      behavior: 'smooth',
      block: 'center',
    });
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

document.getElementById('start-download').addEventListener('click', async () => {
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/download', {
      password: password(),
      months: document.getElementById('months').value,
      limit: document.getElementById('dl-limit').value,
      fresh: document.getElementById('fresh').checked,
    });
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

document.getElementById('start-inbox-scan').addEventListener('click', async () => {
  if (!latestStatus || !latestStatus.inboxCacheComplete) {
    appendLog('Cache the conversation list first before searching for unrequited messages.');
    return;
  }
  setInboxScanRunning(true, 'scan');
  document.getElementById('start-inbox-scan').disabled = true;
  document.getElementById('start-inbox-cache').disabled = true;
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/inbox-scan', {
      password: password(),
      days: document.getElementById('inbox-days').value,
      tabs: document.getElementById('inbox-tabs').value,
      limit: document.getElementById('inbox-limit').value,
      fresh: document.getElementById('inbox-fresh').checked,
    });
  } catch (err) {
    setInboxScanRunning(false);
    appendLog(err.stack || err.message);
    await refreshStatus();
  }
});

document.getElementById('start-inbox-cache').addEventListener('click', async () => {
  setInboxScanRunning(true, 'cache');
  document.getElementById('start-inbox-scan').disabled = true;
  document.getElementById('start-inbox-cache').disabled = true;
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/inbox-cache', {
      password: password(),
      fresh: document.getElementById('inbox-fresh').checked,
    });
  } catch (err) {
    setInboxScanRunning(false);
    appendLog(err.stack || err.message);
    await refreshStatus();
  }
});

document.getElementById('start-analytics').addEventListener('click', async () => {
  setAnalyticsRunning(true);
  document.getElementById('start-analytics').disabled = true;
  document.getElementById('cancel').disabled = false;
  document.getElementById('stat-job').textContent = 'analytics';
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/analytics', {});
  } catch (err) {
    setAnalyticsRunning(false);
    appendLog(err.stack || err.message);
    await refreshStatus();
  }
});

function removePayload(execute) {
  return {
    password: password(),
    execute,
    confirm: execute,
    csv: document.getElementById('csv-source').value,
    status: document.getElementById('status').value,
    keywords: document.getElementById('rm-keywords').value,
    protectUnrequited: document.getElementById('rm-protect-unrequited').checked,
    includeSingleMessage:
      document.getElementById('csv-source').value === 'unrequited' &&
      document.getElementById('rm-include-single-message').checked,
    safeKeywords: document.getElementById('rm-safe-keywords').value,
    limit: document.getElementById('rm-limit').value,
  };
}

function sourceContactRow(contact) {
  const row = document.createElement('tr');
  const protectCell = document.createElement('td');
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.checked = Boolean(contact.protected);
  checkbox.setAttribute(
    'aria-label',
    `${checkbox.checked ? 'Unprotect' : 'Protect'} ${contact.name || contact.vanityName || 'contact'}`
  );
  checkbox.addEventListener('change', async () => {
    const next = checkbox.checked;
    checkbox.disabled = true;
    try {
      await postJson('/api/removal-source/protection', {
        source: sourceReview.source,
        key: contact.key,
        protected: next,
      });
      contact.protected = next;
      checkbox.setAttribute(
        'aria-label',
        `${next ? 'Unprotect' : 'Protect'} ${contact.name || contact.vanityName || 'contact'}`
      );
    } catch (err) {
      checkbox.checked = !next;
      document.getElementById('source-list-status').textContent = err.stack || err.message;
    } finally {
      checkbox.disabled = false;
    }
  });
  protectCell.append(checkbox);

  const nameCell = document.createElement('td');
  nameCell.append(textElement('span', 'source-contact-name', contact.name || contact.vanityName || '—'));
  const titleCell = textElement('td', '', contact.title || '—');
  const profileCell = document.createElement('td');
  if (contact.profileUrl) {
    const link = document.createElement('a');
    link.href = contact.profileUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = contact.vanityName || 'Open profile';
    profileCell.append(link);
  } else {
    profileCell.textContent = contact.vanityName || '—';
  }
  row.append(protectCell, nameCell, titleCell, profileCell);
  return row;
}

async function loadSourceContacts() {
  const list = document.getElementById('source-list');
  const status = document.getElementById('source-list-status');
  status.textContent = 'Loading contacts…';
  const params = new URLSearchParams({
    source: sourceReview.source,
    page: String(sourceReview.page),
    pageSize: '100',
  });
  if (sourceReview.query) {
    params.set('q', sourceReview.query);
  }
  try {
    const response = await fetch(`/api/removal-source?${params}`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error || `Request failed (${response.status})`);
    }
    sourceReview.page = data.page;
    sourceReview.pages = data.pages;
    list.replaceChildren();
    if (!data.contacts.length) {
      const row = document.createElement('tr');
      const cell = textElement('td', 'source-empty', 'No matching contacts.');
      cell.colSpan = 4;
      row.append(cell);
      list.append(row);
    } else {
      list.append(...data.contacts.map(sourceContactRow));
    }
    status.textContent = `${Number(data.filtered).toLocaleString()} matching contacts from ${Number(data.total).toLocaleString()} total`;
    document.getElementById('source-page').textContent =
      `Page ${data.page.toLocaleString()} of ${data.pages.toLocaleString()}`;
    document.getElementById('source-prev').disabled = data.page <= 1;
    document.getElementById('source-next').disabled = data.page >= data.pages;
  } catch (err) {
    list.replaceChildren();
    status.textContent = err.stack || err.message;
  }
}

function closeSourceModal() {
  document.getElementById('source-modal').hidden = true;
}

document.getElementById('review-source').addEventListener('click', () => {
  sourceReview.source = document.getElementById('csv-source').value;
  sourceReview.page = 1;
  sourceReview.query = '';
  document.getElementById('source-search').value = '';
  document.getElementById('source-modal-detail').textContent =
    `${sourceReview.source === 'unrequited' ? 'unrequited-love' : sourceReview.source}.csv · Protected contacts remain in the CSV but can never be disconnected.`;
  document.getElementById('source-modal').hidden = false;
  loadSourceContacts();
  document.getElementById('source-search').focus();
});

document.getElementById('source-close').addEventListener('click', closeSourceModal);
document.getElementById('source-backdrop').addEventListener('click', closeSourceModal);
document.getElementById('source-prev').addEventListener('click', () => {
  sourceReview.page = Math.max(1, sourceReview.page - 1);
  loadSourceContacts();
});
document.getElementById('source-next').addEventListener('click', () => {
  sourceReview.page = Math.min(sourceReview.pages, sourceReview.page + 1);
  loadSourceContacts();
});
document.getElementById('source-search').addEventListener('input', (event) => {
  clearTimeout(sourceReview.timer);
  sourceReview.timer = setTimeout(() => {
    sourceReview.query = event.target.value.trim();
    sourceReview.page = 1;
    loadSourceContacts();
  }, 250);
});

document.getElementById('start-dry').addEventListener('click', async () => {
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/remove', removePayload(false));
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

document.getElementById('start-execute').addEventListener('click', async () => {
  const ok = window.confirm(
    'This will permanently remove connections on LinkedIn. Continue?'
  );
  if (!ok) {
    return;
  }
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/remove', removePayload(true));
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

document.getElementById('cancel').addEventListener('click', async () => {
  try {
    await postJson('/api/jobs/cancel', {});
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

document.getElementById('job-modal-cancel').addEventListener('click', async () => {
  try {
    await postJson('/api/jobs/cancel', {});
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

document.getElementById('success-close').addEventListener('click', () => {
  hideSuccessModal();
});

document.getElementById('success-backdrop').addEventListener('click', () => {
  hideSuccessModal();
});

document.querySelector('.journey-rail').addEventListener('click', (event) => {
  const link = event.target.closest('a[aria-disabled="true"]');
  if (link) {
    event.preventDefault();
  }
});

document.getElementById('csv-source').addEventListener('change', () => {
  if (latestStatus) {
    renderJourney(latestStatus);
  }
});

const events = new EventSource('/api/events');
events.addEventListener('message', (event) => {
  try {
    const payload = JSON.parse(event.data);
    if (payload.type === 'hello') {
      renderStatus(payload.status);
      if (Array.isArray(payload.log)) {
        logEl.textContent = payload.log.join('\n');
        if (payload.log.length) {
          logEl.textContent += '\n';
        }
        logEl.scrollTop = logEl.scrollHeight;
      }
      return;
    }
    if (payload.type === 'log') {
      appendLog(payload.line);
      return;
    }
    if (payload.type === 'status') {
      renderStatus(payload.status);
      return;
    }
    if (payload.type === 'job') {
      if (
        payload.completed &&
        (payload.completed.outcome === 'succeeded' || payload.completed.outcome === 'failed')
      ) {
        const completed = payload.completed;
        refreshStatus()
          .then(() => showResultModal(completed, latestStatus))
          .catch((err) => appendLog(err.stack || err.message));
        return;
      }
      if (payload.job && latestStatus) {
        renderStatus({ ...latestStatus, job: payload.job });
      } else {
        refreshStatus().catch((err) => appendLog(err.stack || err.message));
      }
    }
  } catch (err) {
    appendLog(err.stack || err.message);
  }
});

restoreRememberedPassword();
initWorkspaceTabs();
refreshStatus()
  .then(() => {
    if (workspaceTab === 'analytics') {
      showAnalyticsTab(intelligence.tab);
    }
  })
  .catch((err) => appendLog(err.stack || err.message));

setInterval(() => {
  if (latestStatus && latestStatus.job) {
    renderJobs(latestStatus);
  }
}, 1000);
