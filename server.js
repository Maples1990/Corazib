const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const express = require('express');
const compression = require('compression');
const multer = require('multer');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');

let s3Client = null;
let S3_BUCKET = '';
try {
  const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
  const endpoint = process.env.S3_ENDPOINT || '';
  S3_BUCKET = process.env.S3_BUCKET || '';
  const accessKey = process.env.S3_ACCESS_KEY || '';
  const secretKey = process.env.S3_SECRET_KEY || '';
  if (endpoint && S3_BUCKET && accessKey && secretKey) {
    s3Client = new S3Client({
      endpoint,
      region: process.env.S3_REGION || 'auto',
      credentials: { accessKeyId: accessKey, secretAccessKey: secretKey },
      forcePathStyle: true,
    });
    console.log(`S3 storage configured: ${endpoint}/${S3_BUCKET}`);
  }
} catch (_e) { /* S3 SDK not available — local uploads only */ }

const app = express();
app.disable('x-powered-by');
app.use(compression());

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
const DB_FILE = path.join(DATA_DIR, 'corazon.db');
const STORE_FILE = path.join(DATA_DIR, 'store.json');
const ANALYTICS_FILE = path.join(DATA_DIR, 'analytics.json');
const PUBLIC_FILES = new Set(['index.html', 'styles.css', 'script.js', 'admin.html', 'admin.css', 'admin.js', 'track.html', 'sizes.html', 'blog.html', '404.html', 'privacy.html', 'terms.html', 'manifest.json']);

ensureDirectory(DATA_DIR);
ensureDirectory(UPLOADS_DIR);

