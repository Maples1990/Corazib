const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');

const app = express();
app.disable('x-powered-by');

loadEnvFile();

const PORT = Number(process.env.PORT || 3000);
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;
const APP_ORIGIN = new URL(APP_BASE_URL).origin;
const APP_ALLOWED_ORIGINS = buildAllowedOrigins(APP_ORIGIN, process.env.APP_ALLOWED_ORIGINS || '');
const CANONICAL_HOST = normalizeHost(process.env.CANONICAL_HOST || '');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || 'maria@corazoncreativeco.com').toLowerCase();
const SESSION_SECRET = process.env.SESSION_SECRET || 'replace-this-in-production';
const ALLOW_DEV_ADMIN_CODE_RESPONSE = process.env.ALLOW_DEV_ADMIN_CODE_RESPONSE === 'true';
const ALLOWED_STATUSES = new Set(['new', 'reviewed', 'contacted', 'in-design', 'in-production', 'completed']);
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';

const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'script.js', 'admin.html', 'admin.css', 'admin.js', 'track.html', 'sizes.html', 'blog.html']);

ensureDirectory(DATA_DIR);
ensureDirectory(UPLOADS_DIR);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, UPLOADS_DIR),
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    const allowed = /^image\/(jpeg|jpg|png|gif|webp)$/i;
    cb(null, allowed.test(file.mimetype));
  },
});

const store = loadStore();
const rateLimits = new Map();

const transporter = createTransporter();

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(securityHeaders);
app.use(enforceCanonicalHost);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, smtpConfigured: Boolean(transporter) });
});

app.use('/api', verifyTrustedRequest);
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }));
app.use('/api/admin/request-code', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));
app.use('/api/admin/verify-code', rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));
app.use('/api/order', rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));
app.use('/api/contact', rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));

app.use('/assets', express.static(path.join(__dirname, 'assets'), {
  extensions: ['jpg', 'jpeg', 'png', 'webp'],
  maxAge: '7d',
  immutable: false,
}));

app.use((req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (req.path === '/') return next();
  if (req.path.startsWith('/assets/')) return next();
  if (req.path.startsWith('/api/')) return next();
  if (req.path === '/sitemap.xml' || req.path === '/robots.txt') return next();
  const basename = path.basename(req.path);
  if (PUBLIC_FILES.has(basename)) return next();
  if (PUBLIC_FILES.has(basename + '.html')) return next();
  return res.status(404).json({ ok: false, message: 'Not found.' });
});

