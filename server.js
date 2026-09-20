const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const Parser = require('rss-parser');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const parser = new Parser({ timeout: 12000 });

// Staging is for previewing: seed a couple of obviously fake feeds so the
// app is reviewable on an empty database. Production does nothing here.
const IS_STAGING = process.env.USERNODE_ENV === 'staging';

const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

const PUBLIC_API_PATHS = new Set(['/health']);
// Staging demo identity: the 900001 rows seeded at boot belong to this fake
// id, and the same id is used when a reviewer hits the app without an
// iframe token (a tokenless staging load). Production never takes this
// branch: it requires a real, verified token for every API request.
const STAGING_DEMO_USER_ID = 900001;
// A tiny SVG data URI used as the thumbnail on staged items so previews can
// exercise the thumbnail layout without any remote image.
const STAGING_THUMB = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='12' fill='%230ea5e9'/%3E%3Ccircle cx='32' cy='32' r='13' fill='white'/%3E%3C/svg%3E";
// Staging-only demo data lives behind this query flag so a preview reviewer
// can see the list populated without touching production data. Gated on
// IS_STAGING; the plain route stays honest and returns a real user's rows.
const DEMO_SEED_SQL = `
  INSERT INTO feeds (user_id, url, title, description, color, status, last_error, icon_url)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  ON CONFLICT (user_id, url) DO NOTHING
`;

app.use(express.json({ limit: '256kb' }));

// Centrally hosted platform files (bridge / native kit / Tailwind runtime),
// reachable on this app's own origin. No hostname is baked in here: the
// platform's edge answers these in every real deployment, and this handler
// covers a plain `node server.js`.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify the platform-issued iframe JWT, then deny-by-default for every
// non-GET request and every /api/* request.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (IS_STAGING && !req.user) req.user = { id: STAGING_DEMO_USER_ID, username: 'staging-demo-user' };
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => {
  if (shuttingDown) return res.status(503).json({ status: 'draining' });
  res.json({ status: 'ok' });
});

app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uid = () => crypto.randomBytes(12).toString('hex');
const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');

function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function hostOf(link) {
  try { return new URL(link).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function titleFromHtml(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html || ''));
  return m ? stripHtml(m[1]) : '';
}

// Pull the most specific image for an item: the enclosure, media tags, then
// the first <img> in the content. Only http(s) URLs are accepted.
function extractThumb(p) {
  const candidates = [];
  if (p.enclosure && p.enclosure.url) candidates.push(p.enclosure.url);
  const mediaList = Array.isArray(p['media:content'])
    ? p['media:content']
    : (p['media:content'] ? [p['media:content']] : []);
  for (const m of mediaList) {
    if (m && m.url) candidates.push(m.url);
    const nested = m && m['media:thumbnail'];
    const nestedList = Array.isArray(nested) ? nested : (nested ? [nested] : []);
    for (const t of nestedList) { if (t && t.url) candidates.push(t.url); }
  }
  const thumbs = p['media:thumbnail'];
  for (const t of (Array.isArray(thumbs) ? thumbs : (thumbs ? [thumbs] : []))) {
    if (t && t.url) candidates.push(t.url);
  }
  const html = p['content:encoded'] || p.content || p.summary || '';
  const m = /<img[^>]+src=["']?([^"'\s>]+)/i.exec(String(html));
  if (m) candidates.push(m[1]);
  for (const c of candidates) {
    try {
      const u = new URL(String(c).trim());
      if (u.protocol === 'https:' || u.protocol === 'http:') return u.href;
    } catch {}
  }
  return '';
}

// Item summaries are stored as HTML so the article preview can show
// paragraphs and images. Scripts and inline event handlers are removed
// before anything is stored.
function sanitizeSummary(html) {
  let out = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+="[^"]*"/gi, '')
    .replace(/\son[a-z]+='[^']*'/gi, '')
    .replace(/href="\s*javascript:[^"]*"/gi, 'href="#"')
    .replace(/href='\s*javascript:[^']*'/gi, "href='#'");
  if (out.length > 20000) out = out.slice(0, 20000);
  return out;
}

async function fetchText(url, timeoutMs) {
  const res = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'User-Agent': 'HomeroomRSSReader/1.0 (+https://onhomeroom.com)' },
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  const text = await res.text();
  return text.slice(0, 5_000_000);
}