/* ------------------------------------------------------------------ */
/*  SQLite setup                                                       */
/* ------------------------------------------------------------------ */

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT DEFAULT '',
    apparel TEXT DEFAULT '',
    audience TEXT DEFAULT '',
    quantity INTEGER DEFAULT 0,
    deadline TEXT DEFAULT '',
    occasion TEXT DEFAULT '',
    subject TEXT DEFAULT '',
    message TEXT DEFAULT '',
    details TEXT DEFAULT '',
    attachments TEXT DEFAULT '[]',
    notes TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    published INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS auth_pending (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    code_hash TEXT,
    email TEXT,
    expires_at INTEGER,
    failed_attempts INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS auth_sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    path TEXT NOT NULL,
    referrer TEXT DEFAULT '',
    screen TEXT DEFAULT '',
    visitor_hash TEXT NOT NULL,
    day TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    to_addr TEXT NOT NULL,
    from_addr TEXT NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    attempts INTEGER DEFAULT 0,
    last_attempt TEXT,
    status TEXT DEFAULT 'pending',
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_submissions_email ON submissions(email);
  CREATE INDEX IF NOT EXISTS idx_submissions_status ON submissions(status);
  CREATE INDEX IF NOT EXISTS idx_submissions_type ON submissions(type);
  CREATE INDEX IF NOT EXISTS idx_analytics_day ON analytics(day);
  CREATE INDEX IF NOT EXISTS idx_email_queue_status ON email_queue(status);
  CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
`);

// Ensure auth_pending row exists
db.prepare(`INSERT OR IGNORE INTO auth_pending (id, failed_attempts) VALUES (1, 0)`).run();

/* ------------------------------------------------------------------ */
/*  Prepared statements                                                */
/* ------------------------------------------------------------------ */

const sql = {
  insertSubmission: db.prepare(`
    INSERT INTO submissions (id, type, status, created_at, updated_at, name, email, phone, apparel, audience, quantity, deadline, occasion, subject, message, details, attachments, notes)
    VALUES (@id, @type, @status, @createdAt, @updatedAt, @name, @email, @phone, @apparel, @audience, @quantity, @deadline, @occasion, @subject, @message, @details, @attachments, @notes)
  `),
  allSubmissions: db.prepare(`SELECT * FROM submissions ORDER BY created_at DESC`),
  findSubmission: db.prepare(`SELECT * FROM submissions WHERE id = ?`),
  updateSubmission: db.prepare(`UPDATE submissions SET status = @status, notes = @notes, updated_at = @updatedAt WHERE id = @id`),
  submissionsByEmail: db.prepare(`SELECT id, type, status, created_at, updated_at, apparel, quantity, subject FROM submissions WHERE LOWER(email) = ? ORDER BY created_at DESC`),
  submissionStats: db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'new' THEN 1 ELSE 0 END) as newCount,
      SUM(CASE WHEN type = 'order' THEN 1 ELSE 0 END) as orderCount,
      SUM(CASE WHEN type = 'contact' THEN 1 ELSE 0 END) as contactCount
    FROM submissions
  `),

  allPosts: db.prepare(`SELECT * FROM posts ORDER BY created_at DESC`),
  publishedPosts: db.prepare(`SELECT * FROM posts WHERE published = 1 ORDER BY created_at DESC`),
  findPost: db.prepare(`SELECT * FROM posts WHERE id = ?`),
  insertPost: db.prepare(`INSERT INTO posts (id, title, body, created_at, updated_at, published) VALUES (@id, @title, @body, @createdAt, @updatedAt, @published)`),
  updatePost: db.prepare(`UPDATE posts SET title = @title, body = @body, published = @published, updated_at = @updatedAt WHERE id = @id`),
  deletePost: db.prepare(`DELETE FROM posts WHERE id = ?`),
  countPosts: db.prepare(`SELECT COUNT(*) as cnt FROM posts`),

  getAuthPending: db.prepare(`SELECT * FROM auth_pending WHERE id = 1`),
  setAuthPending: db.prepare(`UPDATE auth_pending SET code_hash = @codeHash, email = @email, expires_at = @expiresAt, failed_attempts = 0 WHERE id = 1`),
  clearAuthPending: db.prepare(`UPDATE auth_pending SET code_hash = NULL, email = NULL, expires_at = NULL, failed_attempts = 0 WHERE id = 1`),
  incrementAuthFails: db.prepare(`UPDATE auth_pending SET failed_attempts = failed_attempts + 1 WHERE id = 1`),

  insertSession: db.prepare(`INSERT INTO auth_sessions (token, email, expires_at) VALUES (?, ?, ?)`),
  findSession: db.prepare(`SELECT * FROM auth_sessions WHERE token = ?`),
  deleteSession: db.prepare(`DELETE FROM auth_sessions WHERE token = ?`),
  pruneExpiredSessions: db.prepare(`DELETE FROM auth_sessions WHERE expires_at < ?`),

  insertAnalytics: db.prepare(`INSERT INTO analytics (ts, path, referrer, screen, visitor_hash, day) VALUES (@ts, @path, @referrer, @screen, @visitorHash, @day)`),
  pruneOldAnalytics: db.prepare(`DELETE FROM analytics WHERE day < ?`),
  recentAnalytics: db.prepare(`SELECT * FROM analytics WHERE day >= ?`),

  queueEmail: db.prepare(`INSERT INTO email_queue (to_addr, from_addr, subject, body, created_at) VALUES (@to, @from, @subject, @body, @createdAt)`),
  pendingEmails: db.prepare(`SELECT * FROM email_queue WHERE status = 'pending' AND attempts < 5 ORDER BY created_at ASC LIMIT 10`),
  markEmailSent: db.prepare(`UPDATE email_queue SET status = 'sent' WHERE id = ?`),
  markEmailAttempt: db.prepare(`UPDATE email_queue SET attempts = attempts + 1, last_attempt = ? WHERE id = ?`),
  markEmailFailed: db.prepare(`UPDATE email_queue SET status = 'failed' WHERE id = ?`),
};

migrateJsonToSqlite();
seedBlogPosts();

/* ------------------------------------------------------------------ */
/*  Multer / file uploads                                              */
/* ------------------------------------------------------------------ */

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

async function uploadToS3(localPath, filename) {
  if (!s3Client) return;
  try {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' };
    await s3Client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: `uploads/${filename}`,
      Body: fs.readFileSync(localPath),
      ContentType: mimeMap[ext] || 'application/octet-stream',
    }));
    console.log(`Uploaded ${filename} to S3`);
  } catch (err) {
    console.error(`S3 upload failed for ${filename}:`, err.message);
  }
}