app.use(express.static(__dirname, {
  extensions: ['html'],
  index: 'index.html',
  dotfiles: 'deny',
  setHeaders(res, filePath) {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.post('/api/order', upload.array('attachments', 5), asyncHandler(async (req, res) => {
  const payload = sanitizeSubmission(req.body);
  const missing = [
    ['name', payload.name],
    ['email', payload.email],
    ['apparel', payload.apparel],
    ['audience', payload.audience],
    ['quantity', payload.quantity],
    ['details', payload.details],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    return res.status(400).json({ ok: false, message: 'Please complete all required order fields.' });
  }

  if (!isValidEmail(payload.email)) {
    return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  }

  const quantity = Number(payload.quantity);
  if (!Number.isFinite(quantity) || quantity < 1) {
    return res.status(400).json({ ok: false, message: 'Quantity must be a valid number.' });
  }

  const submission = {
    id: createId('ord'),
    type: 'order',
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: payload.name,
    email: payload.email,
    phone: payload.phone,
    apparel: payload.apparel,
    audience: payload.audience,
    quantity: quantity,
    deadline: payload.deadline,
    occasion: payload.occasion,
    details: payload.details,
    attachments: (req.files || []).map((f) => f.filename),
    notes: '',
  };

  store.submissions.unshift(submission);
  persistStore();

  await sendNotificationEmail({
    subject: `New order request from ${submission.name}`,
    text: formatOrderEmail(submission),
  });

  await sendCustomerConfirmation({
    to: submission.email,
    name: submission.name,
    subject: 'Corazon Creative Co. received your order request',
    text: formatOrderConfirmationEmail(submission),
  });

  res.json({ ok: true, message: 'Order request sent successfully. Maria will receive it by email.' });
}));

app.post('/api/contact', asyncHandler(async (req, res) => {
  const payload = sanitizeSubmission(req.body);
  const missing = [
    ['name', payload.name],
    ['email', payload.email],
    ['subject', payload.subject],
    ['message', payload.message],
  ].filter(([, value]) => !value);

  if (missing.length > 0) {
    return res.status(400).json({ ok: false, message: 'Please complete all required contact fields.' });
  }

  if (!isValidEmail(payload.email)) {
    return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  }

  const submission = {
    id: createId('msg'),
    type: 'contact',
    status: 'new',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    name: payload.name,
    email: payload.email,
    subject: payload.subject,
    message: payload.message,
    notes: '',
  };

  store.submissions.unshift(submission);
  persistStore();

  await sendNotificationEmail({
    subject: `New contact message from ${submission.name}`,
    text: formatContactEmail(submission),
  });

  await sendCustomerConfirmation({
    to: submission.email,
    name: submission.name,
    subject: 'Corazon Creative Co. received your message',
    text: formatContactConfirmationEmail(submission),
  });

  res.json({ ok: true, message: 'Message sent successfully. Maria will receive it by email.' });
}));

app.post('/api/admin/request-code', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email || email !== ADMIN_EMAIL) {
    return res.json({ ok: true, message: 'If that email is authorized, a sign-in code has been sent.' });
  }

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = Date.now() + 15 * 60 * 1000;
  store.auth.pendingCodeHash = createHash(code);
  store.auth.pendingEmail = email;
  store.auth.pendingExpiresAt = expiresAt;
  persistStore();

  let devCode;

  if (transporter) {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || ADMIN_EMAIL,
      to: ADMIN_EMAIL,
      subject: 'Your Corazon admin sign-in code',
      text: [
        'Use this one-time code to sign in to the Corazon Creative Co. admin dashboard.',
        '',
        `Code: ${code}`,
        '',
        'This code expires in 15 minutes.',
      ].join('\n'),
    });
  } else if (ALLOW_DEV_ADMIN_CODE_RESPONSE) {
    devCode = code;
  } else {
    return res.status(503).json({
      ok: false,
      message: 'Admin email sending is not configured yet. Add SMTP settings to enable secure admin login.',
    });
  }

  res.json({
    ok: true,
    message: 'If that email is authorized, a sign-in code has been sent.',
    ...(devCode ? { devCode } : {}),
  });
}));

app.post('/api/admin/verify-code', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const code = String(req.body.code || '').trim();

  if (!email || !code || email !== ADMIN_EMAIL) {
    return res.status(400).json({ ok: false, message: 'Invalid email or code.' });
  }

  if (!store.auth.pendingCodeHash || !store.auth.pendingExpiresAt || Date.now() > store.auth.pendingExpiresAt) {
    return res.status(400).json({ ok: false, message: 'The code has expired. Request a new one.' });
  }

  if (store.auth.pendingEmail !== email || createHash(code) !== store.auth.pendingCodeHash) {
    store.auth.failedAttempts = (store.auth.failedAttempts || 0) + 1;
    if (store.auth.failedAttempts >= 5) {
      store.auth.pendingCodeHash = null;
      store.auth.pendingEmail = null;
      store.auth.pendingExpiresAt = null;
      store.auth.failedAttempts = 0;
      persistStore();
      return res.status(401).json({ ok: false, message: 'Too many failed attempts. Request a new code.' });
    }
    persistStore();
    return res.status(401).json({ ok: false, message: 'Incorrect sign-in code.' });
  }

  store.auth.failedAttempts = 0;

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  store.auth.pendingCodeHash = null;
  store.auth.pendingEmail = null;
  store.auth.pendingExpiresAt = null;
  store.auth.sessions[token] = { email, expiresAt };
  persistStore();

  setSessionCookie(res, token, expiresAt);
  res.json({ ok: true, message: 'Signed in successfully.' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    delete store.auth.sessions[token];
    persistStore();
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (_req, res) => {
  res.json({ ok: true, email: ADMIN_EMAIL });
});

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const stats = {
    total: store.submissions.length,
    newCount: store.submissions.filter((submission) => submission.status === 'new').length,
    orderCount: store.submissions.filter((submission) => submission.type === 'order').length,
    contactCount: store.submissions.filter((submission) => submission.type === 'contact').length,
  };

  res.json({ ok: true, stats });
});

