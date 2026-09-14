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

function renderJobs(status) {
  const currentEl = document.getElementById('current-job');
  const historyEl = document.getElementById('job-history');
  const summaryEl = document.getElementById('jobs-summary');
  const job = status.job;
  const history = Array.isArray(status.history) ? status.history : [];

  currentEl.replaceChildren();
  if (job) {
    const elapsed = Date.now() - new Date(job.startedAt).getTime();
    currentEl.append(
      textElement('div', 'job-name', job.label || job.name),
      textElement('p', 'job-detail', job.detail || ''),
      textElement('p', 'job-stage', job.statusLine || 'Starting…'),
      textElement(
        'p',
        'job-meta',
        `Started ${formatTime(job.startedAt)} · running for ${formatDuration(elapsed)}`
      )
    );
    summaryEl.className = 'status-pill running';
    summaryEl.textContent =
      job.state === 'cancelling' || job.state === 'stopping'
        ? 'Stopping'
        : 'Running';
  } else {
    currentEl.append(textElement('p', 'empty-state', 'No job is running.'));
    const latest = history[0];
    summaryEl.className = `status-pill ${latest ? latest.outcome : 'idle'}`;
    summaryEl.textContent = latest ? latest.outcome : 'Idle';
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
        item.statusLine || `Process exited with code ${item.exitCode}`
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
  document.getElementById('stat-job').textContent = status.job ? status.job.name : 'idle';
  if (status.email && !emailEl.value) {
    emailEl.value = status.email;
  }
  const busy = Boolean(status.job);
  const analyticsRunning = Boolean(status.job && status.job.name === 'analytics');
  document.getElementById('start-download').disabled = busy;
  document.getElementById('start-inbox-scan').disabled = busy;
  document.getElementById('start-analytics').disabled = busy;
  document.getElementById('start-dry').disabled = busy;
  document.getElementById('start-execute').disabled = busy;
  document.getElementById('cancel').disabled = !busy;
  setAnalyticsRunning(analyticsRunning);
  renderJobs(status);
}

async function refreshStatus() {
  const response = await fetch('/api/status');
  const status = await response.json();
  renderStatus(status);
}

function scrollJobsIntoView() {
  const pane = document.getElementById('jobs-pane');
  if (!pane) {
    return;
  }
  pane.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.getElementById('save-email').addEventListener('click', async () => {
  try {
    await postJson('/api/setup', { email: emailEl.value });
    appendLog('Saved LINKEDIN_EMAIL to .env (password was not written).');
    await refreshStatus();
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
  scrollJobsIntoView();
  try {
    await postJson('/api/jobs/inbox-scan', {
      password: password(),
      days: document.getElementById('inbox-days').value,
      limit: document.getElementById('inbox-limit').value,
      fresh: document.getElementById('inbox-fresh').checked,
    });
  } catch (err) {
    appendLog(err.stack || err.message);
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
