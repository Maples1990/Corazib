const loginPanel = document.querySelector('#login-panel');
const dashboard = document.querySelector('#dashboard');
const requestCodeForm = document.querySelector('#request-code-form');
const verifyCodeForm = document.querySelector('#verify-code-form');
const requestCodeFeedback = document.querySelector('#request-code-feedback');
const verifyCodeFeedback = document.querySelector('#verify-code-feedback');
const filterSelect = document.querySelector('#submission-filter');
const refreshButton = document.querySelector('#refresh-submissions');
const exportButton = document.querySelector('#export-data');
const logoutButton = document.querySelector('#logout-button');
const submissionList = document.querySelector('#submission-list');
const submissionTemplate = document.querySelector('#submission-template');
const dashboardEmpty = document.querySelector('#dashboard-empty');
const blogCreateForm = document.querySelector('#blog-create-form');
const blogCreateFeedback = document.querySelector('#blog-create-feedback');
const blogPostList = document.querySelector('#blog-post-list');
const blogEmpty = document.querySelector('#blog-empty');

let submissions = [];
let posts = [];

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

  exportButton?.addEventListener('click', async () => {
    try {
      const result = await api('/api/admin/export');
      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `corazon-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      alert(error.message);
    }
  });

  blogCreateForm?.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submitButton = blogCreateForm.querySelector('button[type="submit"]');
    const title = blogCreateForm.title.value.trim();
    const body = blogCreateForm.body.value.trim();

    setBusy(submitButton, true);
    blogCreateFeedback.textContent = 'Creating...';

    try {
      await api('/api/admin/posts', { method: 'POST', body: { title, body } });
      blogCreateFeedback.textContent = 'Post created (unpublished). Toggle publish below.';
      blogCreateForm.reset();
      await loadPosts();
    } catch (error) {
      blogCreateFeedback.textContent = error.message;
    } finally {
      setBusy(submitButton, false);
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

  loadAnalytics();
  loadPosts();
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
    const rows = [
      detailRow('Email', submission.email),
      detailRow('Phone', submission.phone || 'Not provided'),
      detailRow('Apparel', submission.apparel),
      detailRow('Audience', submission.audience),
      detailRow('Quantity', submission.quantity),
      detailRow('Needed by', submission.deadline || 'Not provided'),
      detailRow('Occasion', submission.occasion || 'Not provided'),
      detailRow('Design details', escapeHtml(submission.details), true),
    ];

    if (submission.attachments && submission.attachments.length > 0) {
      const thumbs = submission.attachments.map((f) =>
        `<a href="/api/admin/attachments/${encodeURIComponent(f)}" target="_blank" class="attachment-thumb"><img src="/api/admin/attachments/${encodeURIComponent(f)}" alt="${escapeHtml(f)}"></a>`
      ).join('');
      rows.push(`<div class="attachment-grid"><strong>Attachments:</strong><div class="attachment-images">${thumbs}</div></div>`);
    }

    return rows.join('');
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

async function loadAnalytics() {
  try {
    const result = await api('/api/admin/analytics');
    const a = result.analytics;

    document.querySelector('#stat-views-today').textContent = String(a.todayViews);
    document.querySelector('#stat-views-7d').textContent = String(a.last7Views);
    document.querySelector('#stat-views-30d').textContent = String(a.totalViews);
    document.querySelector('#stat-unique-30d').textContent = String(a.uniqueVisitors);

    // Top pages table
    const pagesBody = document.querySelector('#analytics-top-pages tbody');
    if (pagesBody) {
      pagesBody.innerHTML = a.topPages.length > 0
        ? a.topPages.map((p) => `<tr><td>${escapeHtml(p.page)}</td><td>${p.views}</td></tr>`).join('')
        : '<tr><td colspan="2" class="analytics-empty">No data yet</td></tr>';
    }

    // Top referrers table
    const refsBody = document.querySelector('#analytics-top-referrers tbody');
    if (refsBody) {
      refsBody.innerHTML = a.topReferrers.length > 0
        ? a.topReferrers.map((r) => `<tr><td>${escapeHtml(r.source)}</td><td>${r.views}</td></tr>`).join('')
        : '<tr><td colspan="2" class="analytics-empty">No referrers yet</td></tr>';
    }

    // Bar chart
    const chart = document.querySelector('#analytics-chart');
    if (chart && a.viewsByDay.length > 0) {
      const maxViews = Math.max(...a.viewsByDay.map((d) => d.views), 1);
      chart.innerHTML = a.viewsByDay.map((d) => {
        const pct = Math.max((d.views / maxViews) * 100, 3);
        return `<div class="analytics-bar" style="height:${pct}%" data-label="${d.day}: ${d.views} views"></div>`;
      }).join('');
    } else if (chart) {
      chart.innerHTML = '<p class="analytics-empty">No traffic data yet. Views will appear here as visitors browse the site.</p>';
    }
  } catch (_e) {
    // Analytics is non-critical, silently skip
  }
}

async function loadPosts() {
  try {
    const result = await api('/api/admin/posts');
    posts = result.posts || [];
    renderPosts();
  } catch (_e) {
    // Non-critical
  }
}

function renderPosts() {
  if (!blogPostList) return;
  blogPostList.innerHTML = '';

  if (blogEmpty) blogEmpty.hidden = posts.length > 0;

  posts.forEach((post) => {
    const card = document.createElement('article');
    card.className = 'blog-post-card';
    card.innerHTML = `
      <div class="blog-post-header">
        <div>
          <span class="submission-type">${post.published ? 'Published' : 'Draft'}</span>
          <h3 class="submission-title">${escapeHtml(post.title)}</h3>
        </div>
        <p class="submission-date">${new Date(post.createdAt).toLocaleString()}</p>
      </div>
      <div class="blog-post-body blog-post-preview">${escapeHtml(post.body)}</div>
      <div class="blog-post-edit-form" hidden>
        <label>Title<input type="text" class="blog-edit-title" value="${escapeHtml(post.title).replace(/"/g, '&quot;')}" maxlength="200"></label>
        <label>Body<textarea class="blog-edit-body" rows="5" maxlength="10000">${escapeHtml(post.body)}</textarea></label>
        <div class="submission-actions">
          <button class="button button-primary blog-save-edit" type="button">Save changes</button>
          <button class="button button-secondary blog-cancel-edit" type="button">Cancel</button>
        </div>
      </div>
      <div class="submission-actions blog-post-actions">
        <button class="button button-secondary blog-edit" data-id="${post.id}" type="button">Edit</button>
        <button class="button button-primary blog-toggle-publish" data-id="${post.id}" type="button">
          ${post.published ? 'Unpublish' : 'Publish'}
        </button>
        <button class="button button-secondary blog-delete" data-id="${post.id}" type="button">Delete</button>
      </div>
      <p class="form-feedback blog-post-feedback" aria-live="polite"></p>
    `;

    const toggleBtn = card.querySelector('.blog-toggle-publish');
    const deleteBtn = card.querySelector('.blog-delete');
    const editBtn = card.querySelector('.blog-edit');
    const editForm = card.querySelector('.blog-post-edit-form');
    const preview = card.querySelector('.blog-post-preview');
    const actions = card.querySelector('.blog-post-actions');
    const saveEditBtn = card.querySelector('.blog-save-edit');
    const cancelEditBtn = card.querySelector('.blog-cancel-edit');
    const feedback = card.querySelector('.blog-post-feedback');

    editBtn.addEventListener('click', () => {
      preview.hidden = true;
      actions.hidden = true;
      editForm.hidden = false;
    });

    cancelEditBtn.addEventListener('click', () => {
      preview.hidden = false;
      actions.hidden = false;
      editForm.hidden = true;
    });

    saveEditBtn.addEventListener('click', async () => {
      const newTitle = card.querySelector('.blog-edit-title').value.trim();
      const newBody = card.querySelector('.blog-edit-body').value.trim();
      if (!newTitle || !newBody) { feedback.textContent = 'Title and body are required.'; return; }
      setBusy(saveEditBtn, true);
      try {
        await api(`/api/admin/posts/${post.id}`, { method: 'PATCH', body: { title: newTitle, body: newBody } });
        feedback.textContent = 'Saved!';
        await loadPosts();
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        setBusy(saveEditBtn, false);
      }
    });

    toggleBtn.addEventListener('click', async () => {
      setBusy(toggleBtn, true);
      try {
        await api(`/api/admin/posts/${post.id}`, {
          method: 'PATCH',
          body: { published: !post.published },
        });
        feedback.textContent = post.published ? 'Unpublished.' : 'Published!';
        await loadPosts();
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        setBusy(toggleBtn, false);
      }
    });

    deleteBtn.addEventListener('click', async () => {
      if (!confirm(`Delete "${post.title}"?`)) return;
      setBusy(deleteBtn, true);
      try {
        await api(`/api/admin/posts/${post.id}`, { method: 'DELETE' });
        await loadPosts();
      } catch (error) {
        feedback.textContent = error.message;
      } finally {
        setBusy(deleteBtn, false);
      }
    });

    blogPostList.append(card);
  });
}