app.get('/api/admin/submissions', requireAdmin, (_req, res) => {
  res.json({ ok: true, submissions: store.submissions });
});

app.patch('/api/admin/submissions/:id', requireAdmin, asyncHandler(async (req, res) => {
  const submission = store.submissions.find((item) => item.id === req.params.id);
  if (!submission) {
    return res.status(404).json({ ok: false, message: 'Submission not found.' });
  }

  const previousStatus = submission.status;
  const nextStatus = String(req.body.status || '').trim();
  const nextNotes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 4000) : submission.notes;
  if (nextStatus && !ALLOWED_STATUSES.has(nextStatus)) {
    return res.status(400).json({ ok: false, message: 'Invalid submission status.' });
  }

  if (nextStatus) {
    submission.status = nextStatus;
  }
  submission.notes = nextNotes;
  submission.updatedAt = new Date().toISOString();
  persistStore();

  if (nextStatus && nextStatus !== previousStatus && submission.email) {
    const statusEmail = formatStatusUpdateEmail(submission, nextStatus);
    if (statusEmail) {
      await sendCustomerConfirmation({
        to: submission.email,
        name: submission.name,
        subject: statusEmail.subject,
        text: statusEmail.text,
      });
    }
  }

  res.json({ ok: true, submission });
}));

app.get('/track', (_req, res) => {
  res.sendFile(path.join(__dirname, 'track.html'));
});

app.get('/sizes', (_req, res) => {
  res.sendFile(path.join(__dirname, 'sizes.html'));
});

app.get('/blog', (_req, res) => {
  res.sendFile(path.join(__dirname, 'blog.html'));
});

app.post('/api/track', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  if (!email || !isValidEmail(email)) {
    return res.status(400).json({ ok: false, message: 'Please enter a valid email address.' });
  }

  const results = store.submissions
    .filter((s) => s.email && s.email.toLowerCase() === email)
    .map((s) => ({
      id: s.id,
      type: s.type,
      status: s.status,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      apparel: s.apparel || null,
      quantity: s.quantity || null,
      subject: s.subject || null,
    }));

  res.json({ ok: true, submissions: results });
});

app.get('/api/theme', (_req, res) => {
  const themesPath = path.join(__dirname, 'themes.json');
  if (!fs.existsSync(themesPath)) {
    return res.json({ ok: true, season: null, banner: null, colors: null });
  }

  try {
    const themes = JSON.parse(fs.readFileSync(themesPath, 'utf8'));
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

    const active = Object.entries(themes).find(([, theme]) => {
      if (!theme.start || !theme.end) return false;
      if (theme.start <= theme.end) {
        return mmdd >= theme.start && mmdd <= theme.end;
      }
      return mmdd >= theme.start || mmdd <= theme.end;
    });

    if (!active) {
      return res.json({ ok: true, season: null, banner: null, colors: null });
    }

    const [season, theme] = active;
    res.json({ ok: true, season, banner: theme.banner || null, colors: theme.colors || null });
  } catch (_error) {
    res.json({ ok: true, season: null, banner: null, colors: null });
  }
});

/* --- Blog admin CRUD --- */

app.get('/api/admin/posts', requireAdmin, (_req, res) => {
  res.json({ ok: true, posts: store.posts || [] });
});

app.post('/api/admin/posts', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 10000);
  if (!title || !body) {
    return res.status(400).json({ ok: false, message: 'Title and body are required.' });
  }

  const post = {
    id: createId('post'),
    title,
    body,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    published: false,
  };

  if (!store.posts) store.posts = [];
  store.posts.unshift(post);
  persistStore();
  res.json({ ok: true, post });
});