async function getFromS3(filename) {
  if (!s3Client) return null;
  try {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const response = await s3Client.send(new GetObjectCommand({
      Bucket: S3_BUCKET,
      Key: `uploads/${filename}`,
    }));
    return response;
  } catch (_err) {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Email queue                                                        */
/* ------------------------------------------------------------------ */

const transporter = createTransporter();
const rateLimits = new Map();

function queueEmail({ to, from, subject, text }) {
  const fromAddr = from || process.env.SMTP_FROM || ADMIN_EMAIL;
  sql.queueEmail.run({ to, from: fromAddr, subject, body: text, createdAt: new Date().toISOString() });
  // Try to send immediately in the background
  setImmediate(processEmailQueue);
}

async function processEmailQueue() {
  if (!transporter) return;
  const pending = sql.pendingEmails.all();
  for (const email of pending) {
    try {
      await transporter.sendMail({
        from: email.from_addr,
        to: email.to_addr,
        subject: email.subject,
        text: email.body,
      });
      sql.markEmailSent.run(email.id);
    } catch (err) {
      console.error(`Email send failed (attempt ${email.attempts + 1}) to ${email.to_addr}:`, err.message);
      sql.markEmailAttempt.run(new Date().toISOString(), email.id);
      if (email.attempts + 1 >= 5) {
        sql.markEmailFailed.run(email.id);
      }
    }
  }
}

// Retry failed emails every 60 seconds
setInterval(processEmailQueue, 60_000);

function sendNotificationEmail({ subject, text }) {
  queueEmail({ to: ADMIN_EMAIL, subject, text });
}

function sendCustomerConfirmation({ to, subject, text }) {
  queueEmail({ to, subject, text });
}

/* ------------------------------------------------------------------ */
/*  CSRF protection (double-submit cookie)                             */
/* ------------------------------------------------------------------ */

function ensureCsrfCookie(req, res, next) {
  const cookies = parseCookies(req);
  if (!cookies._csrf) {
    const token = crypto.randomBytes(24).toString('hex');
    const parts = [`_csrf=${token}`, 'Path=/', 'SameSite=Strict', 'Max-Age=86400'];
    if (APP_BASE_URL.startsWith('https://')) parts.push('Secure');
    appendCookie(res, parts.join('; '));
  }
  next();
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const cookies = parseCookies(req);
  const cookieToken = cookies._csrf;
  const headerToken = req.get('x-csrf-token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ ok: false, message: 'Invalid request token. Please refresh and try again.' });
  }
  next();
}

function appendCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  const all = existing ? (Array.isArray(existing) ? [...existing] : [existing]) : [];
  all.push(cookie);
  res.setHeader('Set-Cookie', all);
}

/* ------------------------------------------------------------------ */
/*  Express middleware                                                  */
/* ------------------------------------------------------------------ */

app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(securityHeaders);
app.use(enforceCanonicalHost);
app.use(ensureCsrfCookie);

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, smtpConfigured: Boolean(transporter), dbReady: true, s3Configured: Boolean(s3Client) });
});

app.use('/api', verifyTrustedRequest);
app.use('/api', csrfProtection);
app.use('/api/', rateLimit({ windowMs: 15 * 60 * 1000, max: 60 }));
app.use('/api/admin/request-code', rateLimit({ windowMs: 15 * 60 * 1000, max: 5 }));
app.use('/api/admin/verify-code', rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));
app.use('/api/order', rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));
app.use('/api/contact', rateLimit({ windowMs: 15 * 60 * 1000, max: 8 }));
app.use('/api/track/pageview', rateLimit({ windowMs: 1 * 60 * 1000, max: 30 }));

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
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
      res.setHeader('Surrogate-Control', 'no-store');
      res.setHeader('CDN-Cache-Control', 'no-store');
      res.setHeader('Cloudflare-CDN-Cache-Control', 'no-store');
    }
  },
}));

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

/* ------------------------------------------------------------------ */
/*  Order form                                                         */
/* ------------------------------------------------------------------ */

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

  const filenames = (req.files || []).map((f) => f.filename);
  const now = new Date().toISOString();

  const submission = {
    id: createId('ord'),
    type: 'order',
    status: 'new',
    createdAt: now,
    updatedAt: now,
    name: payload.name,
    email: payload.email,
    phone: payload.phone || '',
    apparel: payload.apparel || '',
    audience: payload.audience || '',
    quantity,
    deadline: payload.deadline || '',
    occasion: payload.occasion || '',
    subject: '',
    message: '',
    details: payload.details || '',
    attachments: JSON.stringify(filenames),
    notes: '',
  };

  sql.insertSubmission.run(submission);

  // Upload attachments to S3 in background
  for (const file of (req.files || [])) {
    uploadToS3(file.path, file.filename).catch(() => {});
  }

  sendNotificationEmail({
    subject: `New order request from ${submission.name}`,
    text: formatOrderEmail({ ...submission, attachments: filenames }),
  });

  sendCustomerConfirmation({
    to: submission.email,
    subject: 'Corazon Creative Co. received your order request',
    text: formatOrderConfirmationEmail(submission),
  });

  res.json({ ok: true, message: 'Order request sent successfully. Our team will follow up by email.' });
}));

