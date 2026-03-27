const revealedSections = document.querySelectorAll('.reveal');
const forms = document.querySelectorAll('.js-submit-form');

/* --- CSRF token helper --- */
function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : '';
}

/* --- Pageview analytics beacon --- */
(function trackPageview() {
  try {
    const payload = {
      path: location.pathname,
      referrer: document.referrer || '',
      screen: `${screen.width}x${screen.height}`,
    };
    fetch('/api/track/pageview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrfToken() },
      body: JSON.stringify(payload),
      credentials: 'same-origin',
    }).catch(() => {});
  } catch (_e) { /* silent */ }
})();

/* --- Scroll reveal --- */
const observer = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) {
        return;
      }

      entry.target.classList.add('is-visible');
      observer.unobserve(entry.target);
    });
  },
  {
    threshold: 0.18,
    rootMargin: '0px 0px -40px 0px',
  }
);

revealedSections.forEach((section) => observer.observe(section));

/* --- Hamburger menu --- */
const navToggle = document.getElementById('nav-toggle');
const siteNav = document.getElementById('site-nav');

if (navToggle && siteNav) {
  navToggle.addEventListener('click', () => {
    const isOpen = siteNav.classList.toggle('is-open');
    navToggle.classList.toggle('is-active', isOpen);
    navToggle.setAttribute('aria-expanded', String(isOpen));
  });

  siteNav.querySelectorAll('a').forEach((link) => {
    link.addEventListener('click', () => {
      siteNav.classList.remove('is-open');
      navToggle.classList.remove('is-active');
      navToggle.setAttribute('aria-expanded', 'false');
    });
  });
}

/* --- Seasonal banner --- */
(function loadSeasonalBanner() {
  const banner = document.getElementById('seasonal-banner');
  if (!banner) return;

  fetch('/api/theme')
    .then((res) => res.ok ? res.json() : null)
    .then((data) => {
      if (!data || !data.banner) return;
      if (sessionStorage.getItem('banner-dismissed') === data.season) return;

      banner.textContent = '';
      const msg = document.createElement('span');
      msg.textContent = data.banner;
      banner.appendChild(msg);

      const close = document.createElement('button');
      close.className = 'seasonal-banner-close';
      close.setAttribute('aria-label', 'Dismiss banner');
      close.textContent = '×';
      close.addEventListener('click', () => {
        banner.hidden = true;
        sessionStorage.setItem('banner-dismissed', data.season);
      });
      banner.appendChild(close);

      if (data.colors) {
        Object.entries(data.colors).forEach(([prop, value]) => {
          document.documentElement.style.setProperty(prop, value);
        });
      }

      banner.hidden = false;
    })
    .catch(() => {});
})();

/* --- File upload preview --- */
const fileInput = document.querySelector('.file-upload-input');
const fileText = document.querySelector('.file-upload-text');

/* --- Gallery filter tabs --- */
const galleryFilters = document.querySelectorAll('.gallery-filter');
const galleryCards = document.querySelectorAll('.gallery-card[data-category]');

galleryFilters.forEach((btn) => {
  btn.addEventListener('click', () => {
    galleryFilters.forEach((b) => b.classList.remove('is-active'));
    btn.classList.add('is-active');

    const filter = btn.dataset.filter;

    galleryCards.forEach((card) => {
      const cat = card.dataset.category;
      if (filter === 'all' || cat === 'all' || cat === filter) {
        card.classList.remove('is-hidden');
      } else {
        card.classList.add('is-hidden');
      }
    });
  });
});

if (fileInput && fileText) {
  fileInput.addEventListener('change', () => {
    const count = fileInput.files.length;
    fileText.textContent = count > 0
      ? `${count} file${count > 1 ? 's' : ''} selected`
      : 'Choose files or drag and drop';
  });
}

forms.forEach((form) => {
  const feedback = document.createElement('p');
  feedback.className = 'form-feedback';
  feedback.setAttribute('aria-live', 'polite');
  form.append(feedback);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const submitButton = form.querySelector('button[type="submit"]');
    const formData = new FormData(form);

    feedback.textContent = 'Sending...';

    if (submitButton) {
      submitButton.disabled = true;
      submitButton.setAttribute('aria-busy', 'true');
    }

    try {
      const hasFiles = form.querySelector('input[type="file"]');
      let fetchOptions;

      const csrfToken = getCsrfToken();

      if (hasFiles) {
        fetchOptions = {
          method: form.method || 'POST',
          body: formData,
          headers: { Accept: 'application/json', 'X-CSRF-Token': csrfToken },
          credentials: 'same-origin',
        };
      } else {
        fetchOptions = {
          method: form.method || 'POST',
          body: JSON.stringify(Object.fromEntries(formData.entries())),
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-CSRF-Token': csrfToken,
          },
          credentials: 'same-origin',
        };
      }

      const response = await fetch(form.action, fetchOptions);

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error(result.message || 'Form submission failed');
      }

      feedback.textContent = result.message || form.dataset.successMessage || 'Message sent successfully.';
      form.reset();
      if (fileText) fileText.textContent = 'Choose files or drag and drop';
    } catch (error) {
      feedback.textContent = error.message || 'There was a problem sending the form. Please email maria@corazoncreativeco.com directly.';
    } finally {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.removeAttribute('aria-busy');
      }
    }
  });
});