app.patch('/api/admin/posts/:id', requireAdmin, (req, res) => {
  if (!store.posts) store.posts = [];
  const post = store.posts.find((p) => p.id === req.params.id);
  if (!post) return res.status(404).json({ ok: false, message: 'Post not found.' });

  if (typeof req.body.title === 'string') post.title = req.body.title.trim().slice(0, 200);
  if (typeof req.body.body === 'string') post.body = req.body.body.trim().slice(0, 10000);
  if (typeof req.body.published === 'boolean') post.published = req.body.published;
  post.updatedAt = new Date().toISOString();
  persistStore();
  res.json({ ok: true, post });
});

app.delete('/api/admin/posts/:id', requireAdmin, (req, res) => {
  if (!store.posts) store.posts = [];
  const index = store.posts.findIndex((p) => p.id === req.params.id);
  if (index === -1) return res.status(404).json({ ok: false, message: 'Post not found.' });

  store.posts.splice(index, 1);
  persistStore();
  res.json({ ok: true });
});

app.get('/api/posts', (_req, res) => {
  const published = (store.posts || []).filter((p) => p.published);
  res.json({ ok: true, posts: published });
});

/* --- Admin attachment viewer --- */

app.get('/api/admin/attachments/:filename', requireAdmin, (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(UPLOADS_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ ok: false, message: 'File not found.' });
  }
  res.sendFile(filePath);
});

/* --- Stripe checkout stub --- */

app.post('/api/checkout', asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ ok: false, message: 'Online payments are not configured yet. Please use the order form to request a custom quote.' });
  }

  // When Stripe is configured, create a checkout session here
  res.status(503).json({ ok: false, message: 'Checkout is coming soon.' });
}));

/* --- Sitemap and robots.txt --- */

app.get('/sitemap.xml', (_req, res) => {
  const pages = ['', '/track', '/sizes', '/blog'];
  const urls = pages.map((p) =>
    `  <url><loc>https://corazoncreativeco.org${p}</loc></url>`
  ).join('\n');

  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(
    'User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\nSitemap: https://corazoncreativeco.org/sitemap.xml\n'
  );
});

app.use((req, res, next) => {
  if (req.method === 'GET' && PUBLIC_FILES.has(path.basename(req.path))) {
    return next();
  }

  if (req.method === 'GET' && req.path === '/') {
    return next();
  }

  return res.status(404).json({ ok: false, message: 'Not found.' });
});

app.listen(PORT, () => {
  console.log(`Corazon Creative Co. running at ${APP_BASE_URL}`);
});

app.use((error, _req, res, _next) => {
  if (error && error.code === 'SPAM_REJECTED') {
    return res.status(400).json({ ok: false, message: 'Submission rejected.' });
  }

  console.error(error);
  return res.status(500).json({ ok: false, message: 'Something went wrong. Please try again.' });
});

function loadEnvFile() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) {
    return;
  }

  const content = fs.readFileSync(envPath, 'utf8');
  content.split(/\r?\n/).forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      return;
    }
    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) {
      return;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    let value = trimmed.slice(separatorIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  });
}

function ensureDirectory(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadStore() {
  const initialStore = {
    submissions: [],
    posts: [],
    auth: {
      pendingCodeHash: null,
      pendingEmail: null,
      pendingExpiresAt: null,
      sessions: {},
    },
  };

  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(initialStore, null, 2));
    return initialStore;
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));
    return {
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : [],
      posts: Array.isArray(parsed.posts) ? parsed.posts : [],
      auth: {
        pendingCodeHash: parsed.auth?.pendingCodeHash || null,
        pendingEmail: parsed.auth?.pendingEmail || null,
        pendingExpiresAt: parsed.auth?.pendingExpiresAt || null,
        sessions: parsed.auth?.sessions || {},
      },
    };
  } catch (_error) {
    fs.writeFileSync(STORE_FILE, JSON.stringify(initialStore, null, 2));
    return initialStore;
  }
}

function persistStore() {
  pruneSessions();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}

function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS,
    },
  });
}