/* ------------------------------------------------------------------ */
/*  Contact form                                                       */
/* ------------------------------------------------------------------ */

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

  const now = new Date().toISOString();

  const submission = {
    id: createId('msg'),
    type: 'contact',
    status: 'new',
    createdAt: now,
    updatedAt: now,
    name: payload.name,
    email: payload.email,
    phone: '',
    apparel: '',
    audience: '',
    quantity: 0,
    deadline: '',
    occasion: '',
    subject: payload.subject,
    message: payload.message,
    details: '',
    attachments: '[]',
    notes: '',
  };

  sql.insertSubmission.run(submission);

  sendNotificationEmail({
    subject: `New contact message from ${submission.name}`,
    text: formatContactEmail(submission),
  });

  sendCustomerConfirmation({
    to: submission.email,
    subject: 'Corazon Creative Co. received your message',
    text: formatContactConfirmationEmail(submission),
  });

  res.json({ ok: true, message: 'Message sent successfully. Our team will follow up by email.' });
}));

/* ------------------------------------------------------------------ */
/*  Admin auth                                                         */
/* ------------------------------------------------------------------ */

app.post('/api/admin/request-code', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();

  if (!email || email !== ADMIN_EMAIL) {
    return res.json({ ok: true, message: 'If that email is authorized, a sign-in code has been sent.' });
  }

  const code = String(crypto.randomInt(100000, 999999));
  const expiresAt = Date.now() + 15 * 60 * 1000;
  sql.setAuthPending.run({ codeHash: createHash(code), email, expiresAt });

  let devCode;

  if (transporter) {
    try {
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
    } catch (err) {
      console.error('Failed to send admin code email:', err.message);
      return res.status(503).json({ ok: false, message: 'Could not send sign-in email. Please try again.' });
    }
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

  const pending = sql.getAuthPending.get();

  if (!pending || !pending.code_hash || !pending.expires_at || Date.now() > pending.expires_at) {
    return res.status(400).json({ ok: false, message: 'The code has expired. Request a new one.' });
  }

  if (pending.email !== email || createHash(code) !== pending.code_hash) {
    sql.incrementAuthFails.run();
    const updated = sql.getAuthPending.get();
    if (updated.failed_attempts >= 5) {
      sql.clearAuthPending.run();
      return res.status(401).json({ ok: false, message: 'Too many failed attempts. Request a new code.' });
    }
    return res.status(401).json({ ok: false, message: 'Incorrect sign-in code.' });
  }

  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000;
  sql.clearAuthPending.run();
  sql.insertSession.run(token, email, expiresAt);

  setSessionCookie(res, token, expiresAt);
  res.json({ ok: true, message: 'Signed in successfully.' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  const token = getSessionToken(req);
  if (token) {
    sql.deleteSession.run(token);
  }
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/admin/me', requireAdmin, (_req, res) => {
  res.json({ ok: true, email: ADMIN_EMAIL });
});

/* ------------------------------------------------------------------ */
/*  Admin data                                                         */
/* ------------------------------------------------------------------ */

app.get('/api/admin/stats', requireAdmin, (_req, res) => {
  const stats = sql.submissionStats.get();
  res.json({ ok: true, stats });
});

app.get('/api/admin/submissions', requireAdmin, (_req, res) => {
  const rows = sql.allSubmissions.all().map(rowToSubmission);
  res.json({ ok: true, submissions: rows });
});

app.get('/api/admin/export', requireAdmin, (_req, res) => {
  const submissions = sql.allSubmissions.all().map(rowToSubmission);
  const posts = sql.allPosts.all().map(rowToPost);
  res.json({
    ok: true,
    data: { exportedAt: new Date().toISOString(), submissions, posts },
  });
});

app.patch('/api/admin/submissions/:id', requireAdmin, asyncHandler(async (req, res) => {
  const row = sql.findSubmission.get(req.params.id);
  if (!row) {
    return res.status(404).json({ ok: false, message: 'Submission not found.' });
  }

  const previousStatus = row.status;
  const nextStatus = String(req.body.status || '').trim();
  const nextNotes = typeof req.body.notes === 'string' ? req.body.notes.trim().slice(0, 4000) : row.notes;
  if (nextStatus && !ALLOWED_STATUSES.has(nextStatus)) {
    return res.status(400).json({ ok: false, message: 'Invalid submission status.' });
  }

  sql.updateSubmission.run({
    id: row.id,
    status: nextStatus || row.status,
    notes: nextNotes,
    updatedAt: new Date().toISOString(),
  });

  if (nextStatus && nextStatus !== previousStatus && row.email) {
    const statusEmail = formatStatusUpdateEmail(row, nextStatus);
    if (statusEmail) {
      sendCustomerConfirmation({
        to: row.email,
        subject: statusEmail.subject,
        text: statusEmail.text,
      });
    }
  }

  const updated = sql.findSubmission.get(req.params.id);
  res.json({ ok: true, submission: rowToSubmission(updated) });
}));

/* ------------------------------------------------------------------ */
/*  Order tracking                                                     */
/* ------------------------------------------------------------------ */

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

  const results = sql.submissionsByEmail.all(email).map((s) => ({
    id: s.id,
    type: s.type,
    status: s.status,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    apparel: s.apparel || null,
    quantity: s.quantity || null,
    subject: s.subject || null,
  }));

  res.json({ ok: true, submissions: results });
});