function faviconOf(url) {
  try {
    const u = new URL(url);
    return 'https://icons.duckduckgo.com/ip3/' + u.hostname + '.ico';
  } catch { return ''; }
}

const FEED_COLORS = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];

async function fetchParsedFeed(url) {
  const text = await fetchText(url, 15000);
  const looksLikeFeed = /<rss|<feed|<rdf/i.test(text.slice(0, 1000));
  if (!looksLikeFeed) throw new Error('Not a feed');
  const parsed = await parser.parseString(text);
  return parsed;
}

function parseFeedMeta(parsed, url) {
  const meta = parsed.feed || {};
  const image = meta.image && (meta.image.url || meta.image.link) || '';
  return {
    title: stripHtml(meta.title || '') || hostOf(url) || 'Untitled feed',
    description: stripHtml(meta.description || ''),
    site_url: meta.link || '',
    icon_url: typeof image === 'string' && image ? image : faviconOf(url),
  };
}

function itemFromParsed(p, feedId) {
  const link = String(p.link || '').trim();
  const title = stripHtml(p.title || '') || titleFromHtml(p['content:encoded'] || p.content || '') || 'Untitled';
  const summary = sanitizeSummary(
    p['content:encoded'] || p.content || p.summary || p.contentSnippet || ''
  );
  const guidSeed = p.guid || p.id || link || (title + '|' + (p.isoDate || p.pubDate || ''));
  const published = p.isoDate || p.pubDate || null;
  return {
    feed_id: feedId,
    guid: sha1(guidSeed),
    link,
    title: title.slice(0, 500),
    summary,
    thumb_url: extractThumb(p),
    author: stripHtml(p.creator || p.author || ''),
    published: published && !isNaN(Date.parse(published)) ? new Date(published) : null,
  };
}

// ---------------------------------------------------------------------------
// Tables. Feeds and items are per-user reading state: they are marked
// staging:private so a staging preview starts empty and gets fake rows below.
// ---------------------------------------------------------------------------

const BOOT_SQL = `
  CREATE TABLE IF NOT EXISTS feeds (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT 'Untitled feed',
    description TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',
    icon_url TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#7c3aed',
    status TEXT NOT NULL DEFAULT 'ok',
    last_error TEXT NOT NULL DEFAULT '',
    last_fetched TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, url)
  );
  CREATE TABLE IF NOT EXISTS items (
    id SERIAL PRIMARY KEY,
    feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    guid TEXT NOT NULL,
    link TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    author TEXT NOT NULL DEFAULT '',
    published TIMESTAMPTZ,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    bookmarked BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, guid)
  );
  CREATE INDEX IF NOT EXISTS items_user_published_idx ON items (user_id, published DESC);
  ALTER TABLE items ADD COLUMN IF NOT EXISTS thumb_url TEXT NOT NULL DEFAULT '';
  COMMENT ON TABLE feeds IS 'staging:private';
  COMMENT ON TABLE items IS 'staging:private';
`;

async function ensureSchema() {
  await pool.query(BOOT_SQL);
}

async function seedStaging() {
  if (!IS_STAGING) return;
  const demoFeeds = [
    ['https://staging-demo.invalid/krios.xml', '#0ea5e9', 'Staging demo feed Krios'],
    ['https://staging-demo.invalid/hawley.xml', '#f59e0b', 'Staging demo feed Hawley'],
  ];
  for (const [url, color, title] of demoFeeds) {
    await pool.query(
      `INSERT INTO feeds (user_id, url, title, description, color, status, last_error, icon_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (user_id, url) DO NOTHING`,
      [900001, url, title,
       'Fake rows seeded for staging previews only', color, 'ok',
       '', faviconOf(url)]
    );
  }
  const { rows } = await pool.query(
    `INSERT INTO items (feed_id, user_id, guid, link, title, summary, thumb_url, published, read, bookmarked)
     SELECT f.id, f.user_id, 'staging-demo-item-' || n.n, f.url || '#item-' || n.n, 'Staging demo item ' || n.n,
            '<p>Seeded preview content for the RSS reader. This item is fake and belongs to a demo feed.</p>',
            $1,
            NOW() - (n.n * interval '1 hour'), n.n > 2, n.n = 4
     FROM feeds f, generate_series(1, 6) AS n(n)
     WHERE f.url LIKE 'https://staging-demo.invalid/%'
     ON CONFLICT (user_id, guid) DO NOTHING`,
    [STAGING_THUMB]
  );
  if (rows.length) console.log('[staging] seeded demo feeds/items');
}

