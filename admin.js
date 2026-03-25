const loginPanel = document.querySelector('#login-panel');
const dashboard = document.querySelector('#dashboard');
const requestCodeForm = document.querySelector('#request-code-form');
const verifyCodeForm = document.querySelector('#verify-code-form');
const requestCodeFeedback = document.querySelector('#request-code-feedback');
const verifyCodeFeedback = document.querySelector('#verify-code-feedback');
const filterSelect = document.querySelector('#submission-filter');
const refreshButton = document.querySelector('#refresh-submissions');
const logoutButton = document.querySelector('#logout-button');
const submissionList = document.querySelector('#submission-list');
const submissionTemplate = document.querySelector('#submission-template');
const dashboardEmpty = document.querySelector('#dashboard-empty');

let submissions = [];

initialize();

async function initialize() {
  bindEvents();
  await checkSession();
}

function bindEvents() {
  requestCodeForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = requestCodeForm.querySelector('button[type="submit"]');
    const email = requestCodeForm.email.value.trim();

    setBusy(submitButton, true);
    requestCodeFeedback.textContent = 'Sending sign-in code...';

    try {
      const result = await api('/api/admin/request-code', {
        method: 'POST',
        body: { email },
      });

      requestCodeFeedback.textContent = result.message;

      if (result.devCode) {
        requestCodeFeedback.textContent += ` Development code: ${result.devCode}`;
      }
    } catch (error) {
      requestCodeFeedback.textContent = error.message;
    } finally {
      setBusy(submitButton, false);
    }
  });

  verifyCodeForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = verifyCodeForm.querySelector('button[type="submit"]');
    const email = requestCodeForm.email.value.trim();
    const code = verifyCodeForm.code.value.trim();

    setBusy(submitButton, true);
    verifyCodeFeedback.textContent = 'Verifying...';

    try {
      const result = await api('/api/admin/verify-code', {
        method: 'POST',
        body: { email, code },
      });

      verifyCodeFeedback.textContent = result.message;
      verifyCodeForm.reset();
      await showDashboard();
    } catch (error) {
      verifyCodeFeedback.textContent = error.message;
    } finally {
      setBusy(submitButton, false);
    }
  });

  filterSelect?.addEventListener('change', renderSubmissions);

  refreshButton?.addEventListener('click', async () => {
    await loadDashboardData();
  });

  logoutButton?.addEventListener('click', async () => {
    try {
      await api('/api/admin/logout', { method: 'POST' });
    } finally {
      dashboard.hidden = true;
      loginPanel.hidden = false;
    }
  });
}

async function checkSession() {
  try {
    await api('/api/admin/me');
    await showDashboard();
  } catch (_error) {
    loginPanel.hidden = false;
    dashboard.hidden = true;
  }
}

async function showDashboard() {
  loginPanel.hidden = true;
  dashboard.hidden = false;
  await loadDashboardData();
}

async function loadDashboardData() {
  const [statsResponse, submissionsResponse] = await Promise.all([
    api('/api/admin/stats'),
    api('/api/admin/submissions'),
  ]);

  document.querySelector('#stat-total').textContent = String(statsResponse.stats.total);
  document.querySelector('#stat-new').textContent = String(statsResponse.stats.newCount);
  document.querySelector('#stat-orders').textContent = String(statsResponse.stats.orderCount);
  document.querySelector('#stat-contacts').textContent = String(statsResponse.stats.contactCount);

  submissions = submissionsResponse.submissions;
  renderSubmissions();
}

function renderSubmissions() {
  submissionList.innerHTML = '';
  const filter = filterSelect?.value || 'all';
  const visibleSubmissions = submissions.filter((submission) => {
    if (filter === 'all') {
      return true;
    }
    if (filter === 'new') {
      return submission.status === 'new';
    }
    return submission.type === filter;
  });

  dashboardEmpty.hidden = visibleSubmissions.length > 0;

  visibleSubmissions.forEach((submission) => {
    const fragment = submissionTemplate.content.cloneNode(true);
    const card = fragment.querySelector('.submission-card');
    const title = fragment.querySelector('.submission-title');
    const type = fragment.querySelector('.submission-type');
    const date = fragment.querySelector('.submission-date');
    const details = fragment.querySelector('.submission-details');
    const statusField = fragment.querySelector('.submission-status');
    const notesField = fragment.querySelector('.submission-notes');
    const saveButton = fragment.querySelector('.save-submission');
    const emailLink = fragment.querySelector('.submission-email-link');
    const feedback = fragment.querySelector('.submission-feedback');

    card.dataset.id = submission.id;
    type.textContent = submission.type;
    title.textContent = submission.type === 'order' ? `${submission.name} order request` : `${submission.name} contact message`;
    date.textContent = new Date(submission.createdAt).toLocaleString();
    details.innerHTML = buildSubmissionDetails(submission);
    statusField.value = submission.status;
    notesField.value = submission.notes || '';
    emailLink.href = `mailto:${encodeURIComponent(submission.email)}`;

    saveButton.addEventListener('click', async () => {
      setBusy(saveButton, true);
      feedback.textContent = 'Saving...';

      try {
        const result = await api(`/api/admin/submissions/${submission.id}`, {
          method: 'PATCH',
          body: {
            status: statusField.value,
            notes: notesField.value,
          },
        });

        feedback.textContent = 'Saved.';
        Object.assign(submission, result.submission);
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        setBusy(saveButton, false);
      }
    });

    submissionList.append(fragment);
  });
}

function buildSubmissionDetails(submission) {
  if (submission.type === 'order') {
    return [
      detailRow('Email', submission.email),
      detailRow('Phone', submission.phone || 'Not provided'),
      detailRow('Apparel', submission.apparel),
      detailRow('Audience', submission.audience),
      detailRow('Quantity', submission.quantity),
      detailRow('Needed by', submission.deadline || 'Not provided'),
      detailRow('Occasion', submission.occasion || 'Not provided'),
      detailRow('Design details', escapeHtml(submission.details), true),
    ].join('');
  }

  return [
    detailRow('Email', submission.email),
    detailRow('Subject', submission.subject),
    detailRow('Message', escapeHtml(submission.message), true),
  ].join('');
}

function detailRow(label, value, allowHtml = false) {
  const safeValue = allowHtml ? value : escapeHtml(value);
  return `<div><strong>${escapeHtml(label)}:</strong> ${safeValue}</div>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '<br>');
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    credentials: 'same-origin',
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || !result.ok) {
    throw new Error(result.message || 'Request failed.');
  }

  return result;
}

function setBusy(button, busy) {
  if (!button) {
    return;
  }

  button.disabled = busy;
  if (busy) {
    button.setAttribute('aria-busy', 'true');
  } else {
    button.removeAttribute('aria-busy');
  }
}