/* ------------------------------------------------------------------ */
/*  Seasonal themes                                                    */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Analytics                                                          */
/* ------------------------------------------------------------------ */

app.post('/api/track/pageview', (req, res) => {
  const p = String(req.body.path || '/').slice(0, 200);
  const referrer = String(req.body.referrer || '').slice(0, 500);
  const screen = String(req.body.screen || '').slice(0, 20);
  const ua = String(req.get('user-agent') || '').slice(0, 300);
  const ip = req.ip || '';

  const today = new Date().toISOString().slice(0, 10);
  const visitorHash = createHash(`${ip}:${ua}:${p}:${today}`).slice(0, 16);

  sql.insertAnalytics.run({
    ts: new Date().toISOString(),
    path: p,
    referrer: referrer ? safeHostname(referrer) : '',
    screen,
    visitorHash,
    day: today,
  });

  // Prune old data (> 90 days)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  sql.pruneOldAnalytics.run(cutoff);

  res.json({ ok: true });
});

app.get('/api/admin/analytics', requireAdmin, (_req, res) => {
  const now = new Date();
  const last30 = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const last7 = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const today = now.toISOString().slice(0, 10);

  const recent = sql.recentAnalytics.all(last30);

  const totalViews = recent.length;
  const todayViews = recent.filter((e) => e.day === today).length;
  const last7Views = recent.filter((e) => e.day >= last7).length;

  const uniqueAll = new Set(recent.map((e) => e.visitor_hash)).size;
  const uniqueToday = new Set(recent.filter((e) => e.day === today).map((e) => e.visitor_hash)).size;
  const unique7 = new Set(recent.filter((e) => e.day >= last7).map((e) => e.visitor_hash)).size;

  const pageCounts = {};
  recent.forEach((e) => { pageCounts[e.path] = (pageCounts[e.path] || 0) + 1; });
  const topPages = Object.entries(pageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([page, views]) => ({ page, views }));

  const refCounts = {};
  recent.filter((e) => e.referrer).forEach((e) => { refCounts[e.referrer] = (refCounts[e.referrer] || 0) + 1; });
  const topReferrers = Object.entries(refCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([source, views]) => ({ source, views }));

  const dailyViews = {};
  recent.forEach((e) => { dailyViews[e.day] = (dailyViews[e.day] || 0) + 1; });
  const viewsByDay = Object.entries(dailyViews)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, views]) => ({ day, views }));

  res.json({
    ok: true,
    analytics: {
      totalViews, todayViews, last7Views,
      uniqueVisitors: uniqueAll,
      uniqueToday, unique7,
      topPages, topReferrers, viewsByDay,
    },
  });
});

/* ------------------------------------------------------------------ */
/*  Blog CRUD                                                          */
/* ------------------------------------------------------------------ */

app.get('/api/admin/posts', requireAdmin, (_req, res) => {
  res.json({ ok: true, posts: sql.allPosts.all().map(rowToPost) });
});