// Request-time demo seeding for a staging reviewer: seed a couple of demo
// rows for the CALLING user only behind IS_STAGING && ?demo=1. In production
// this is a no-op (the guard short-circuits before any query runs).
app.get('/api/demo-items', async (req, res) => {
  if (!IS_STAGING || req.query.demo !== '1') return res.json({ seeded: false });
  try {
    const uid2 = req.user.id;
    await pool.query(DEMO_SEED_SQL, [
      uid2,
      'https://staging-demo.invalid/' + uid2 + '.xml',
      'Staging demo feed ' + uid2,
      'Fake rows seeded for staging previews only',
      '#0ea5e9',
      'ok',
      '',
      faviconOf('https://staging-demo.invalid'),
    ]);
    const feedRow = await pool.query(
      `SELECT id FROM feeds WHERE user_id = $1 ORDER BY id DESC LIMIT 1`,
      [uid2]
    );
    if (feedRow.rowCount) {
      await pool.query(
        `INSERT INTO items (feed_id, user_id, guid, link, title, summary, thumb_url, published, read)
         SELECT $1, $2, 'staging-demo-user-item-' || n.n, '', 'Staging demo item ' || n.n,
                '<p>Seeded preview content for the RSS reader. This item is fake and belongs to a demo feed.</p>',
                $3,
                NOW() - (n.n * interval '1 hour'), n.n > 4
         FROM generate_series(1, 6) AS n(n)
         ON CONFLICT (user_id, guid) DO NOTHING`,
        [feedRow.rows[0].id, uid2, STAGING_THUMB]
      );
    }
    return res.json({ seeded: true });
  } catch (err) { return res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function refreshFeed(feedRow) {
  try {
    const parsed = await fetchParsedFeed(feedRow.url);
    const meta = parseFeedMeta(parsed, feedRow.url);
    await pool.query(
      `UPDATE feeds
         SET title = $2, description = $3, site_url = $4, icon_url = $5,
             status = 'ok', last_error = '', last_fetched = NOW()
       WHERE id = $1`,
      [feedRow.id, meta.title, meta.description, meta.site_url, meta.icon_url]
    );
    let newCount = 0;
    for (const p of (parsed.items || []).slice(0, 50)) {
      const it = itemFromParsed(p, feedRow.id);
      if (!it.guid) continue;
      const inserted = await pool.query(
        `INSERT INTO items (feed_id, user_id, guid, link, title, summary, thumb_url, author, published)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (user_id, guid) DO NOTHING
         RETURNING id`,
        [it.feed_id, feedRow.user_id, it.guid, it.link, it.title, it.summary, it.thumb_url, it.author, it.published]
      );
      if (inserted.rowCount) newCount += inserted.rowCount;
    }
    return { ok: true, newCount };
  } catch (err) {
    await pool.query(
      `UPDATE feeds SET status = 'error', last_error = $2, last_fetched = NOW() WHERE id = $1`,
      [feedRow.id, String(err.message || err).slice(0, 300)]
    );
    return { ok: false, error: String(err.message || err) };
  }
}

function normalizeFeedUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return null;
  if (!/^[a-z]+:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.href;
  } catch { return null; }
}

app.get('/api/feeds', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT f.*,
              (SELECT COUNT(*)::int FROM items i WHERE i.feed_id = f.id AND i.read = FALSE) AS unread
       FROM feeds f
       WHERE f.user_id = $1
       ORDER BY f.title COLLATE "C" ASC`,
      [req.user.id]
    );
    res.json({ feeds: rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/feeds', async (req, res) => {
  try {
    const url = normalizeFeedUrl(req.body && req.body.url);
    if (!url) return res.status(400).json({ error: 'Enter a valid feed URL' });
    const existing = await pool.query(
      `SELECT id FROM feeds WHERE user_id = $1 AND url = $2`,
      [req.user.id, url]
    );
    if (existing.rowCount) {
      return res.status(409).json({ error: 'That feed is already in your list' });
    }
    const color = FEED_COLORS[(req.user.id + url.length) % FEED_COLORS.length];
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, color) VALUES ($1, $2, $3) RETURNING *`,
      [req.user.id, url, color]
    );
    const feed = inserted.rows[0];
    const result = await refreshFeed(feed);
    const { rows } = await pool.query(`SELECT * FROM feeds WHERE id = $1`, [feed.id]);
    const unreadRow = await pool.query(
      `SELECT COUNT(*)::int AS unread FROM items WHERE feed_id = $1 AND read = FALSE`,
      [feed.id]
    );
    const saved = { ...rows[0], unread: unreadRow.rows[0].unread };
    if (result.ok) return res.status(201).json({ feed: saved, newCount: result.newCount });
    return res.status(201).json({ feed: saved, newCount: 0, warning: 'Saved, but the feed could not be read: ' + result.error });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/feeds/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad feed id' });
    const del = await pool.query(
      `DELETE FROM feeds WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!del.rowCount) return res.status(404).json({ error: 'Feed not found' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/feeds/:id/refresh', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad feed id' });
    const { rows } = await pool.query(
      `SELECT * FROM feeds WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Feed not found' });
    const result = await refreshFeed(rows[0]);
    const unreadRow = await pool.query(
      `SELECT COUNT(*)::int AS unread FROM items WHERE feed_id = $1 AND read = FALSE`,
      [id]
    );
    const { rows: after } = await pool.query(`SELECT * FROM feeds WHERE id = $1`, [id]);
    res.json({ ok: result.ok, feed: { ...after[0], unread: unreadRow.rows[0].unread }, error: result.error || '' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/items', async (req, res) => {
  try {
    const filter = req.query.filter === 'all' ? 'all' : 'unread';
    const limit = Math.min(parseInt(req.query.limit, 10) || 200, 500);
    const { rows } = await pool.query(
      `SELECT i.id, i.feed_id, i.link, i.title, i.summary, i.thumb_url, i.author, i.published,
              i.read, i.bookmarked, f.title AS feed_title, f.color AS feed_color, f.icon_url
       FROM items i
       JOIN feeds f ON f.id = i.feed_id
       WHERE i.user_id = $1
         AND ($2::text = 'all' OR i.read = FALSE)
       ORDER BY i.published DESC NULLS LAST, i.id DESC
       LIMIT $3`,
      [req.user.id, filter, limit]
    );
    const countRow = await pool.query(
      `SELECT COUNT(*)::int AS unread FROM items WHERE user_id = $1 AND read = FALSE`,
      [req.user.id]
    );
    res.json({ items: rows, unreadTotal: countRow.rows[0].unread });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items/:id/read', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad item id' });
    await pool.query(
      `UPDATE items SET read = TRUE WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items/:id/unread', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad item id' });
    await pool.query(
      `UPDATE items SET read = FALSE WHERE id = $1 AND user_id = $2`,
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/items/:id/bookmark', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Bad item id' });
    const { rows } = await pool.query(
      `UPDATE items SET bookmarked = NOT bookmarked WHERE id = $1 AND user_id = $2 RETURNING bookmarked`,
      [id, req.user.id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json({ bookmarked: rows[0].bookmarked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/read-all', async (req, res) => {
  try {
    const upd = await pool.query(
      `UPDATE items SET read = TRUE WHERE user_id = $1 AND read = FALSE`,
      [req.user.id]
    );
    res.json({ ok: true, updated: upd.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------------------------------------------------------------------------
// Static shell
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  if (!req.user) {
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/rss-reader-4113da/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/rss-reader-4113da/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let shuttingDown = false;

async function start() {
  await ensureSchema();
  await seedStaging();
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  server.keepAliveTimeout = 75_000;

  const DRAIN_MS = 3000;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[shutdown] ${signal} received, draining`);
    server.close(() => {});
    server.closeIdleConnections?.();
    const t = setTimeout(() => server.closeAllConnections?.(), DRAIN_MS);
    t.unref?.();
    try { await pool.end(); } catch (err) {
      console.error('[shutdown] pool.end failed', err.message);
    }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch(err => { console.error(err); process.exit(1); });