async function sendNotificationEmail({ subject, text }) {
  if (!transporter) {
    return;
  }

  await transporter.sendMail({
    from: process.env.SMTP_FROM || ADMIN_EMAIL,
    to: ADMIN_EMAIL,
    subject,
    text,
  });
}

async function sendCustomerConfirmation({ to, name, subject, text }) {
  if (!transporter) {
    return;
  }

  try {
    await transporter.sendMail({
      from: process.env.SMTP_FROM || ADMIN_EMAIL,
      to,
      subject,
      text,
    });
  } catch (error) {
    console.error(`Failed to send confirmation email to ${to}:`, error.message);
  }
}

function sanitizeSubmission(body) {
  const data = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === '_honey') {
      continue;
    }
    data[key] = typeof value === 'string' ? value.trim().slice(0, 4000) : value;
  }

  if (typeof body._honey === 'string' && body._honey.trim()) {
    const spamError = new Error('Spam rejected');
    spamError.code = 'SPAM_REJECTED';
    throw spamError;
  }

  return data;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function formatOrderEmail(submission) {
  const lines = [
    'New Corazon Creative Co. order request',
    '',
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Phone: ${submission.phone || 'Not provided'}`,
    `Apparel: ${submission.apparel}`,
    `Audience: ${submission.audience}`,
    `Quantity: ${submission.quantity}`,
    `Needed by: ${submission.deadline || 'Not provided'}`,
    `Occasion: ${submission.occasion || 'Not provided'}`,
    '',
    'Design details:',
    submission.details,
  ];

  if (submission.attachments && submission.attachments.length > 0) {
    lines.push('', `Attachments: ${submission.attachments.length} file(s) uploaded`);
  }

  return lines.join('\n');
}

function formatContactEmail(submission) {
  return [
    'New Corazon Creative Co. contact message',
    '',
    `Name: ${submission.name}`,
    `Email: ${submission.email}`,
    `Subject: ${submission.subject}`,
    '',
    submission.message,
  ].join('\n');
}

function formatOrderConfirmationEmail(submission) {
  return [
    `Hi ${submission.name},`,
    '',
    'Thank you for your order request with Corazon Creative Co.! Maria has received your details and will follow up with you soon to discuss your design, sizing, and next steps.',
    '',
    'Here\'s a summary of what you submitted:',
    '',
    `Apparel: ${submission.apparel}`,
    `Audience: ${submission.audience}`,
    `Quantity: ${submission.quantity}`,
    `Needed by: ${submission.deadline || 'Not specified'}`,
    `Occasion: ${submission.occasion || 'Not specified'}`,
    '',
    'Design details:',
    submission.details,
    '',
    'If you have any questions in the meantime, feel free to reply to this email.',
    '',
    'Blessings,',
    'Corazon Creative Co.',
    'Inspired Hands. Faithful Heart.',
  ].join('\n');
}

function formatContactConfirmationEmail(submission) {
  return [
    `Hi ${submission.name},`,
    '',
    'Thank you for reaching out to Corazon Creative Co.! Maria has received your message and will get back to you as soon as possible.',
    '',
    `Your message regarding "${submission.subject}" has been received.`,
    '',
    'If you need anything else, feel free to reply to this email.',
    '',
    'Blessings,',
    'Corazon Creative Co.',
    'Inspired Hands. Faithful Heart.',
  ].join('\n');
}

const STATUS_EMAIL_MAP = {
  reviewed: {
    subject: 'Your request has been reviewed — Corazon Creative Co.',
    body: 'Maria has reviewed your request and will be reaching out soon to discuss the details.',
  },
  'in-design': {
    subject: 'Your design is in progress — Corazon Creative Co.',
    body: 'Great news! Maria has started working on your design. She\'ll follow up with proofs or questions as things take shape.',
  },
  'in-production': {
    subject: 'Your order is in production — Corazon Creative Co.',
    body: 'Your apparel is now in production! Maria will let you know when everything is ready.',
  },
  completed: {
    subject: 'Your order is complete — Corazon Creative Co.',
    body: 'Your order is complete and ready! Maria will reach out with pickup or delivery details.',
  },
};

function formatStatusUpdateEmail(submission, status) {
  const template = STATUS_EMAIL_MAP[status];
  if (!template) {
    return null;
  }

  return {
    subject: template.subject,
    text: [
      `Hi ${submission.name},`,
      '',
      template.body,
      '',
      'If you have any questions, feel free to reply to this email.',
      '',
      'Blessings,',
      'Corazon Creative Co.',
      'Inspired Hands. Faithful Heart.',
    ].join('\n'),
  };
}

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createHash(value) {
  return crypto.createHash('sha256').update(`${value}:${SESSION_SECRET}`).digest('hex');
}

function securityHeaders(req, res, next) {
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "img-src 'self' data:",
      "script-src 'self'",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "connect-src 'self'",
    ].join('; ')
  );

  const forwardedProto = req.get('x-forwarded-proto');
  if (req.secure || forwardedProto === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
}

function enforceCanonicalHost(req, res, next) {
  if (!CANONICAL_HOST || !['GET', 'HEAD'].includes(req.method) || req.path.startsWith('/api')) {
    return next();
  }

  const requestHost = normalizeHost(req.get('x-forwarded-host') || req.get('host') || '');
  if (!requestHost || requestHost === CANONICAL_HOST) {
    return next();
  }

  const canonicalUrl = new URL(APP_BASE_URL);
  canonicalUrl.pathname = req.path;
  canonicalUrl.search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  return res.redirect(301, canonicalUrl.toString());
}

function verifyTrustedRequest(req, res, next) {
  if (!['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
    return next();
  }

  const source = req.get('origin') || req.get('referer');
  if (!source) {
    return next();
  }

  if (APP_ALLOWED_ORIGINS.some((origin) => source.startsWith(origin))) {
    return next();
  }

  return res.status(403).json({ ok: false, message: 'Request origin denied.' });
}

function buildAllowedOrigins(primaryOrigin, extraOrigins) {
  const origins = new Set([primaryOrigin]);

  String(extraOrigins || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .forEach((origin) => {
      try {
        origins.add(new URL(origin).origin);
      } catch (_error) {
        // Ignore invalid configured origins rather than crashing startup.
      }
    });

  return [...origins];
}

function normalizeHost(value) {
  return String(value || '').trim().toLowerCase().replace(/:\d+$/, '');
}

function rateLimit({ windowMs, max }) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    const existing = rateLimits.get(key) || { count: 0, expiresAt: now + windowMs };

    if (now > existing.expiresAt) {
      existing.count = 0;
      existing.expiresAt = now + windowMs;
    }

    existing.count += 1;
    rateLimits.set(key, existing);

    if (existing.count > max) {
      return res.status(429).json({ ok: false, message: 'Too many requests. Please try again shortly.' });
    }

    next();
  };
}

function parseCookies(req) {
  const raw = req.headers.cookie;
  if (!raw) {
    return {};
  }

  return raw.split(';').reduce((cookies, part) => {
    const [name, ...rest] = part.trim().split('=');
    cookies[name] = decodeURIComponent(rest.join('='));
    return cookies;
  }, {});
}

function getSessionToken(req) {
  const cookies = parseCookies(req);
  return cookies.corazon_admin_session || null;
}

function setSessionCookie(res, token, expiresAt) {
  const parts = [
    `corazon_admin_session=${encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Expires=${new Date(expiresAt).toUTCString()}`,
  ];

  if (APP_BASE_URL.startsWith('https://')) {
    parts.push('Secure');
  }

  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'corazon_admin_session=; HttpOnly; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

function pruneSessions() {
  const now = Date.now();
  Object.entries(store.auth.sessions).forEach(([token, session]) => {
    if (!session || now > session.expiresAt) {
      delete store.auth.sessions[token];
    }
  });
}

function requireAdmin(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, message: 'Authentication required.' });
  }

  const session = store.auth.sessions[token];
  if (!session || Date.now() > session.expiresAt || session.email !== ADMIN_EMAIL) {
    delete store.auth.sessions[token];
    persistStore();
    clearSessionCookie(res);
    return res.status(401).json({ ok: false, message: 'Session expired. Please sign in again.' });
  }

  next();
}

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