app.post('/api/admin/posts', requireAdmin, (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 200);
  const body = String(req.body.body || '').trim().slice(0, 10000);
  if (!title || !body) {
    return res.status(400).json({ ok: false, message: 'Title and body are required.' });
  }

  const now = new Date().toISOString();
  const post = { id: createId('post'), title, body, createdAt: now, updatedAt: now, published: 0 };
  sql.insertPost.run(post);
  res.json({ ok: true, post: rowToPost(post) });
});

app.patch('/api/admin/posts/:id', requireAdmin, (req, res) => {
  const row = sql.findPost.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: 'Post not found.' });

  const title = typeof req.body.title === 'string' ? req.body.title.trim().slice(0, 200) : row.title;
  const body = typeof req.body.body === 'string' ? req.body.body.trim().slice(0, 10000) : row.body;
  const published = typeof req.body.published === 'boolean' ? (req.body.published ? 1 : 0) : row.published;

  sql.updatePost.run({ id: row.id, title, body, published, updatedAt: new Date().toISOString() });
  const updated = sql.findPost.get(req.params.id);
  res.json({ ok: true, post: rowToPost(updated) });
});

app.delete('/api/admin/posts/:id', requireAdmin, (req, res) => {
  const row = sql.findPost.get(req.params.id);
  if (!row) return res.status(404).json({ ok: false, message: 'Post not found.' });
  sql.deletePost.run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/posts', (_req, res) => {
  res.json({ ok: true, posts: sql.publishedPosts.all().map(rowToPost) });
});

/* ------------------------------------------------------------------ */
/*  Admin attachments                                                  */
/* ------------------------------------------------------------------ */

app.get('/api/admin/attachments/:filename', requireAdmin, asyncHandler(async (req, res) => {
  const filename = path.basename(req.params.filename);
  const localPath = path.join(UPLOADS_DIR, filename);

  // Try local first
  if (fs.existsSync(localPath)) {
    return res.sendFile(localPath);
  }

  // Try S3
  const s3Response = await getFromS3(filename);
  if (s3Response && s3Response.Body) {
    if (s3Response.ContentType) res.type(s3Response.ContentType);
    const chunks = [];
    for await (const chunk of s3Response.Body) { chunks.push(chunk); }
    return res.send(Buffer.concat(chunks));
  }

  return res.status(404).json({ ok: false, message: 'File not found.' });
}));

/* ------------------------------------------------------------------ */
/*  Stripe checkout stub                                               */
/* ------------------------------------------------------------------ */

app.post('/api/checkout', asyncHandler(async (req, res) => {
  if (!STRIPE_SECRET_KEY) {
    return res.status(503).json({ ok: false, message: 'Online payments are not configured yet. Please use the order form to request a custom quote.' });
  }

  res.status(503).json({ ok: false, message: 'Checkout is coming soon.' });
}));

/* ------------------------------------------------------------------ */
/*  Sitemap and robots                                                 */
/* ------------------------------------------------------------------ */

