const logEl = document.getElementById('log');
const emailEl = document.getElementById('email');
const passwordEl = document.getElementById('password');
const tooltipEl = document.getElementById('tooltip');
let tooltipTarget = null;
let latestStatus = null;

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

function appendLog(line) {
  logEl.textContent += `${line}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setAnalyticsRunning(running) {
  const btn = document.getElementById('start-analytics');
  const hint = document.getElementById('analytics-status');
  btn.classList.toggle('busy', running);
  btn.textContent = running ? 'Generating…' : 'Generate dashboard';
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
  if (!card || !link) {
    return;
  }
  card.classList.toggle('locked', state === 'locked');
  card.classList.toggle('current', state === 'current');
  card.classList.toggle('complete', state === 'complete');
  link.classList.toggle('current', state === 'current');
  link.classList.toggle('complete', state === 'complete');
  link.setAttribute('aria-disabled', state === 'locked' ? 'true' : 'false');
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

function renderJourney(status) {
  const busy = Boolean(status.job);
  const hasEmail = Boolean(status.email);
  const hasConnections = Number(status.connectionsCount) > 0;
  const hasInsights = Boolean(status.analyticsExists) || Number(status.salesCount) > 0;
  const hasInbox = Boolean(status.inboxCacheComplete) || Number(status.conversationCount) > 0;
  const hasDryRun = (status.history || []).some(
    (job) => job.name === 'remove-dry-run' && job.outcome === 'succeeded'
  );

  const states = {
    setup: hasEmail ? 'complete' : 'current',
    download: !hasEmail ? 'locked' : hasConnections ? 'complete' : 'current',
    insights: !hasConnections ? 'locked' : hasInsights ? 'complete' : 'available',
    inbox: !hasConnections ? 'locked' : hasInbox ? 'complete' : 'current',
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
  document.getElementById('start-inbox-scan').disabled = busy || !hasConnections;
  document.getElementById('start-inbox-cache').disabled = busy || !hasConnections;
  const sourceAvailable = selectedSourceAvailable(status);
  document.getElementById('start-dry').disabled = busy || !sourceAvailable;
  document.getElementById('start-execute').disabled = busy || !sourceAvailable || !hasDryRun;
  document.getElementById('start-execute').title = hasDryRun
    ? ''
    : 'Complete a successful dry run first.';

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
  latestStatus = status;
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
  document.getElementById('start-inbox-scan').disabled = busy;
  document.getElementById('start-inbox-cache').disabled = busy;
  document.getElementById('start-analytics').disabled = busy;
  document.getElementById('start-dry').disabled = busy;
  document.getElementById('start-execute').disabled = busy;
  document.getElementById('cancel').disabled = !busy;
  setAnalyticsRunning(analyticsRunning);
  setInboxScanRunning(inboxRunning, status.job && status.job.name === 'inbox-cache' ? 'cache' : 'scan');
  renderJobs(status);
  renderJourney(status);
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
    safeKeywords: document.getElementById('rm-safe-keywords').value,
    limit: document.getElementById('rm-limit').value,
  };
}

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
refreshStatus().catch((err) => appendLog(err.stack || err.message));

setInterval(() => {
  if (latestStatus && latestStatus.job) {
    renderJobs(latestStatus);
  }
}, 1000);
