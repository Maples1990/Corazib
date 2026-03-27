function getCsrfToken() {
  var match = document.cookie.match(/(?:^|;\s*)_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

var form = document.getElementById('track-form');
var feedback = document.getElementById('track-feedback');
var results = document.getElementById('track-results');

form.addEventListener('submit', async function(e) {
  e.preventDefault();
  var email = form.email.value.trim();
  if (!email) return;

  feedback.textContent = 'Looking up\u2026';
  results.innerHTML = '';

  try {
    var res = await fetch('/api/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify({ email: email }),
      credentials: 'same-origin',
    });

    var data = await res.json();
    if (!res.ok || !data.ok) {
      feedback.textContent = data.message || 'Something went wrong.';
      return;
    }

    if (!data.submissions || data.submissions.length === 0) {
      feedback.textContent = '';
      results.innerHTML = '<div class="track-empty">No orders found for that email address.</div>';
      return;
    }

    feedback.textContent = 'Found ' + data.submissions.length + ' submission' + (data.submissions.length > 1 ? 's' : '');

    results.innerHTML = data.submissions.map(function(s) {
      var date = new Date(s.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      var statusClass = 'track-status--' + s.status;
      var label = s.status.replace(/-/g, ' ');
      var details = [
        s.type === 'order' ? (s.apparel || 'Apparel') : 'Contact message',
        s.quantity ? 'Qty: ' + s.quantity : '',
        'Submitted: ' + date,
      ].filter(Boolean).join(' \u00b7 ');

      return '<div class="track-card">' +
        '<div class="track-card-header">' +
        '<span class="track-card-id">' + s.id + '</span>' +
        '<span class="track-status ' + statusClass + '">' + label + '</span>' +
        '</div>' +
        '<div class="track-card-details">' + details + '</div>' +
        '</div>';
    }).join('');
  } catch (_err) {
    feedback.textContent = 'Connection error. Please try again.';
  }
});