app.get('/sitemap.xml', (_req, res) => {
  const pages = ['', '/track', '/sizes', '/blog', '/privacy', '/terms'];
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

/* ------------------------------------------------------------------ */
/*  404 + error handlers                                               */
/* ------------------------------------------------------------------ */

app.use((req, res, next) => {
  if (req.method === 'GET' && PUBLIC_FILES.has(path.basename(req.path))) {
    return next();
  }

  if (req.method === 'GET' && req.path === '/') {
    return next();
  }

  if (req.method === 'GET' && req.accepts('html')) {
    return res.status(404).sendFile(path.join(__dirname, '404.html'));
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

/* ------------------------------------------------------------------ */
/*  Row mappers (SQLite snake_case → camelCase for API compatibility)   */
/* ------------------------------------------------------------------ */

function rowToSubmission(row) {
  if (!row) return null;
  let attachments = [];
  try { attachments = JSON.parse(row.attachments || '[]'); } catch (_e) { /* */ }
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    email: row.email,
    phone: row.phone || '',
    apparel: row.apparel || '',
    audience: row.audience || '',
    quantity: row.quantity || 0,
    deadline: row.deadline || '',
    occasion: row.occasion || '',
    subject: row.subject || '',
    message: row.message || '',
    details: row.details || '',
    attachments,
    notes: row.notes || '',
  };
}

function rowToPost(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.created_at || row.createdAt,
    updatedAt: row.updated_at || row.updatedAt,
    published: row.published === 1 || row.published === true,
  };
}

/* ------------------------------------------------------------------ */
/*  JSON → SQLite migration (runs once on first boot with existing DB) */
/* ------------------------------------------------------------------ */

function migrateJsonToSqlite() {
  // Migrate store.json
  if (fs.existsSync(STORE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(STORE_FILE, 'utf8'));

      const existingCount = db.prepare(`SELECT COUNT(*) as cnt FROM submissions`).get().cnt;
      if (existingCount === 0 && Array.isArray(raw.submissions) && raw.submissions.length > 0) {
        console.log(`Migrating ${raw.submissions.length} submissions from store.json to SQLite...`);
        const insertMany = db.transaction((items) => {
          for (const s of items) {
            sql.insertSubmission.run({
              id: s.id,
              type: s.type || 'order',
              status: s.status || 'new',
              createdAt: s.createdAt || new Date().toISOString(),
              updatedAt: s.updatedAt || new Date().toISOString(),
              name: s.name || '',
              email: s.email || '',
              phone: s.phone || '',
              apparel: s.apparel || '',
              audience: s.audience || '',
              quantity: Number(s.quantity) || 0,
              deadline: s.deadline || '',
              occasion: s.occasion || '',
              subject: s.subject || '',
              message: s.message || '',
              details: s.details || '',
              attachments: JSON.stringify(s.attachments || []),
              notes: s.notes || '',
            });
          }
        });
        insertMany(raw.submissions);
      }

      const postCount = db.prepare(`SELECT COUNT(*) as cnt FROM posts`).get().cnt;
      if (postCount === 0 && Array.isArray(raw.posts) && raw.posts.length > 0) {
        console.log(`Migrating ${raw.posts.length} posts from store.json to SQLite...`);
        const insertPosts = db.transaction((items) => {
          for (const p of items) {
            sql.insertPost.run({
              id: p.id,
              title: p.title || '',
              body: p.body || '',
              createdAt: p.createdAt || new Date().toISOString(),
              updatedAt: p.updatedAt || new Date().toISOString(),
              published: p.published ? 1 : 0,
            });
          }
        });
        insertPosts(raw.posts);
      }

      // Archive the old file
      fs.renameSync(STORE_FILE, STORE_FILE + '.migrated');
      console.log('store.json migrated and archived as store.json.migrated');
    } catch (err) {
      console.error('JSON migration error (store.json):', err.message);
    }
  }

  // Migrate analytics.json
  if (fs.existsSync(ANALYTICS_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(ANALYTICS_FILE, 'utf8'));
      const existingAnalytics = db.prepare(`SELECT COUNT(*) as cnt FROM analytics`).get().cnt;
      if (existingAnalytics === 0 && Array.isArray(raw) && raw.length > 0) {
        console.log(`Migrating ${raw.length} analytics entries to SQLite...`);
        const insertBatch = db.transaction((items) => {
          for (const e of items) {
            sql.insertAnalytics.run({
              ts: e.ts || new Date().toISOString(),
              path: e.path || '/',
              referrer: e.referrer || '',
              screen: e.screen || '',
              visitorHash: e.vh || '',
              day: e.day || new Date().toISOString().slice(0, 10),
            });
          }
        });
        insertBatch(raw);
      }
      fs.renameSync(ANALYTICS_FILE, ANALYTICS_FILE + '.migrated');
      console.log('analytics.json migrated and archived as analytics.json.migrated');
    } catch (err) {
      console.error('JSON migration error (analytics.json):', err.message);
    }
  }
}

/* ------------------------------------------------------------------ */
/*  Seed blog posts (if empty)                                         */
/* ------------------------------------------------------------------ */

function seedBlogPosts() {
  const count = sql.countPosts.get().cnt;
  if (count > 0) return;

  console.log('Seeding starter blog posts...');
  const now = new Date();
  const posts = [
    {
      id: createId('post'),
      title: 'How a Custom Apparel Order Works',
      body: 'Ordering custom apparel with Corazon Creative Co. is simple. Start by filling out the order form on our website with your garment type, quantity, and design idea. You do not need a finished design — a rough concept, a message, or even just an occasion is enough to get started.\n\nAfter you submit, our team reviews the request and follows up to discuss details like sizing, colors, and layout. Once everything is confirmed, we send a design proof for your approval before production begins.\n\nMost orders take about 2–3 weeks from confirmation. Rush turnaround is available on request. Whether it is one special piece or a coordinated set for your whole team, every order gets personal attention from start to finish.',
      createdAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString(),
      published: 1,
    },
    {
      id: createId('post'),
      title: 'Custom Group Orders — Teams, Ministries, and Events',
      body: 'Group orders are one of the most popular things we do. Whether you are coordinating matching shirts for a church retreat, branded apparel for your business team, or custom pieces for a family reunion, we make it easy.\n\nHere is how it works: submit a single order with the total quantity and any details about sizes or variations. We will work with you to finalize the design and get everyone covered.\n\nWe have handled orders for youth groups, small businesses, wedding parties, school clubs, and nonprofit events. No minimum order required — whether it is 5 shirts or 50, every project gets the same care and attention to detail.',
      createdAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
      published: 1,
    },
    {
      id: createId('post'),
      title: 'Why Custom Apparel Makes the Perfect Gift',
      body: 'Looking for a gift that actually means something? Custom apparel lets you turn an inside joke, a meaningful verse, a nickname, or a shared memory into something wearable.\n\nSome of our favorite projects have been birthday shirts for milestone celebrations, matching sweaters for best friends, encouraging designs for someone going through a tough season, and custom pieces for new parents or graduates.\n\nThe best part is how easy it is. Just tell us the occasion and the vibe you are going for, and we will design something thoughtful. You can even upload reference images or inspiration photos with your order.\n\nGifts that are personal, comfortable, and made with care — that is what Corazon Creative Co. is all about.',
      createdAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000).toISOString(),
      published: 1,
    },
  ];

  const insertPosts = db.transaction((items) => {
    for (const p of items) sql.insertPost.run(p);
  });
  insertPosts(posts);
  console.log(`Seeded ${posts.length} blog posts.`);
}

/* ------------------------------------------------------------------ */
/*  Helper functions                                                   */
/* ------------------------------------------------------------------ */

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

function createTransporter() {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS) {
    return null;
  }

  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function sanitizeSubmission(body) {
  const data = {};
  for (const [key, value] of Object.entries(body)) {
    if (key === '_honey' || key === '_csrf') continue;
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

function createId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function createHash(value) {
  return crypto.createHash('sha256').update(`${value}:${SESSION_SECRET}`).digest('hex');
}

function safeHostname(url) {
  try {
    return new URL(url).hostname || '';
  } catch (_e) {
    return '';
  }
}

/* ------------------------------------------------------------------ */
/*  Security middleware                                                 */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Cookie / session helpers                                           */
/* ------------------------------------------------------------------ */

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

  appendCookie(res, parts.join('; '));
}

function clearSessionCookie(res) {
  appendCookie(res, 'corazon_admin_session=; HttpOnly; Path=/; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
}

function requireAdmin(req, res, next) {
  const token = getSessionToken(req);
  if (!token) {
    return res.status(401).json({ ok: false, message: 'Authentication required.' });
  }

  sql.pruneExpiredSessions.run(Date.now());

  const session = sql.findSession.get(token);
  if (!session || Date.now() > session.expires_at || session.email !== ADMIN_EMAIL) {
    if (session) sql.deleteSession.run(token);
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

/* ------------------------------------------------------------------ */
/*  Email formatters                                                   */
/* ------------------------------------------------------------------ */

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

  const attachments = Array.isArray(submission.attachments) ? submission.attachments : [];
  if (attachments.length > 0) {
    lines.push('', `Attachments: ${attachments.length} file(s) uploaded`);
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
    'Thank you for your order request with Corazon Creative Co.! We have received your details and will follow up with you soon to discuss your design, sizing, and next steps.',
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
    'Thank you for reaching out to Corazon Creative Co.! We have received your message and will get back to you as soon as possible.',
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
    body: 'Your request has been reviewed and we will be reaching out soon to discuss the details.',
  },
  'in-design': {
    subject: 'Your design is in progress — Corazon Creative Co.',
    body: 'Great news! Your design is now in progress. We\'ll follow up with proofs or questions as things take shape.',
  },
  'in-production': {
    subject: 'Your order is in production — Corazon Creative Co.',
    body: 'Your apparel is now in production! We will let you know when everything is ready.',
  },
  completed: {
    subject: 'Your order is complete — Corazon Creative Co.',
    body: 'Your order is complete and ready! We will reach out with pickup or delivery details.',
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

/* ------------------------------------------------------------------ */
/*  Graceful shutdown                                                  */
/* ------------------------------------------------------------------ */

process.on('SIGTERM', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down...');
  db.close();
  process.exit(0);
});
