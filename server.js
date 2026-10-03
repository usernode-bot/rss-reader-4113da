const express = require('express');
const path = require('path');
const dns = require('dns').promises;
const net = require('net');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const port = process.env.PORT || 3000;
const pool = new Pool({ connectionString: process.env.DATABASE_URL });

// The platform signs user-identity tokens with an RSA private key it never
// shares. Containers get only the PUBLIC half, so this app can verify who a
// user is but cannot mint an identity — and neither can any other app.
const JWT_PUBLIC_KEY = (process.env.USERNODE_JWT_PUBLIC_KEY || '')
  .replace(/\\n/g, '\n');

// Tokens are minted for one app: the audience is this app's numeric id, so a
// token issued for a different app is rejected below rather than accepted as
// a valid user.
const APP_AUDIENCE = process.env.USERNODE_APP_ID
  ? 'usernode:app:' + process.env.USERNODE_APP_ID
  : null;

// Paths that stay open without authentication. Add a path here (and add it
// with `app.get`/`app.post` below) if you deliberately want it public.
// Everything else requires a valid platform-issued JWT.
const PUBLIC_API_PATHS = new Set(['/health']);

app.use(express.json());

// The platform's three centrally hosted files — the bridge, the native UI
// kit and the Tailwind runtime — are reachable at these paths on this app's
// OWN origin, so index.html can load them with a RELATIVE path and never
// name the platform's hostname. A hostname baked into an app is what breaks
// every app at once when the platform's domain moves.
//
// In production and on a staging preview the platform's edge answers these
// before the request ever reaches this process (a per-app Ingress rule on
// Kubernetes, the wildcard site's matcher on the docker runtime). This
// handler is what makes the same relative paths work under a plain
// `node server.js`, where there is no edge in front of the app at all.
//
// Registered BEFORE the auth middleware because these three files are
// public: the platform serves them anonymously from any app origin, and a
// login redirect arriving where a <script> was expected is exactly the
// failure a relative path is meant to avoid.
// The platform's origin, at RUNTIME, and ONLY from the variable the platform
// injects. No hostname is written into this file: a baked-in one is what left
// the whole fleet pointing at a domain the platform had moved away from.
// Unset only outside the platform (a plain local `node server.js`) — set
// USERNODE_PLATFORM_ORIGIN there too if you want the hosted assets locally.
const PLATFORM_ORIGIN = (process.env.USERNODE_PLATFORM_ORIGIN || '')
  .replace(/\/+$/, '');

app.get(/^\/usernode-(?:bridge|native|tailwind)\//, async (req, res) => {
  try {
    if (!PLATFORM_ORIGIN) return res.sendStatus(503);
    const upstream = await fetch(PLATFORM_ORIGIN + req.path);
    if (!upstream.ok) return res.sendStatus(upstream.status);
    const type = upstream.headers.get('content-type');
    if (type) res.type(type);
    // max-age=0 with revalidation, never a long TTL: the whole point of
    // central hosting is that a platform-side fix lands on the next load.
    res.set('Cache-Control', 'public, max-age=0, must-revalidate');
    return res.send(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    console.warn('hosted asset fetch failed: ' + err.message);
    return res.sendStatus(502);
  }
});

// Verify platform-issued JWT if one was passed, then enforce auth on
// anything not explicitly marked public. The iframe adds `?token=…`
// on load; the frontend script forwards the token via `x-usernode-token`
// on subsequent fetches.
app.use((req, res, next) => {
  const token = req.query.token || req.headers['x-usernode-token'];
  if (token && JWT_PUBLIC_KEY && APP_AUDIENCE) {
    try {
      // Pin the algorithm, issuer and audience. Without `algorithms` a
      // caller could hand us an HS256 token signed with the public PEM
      // (which every app knows) and forge any user.
      const claims = jwt.verify(token, JWT_PUBLIC_KEY, {
        algorithms: ['RS256'],
        issuer: 'usernode',
        audience: APP_AUDIENCE,
      });
      // `pur` names what the token is for. Only user-identity tokens
      // authenticate a person here.
      if (claims && claims.pur === 'iframe') req.user = claims;
    } catch {}
  }

  // Static assets (CSS/JS/images) are always served; the API and the HTML
  // shell are gated so direct hits to the staging/prod subdomain don't
  // leak app data to the public internet.
  if (req.method !== 'GET' || req.path.startsWith('/api/')) {
    if (PUBLIC_API_PATHS.has(req.path)) return next();
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
});

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// The template ships no favicon file; index.html carries an inline SVG
// icon instead. Answer 204 here so anything that still probes
// /favicon.ico (older browsers, direct visits) doesn't fall through to
// the auth-gated catch-all and surface a 401 in the console on every
// fresh load.
app.get('/favicon.ico', (_req, res) => res.status(204).end());

// ── RSS feeds ────────────────────────────────────────────────────────────
//
// The server fetches public RSS/Atom URLs on demand and parses them with
// built-in code — no feed library. Feed text is THIRD-PARTY INPUT: it is
// stripped to plain text before storing, and the frontend renders every
// feed-derived string with textContent, never innerHTML.

const FEED_FETCH_TIMEOUT_MS = 10_000;
const MAX_FEED_BYTES = 2 * 1024 * 1024; // ~2 MB response cap
const MAX_POSTS_PER_REFRESH = 200; // how many items a single fetch stores
const MAX_SUMMARY_CHARS = 5000;

// A feed URL is user-supplied input that the server fetches: keep it pointed
// at the public internet. Resolve the hostname and refuse loopback, private,
// link-local (incl. cloud metadata) and reserved ranges, on every redirect
// hop (redirects are followed manually below so each hop is checked).
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  const low = ip.toLowerCase();
  if (low === '::1' || low === '::') return true;
  if (low.startsWith('::ffff:')) return isPrivateIp(low.slice(7));
  return /^(fe[89ab]|f[cd]|ff)/.test(low);
}

async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('that address is not a public host');
    return;
  }
  const addrs = await dns.lookup(hostname, { all: true });
  if (!addrs.length) throw new Error('that host could not be resolved');
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new Error('that address is not a public host');
  }
}

// Fetch a feed over https with a timeout and a response-size cap, following
// up to 4 redirects manually so every hop is re-validated.
async function fetchFeed(url) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== 'https:') throw new Error('only https:// feed URLs are supported');
    await assertPublicHost(parsed.hostname);

    const res = await fetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(FEED_FETCH_TIMEOUT_MS),
      headers: {
        'user-agent': 'RSSReader/1.0 (+Homeroom app)',
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      res.body?.cancel();
      if (!location) throw new Error('the server redirected without a destination');
      current = new URL(location, current).href;
      continue;
    }
    if (!res.ok) throw new Error('the server answered with HTTP ' + res.status);
    if (!res.body) throw new Error('the server sent an empty response');

    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_FEED_BYTES) {
        reader.cancel();
        throw new Error('the response was too large to read');
      }
      chunks.push(Buffer.from(value));
    }
    const type = res.headers.get('content-type') || '';
    const charset = (type.match(/charset=([\w-]+)/i) || [])[1];
    return new TextDecoder(charset || 'utf-8').decode(Buffer.concat(chunks));
  }
  throw new Error('too many redirects');
}

// Extract the text content of the first <tag>…</tag> in an XML fragment,
// unwrapping a CDATA section when present.
function tagContent(xml, tag) {
  const m = xml.match(new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '>', 'i'));
  if (!m) return '';
  const cdata = m[1].match(/^\s*<!\[CDATA\[([\s\S]*)\]\]>\s*$/);
  return cdata ? cdata[1] : m[1];
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

// Feed text is stripped to plain text: decode entities FIRST (so an encoded
// "<b>" does not survive as a literal tag in stored text), then drop tags.
function cleanText(s) {
  if (!s) return '';
  return decodeEntities(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s.trim());
  return isNaN(d.getTime()) ? null : d;
}

// Atom links are attributes on a (usually self-closing) <link>; prefer one
// with no rel or rel="alternate" and skip rel="self"/"edit"/…
function atomLink(entryXml) {
  for (const m of entryXml.matchAll(/<link\b([^>]*?)>/gi)) {
    const attrs = m[1];
    const rel = (attrs.match(/rel\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (rel && rel !== 'alternate') continue;
    const href = (attrs.match(/href\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (href) return href;
  }
  return '';
}

function parseFeed(xml) {
  const title = cleanText(tagContent(xml, 'title'));
  const items = [];
  const rssItems = xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi);
  const atomEntries = xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/gi);
  for (const m of [...rssItems, ...atomEntries]) {
    const raw = m[1];
    const isAtom = /^\s*<entry\b/i.test(m[0]);
    const link = cleanText(isAtom ? atomLink(raw) : tagContent(raw, 'link'));
    const item = {
      guid:
        cleanText(tagContent(raw, isAtom ? 'id' : 'guid')) ||
        link ||
        cleanText(tagContent(raw, 'title')) ||
        crypto.createHash('sha1').update(raw).digest('hex'),
      title: cleanText(tagContent(raw, 'title')).slice(0, 500) || null,
      url: /^https?:\/\//i.test(link) ? link : null,
      published: parseDate(
        isAtom
          ? tagContent(raw, 'published') || tagContent(raw, 'updated')
          : tagContent(raw, 'pubDate') || tagContent(raw, 'dc:date')
      ),
      summary: cleanText(
        isAtom
          ? tagContent(raw, 'summary') || tagContent(raw, 'content')
          : tagContent(raw, 'description') || tagContent(raw, 'content:encoded')
      ).slice(0, MAX_SUMMARY_CHARS) || null,
    };
    items.push(item);
  }
  return { title, items };
}

// Append-only: a refresh inserts NEW guids only and never updates stored
// rows, so a post the user has already seen keeps its stored state.
async function insertPosts(feedId, items) {
  for (const item of items.slice(0, MAX_POSTS_PER_REFRESH)) {
    await pool.query(
      `INSERT INTO posts (feed_id, guid, title, url, published_at, summary)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (feed_id, guid) DO NOTHING`,
      [feedId, item.guid.slice(0, 512), item.title, item.url, item.published, item.summary]
    );
  }
}

async function refreshFeed(feedId) {
  try {
    const { rows } = await pool.query('SELECT url FROM feeds WHERE id = $1', [feedId]);
    if (!rows.length) return;
    const parsed = parseFeed(await fetchFeed(rows[0].url));
    await insertPosts(feedId, parsed.items);
  } catch (err) {
    // A feed that fails to refresh is skipped silently: its already-fetched
    // unread posts still serve. Logged server-side only.
    console.warn('feed refresh failed for feed ' + feedId + ': ' + err.message);
  }
}

// Add a feed: fetch and parse the URL, save the feed, backfill its posts.
// Re-adding a URL already in the user's list returns the existing feed.
app.post('/api/feeds', async (req, res) => {
  try {
    const raw = req.body && typeof req.body.url === 'string' ? req.body.url.trim() : '';
    let parsedUrl;
    try {
      parsedUrl = new URL(raw);
    } catch {
      return res.status(400).json({ error: 'Enter a valid URL.' });
    }
    if (parsedUrl.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only https:// feed URLs are supported.' });
    }

    let xml;
    try {
      xml = await fetchFeed(parsedUrl.href);
    } catch (err) {
      return res.status(400).json({ error: 'Could not fetch that address — ' + err.message + '.' });
    }
    const parsed = parseFeed(xml);
    if (!parsed.title && !parsed.items.length) {
      return res.status(400).json({ error: 'That address does not look like an RSS or Atom feed.' });
    }

    const title = parsed.title || parsedUrl.hostname;
    const inserted = await pool.query(
      `INSERT INTO feeds (user_id, url, title) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, url) DO NOTHING
       RETURNING id, url, title`,
      [req.user.id, parsedUrl.href, title]
    );
    const feed = inserted.rows.length
      ? inserted.rows[0]
      : (await pool.query('SELECT id, url, title FROM feeds WHERE user_id = $1 AND url = $2', [
          req.user.id,
          parsedUrl.href,
        ])).rows[0];
    await insertPosts(feed.id, parsed.items);
    res.json({ feed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The user's feeds, newest last.
app.get('/api/feeds', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, url, title FROM feeds WHERE user_id = $1 ORDER BY created_at ASC, id ASC',
      [req.user.id]
    );
    res.json({ feeds: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remove a feed (posts and read marks go with it via the cascades).
app.delete('/api/feeds/:id', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const deleted = await pool.query(
      'DELETE FROM feeds WHERE id = $1 AND user_id = $2 RETURNING id',
      [Number.isNaN(id) ? -1 : id, req.user.id]
    );
    if (!deleted.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The unread list. First refreshes every feed in parallel (a feed that
// fails is skipped silently), then returns the newest unread posts.
app.get('/api/posts', async (req, res) => {
  try {
    const { rows: feeds } = await pool.query('SELECT id FROM feeds WHERE user_id = $1', [req.user.id]);
    await Promise.allSettled(feeds.map((f) => refreshFeed(f.id)));
    const { rows: posts } = await pool.query(
      `SELECT p.id, p.title, p.url, p.published_at, p.summary, p.feed_id, f.title AS feed_title
       FROM posts p
       JOIN feeds f ON f.id = p.feed_id
       WHERE f.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM post_reads r WHERE r.post_id = p.id AND r.user_id = $1
         )
       ORDER BY p.published_at DESC NULLS LAST, p.id DESC
       LIMIT 200`,
      [req.user.id]
    );
    res.json({ posts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Mark a post read, idempotently. The post must belong to one of the
// caller's feeds.
app.post('/api/posts/:id/read', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const owned = await pool.query(
      `SELECT p.id FROM posts p JOIN feeds f ON f.id = p.feed_id
       WHERE p.id = $1 AND f.user_id = $2`,
      [Number.isNaN(id) ? -1 : id, req.user.id]
    );
    if (!owned.rows.length) return res.status(404).json({ error: 'Not found' });
    await pool.query(
      'INSERT INTO post_reads (post_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, req.user.id]
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use(express.static(path.join(__dirname, 'public')));

// HTML shell: serve the app if authenticated. Unauthenticated top-level
// visits (share links pasted into a browser — Sec-Fetch-Dest: document)
// are sent to the platform's chromeless view of this app, where the shell
// embeds it with a real token so the link just works. Every other
// tokenless case (iframe loads with an expired token, old browsers
// without Sec-Fetch-*) gets the "open in Homeroom" landing page instead
// of a redirect, so the platform shell is never loaded INSIDE its own
// app iframe and stray visits still don't reveal the app.
app.get('*', (req, res) => {
  if (!req.user) {
    // Deep-link pass-through (platform #743): carry the visited
    // path+query into the chromeless view so share links land on the
    // shared screen, not Home. The clean platform route stores `path`
    // as one encoded query value so an inner ?, &, or = survives. The
    // character test keeps the
    // value attribute-safe for the landing anchor below — anything
    // unusual falls back to the bare link.
    const deepPath = /^\/[A-Za-z0-9\-._~!$&()*+,;=:@\/%?]*$/.test(req.originalUrl)
      ? '?path=' + encodeURIComponent(req.originalUrl) : '';
    if (PLATFORM_ORIGIN && req.get('sec-fetch-dest') === 'document') {
      return res.redirect(302, PLATFORM_ORIGIN + '/app/rss-reader/full' + deepPath);
    }
    return res.status(401).send(`<!doctype html><meta charset=utf-8><title>Open in Homeroom</title>
<body style="font-family:system-ui;background:#09090b;color:#e4e4e7;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
  <div style="max-width:24rem;padding:2rem;text-align:center">
    <h1 style="font-size:1.25rem;margin:0 0 0.5rem">Open this app inside Homeroom</h1>
    <p style="color:#a1a1aa;font-size:0.9rem;margin:0 0 1.25rem">This page is served via the platform; direct visits aren't authenticated.</p>
    <a href="${PLATFORM_ORIGIN}/app/rss-reader/full${deepPath}" style="display:inline-block;padding:0.5rem 1rem;background:#7c3aed;color:white;border-radius:0.5rem;text-decoration:none;font-size:0.9rem">Open in Homeroom</a>
  </div>
</body>`);
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

async function start() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS feeds (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL,
      url TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (user_id, url)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      guid TEXT NOT NULL,
      title TEXT,
      url TEXT,
      published_at TIMESTAMPTZ,
      summary TEXT,
      UNIQUE (feed_id, guid)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS post_reads (
      post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL,
      read_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (post_id, user_id)
    )
  `);
  // Read state and feed lists are personal: mark all three private so
  // staging copies their schema but never another user's rows.
  await pool.query(`COMMENT ON TABLE feeds IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE posts IS 'staging:private'`);
  await pool.query(`COMMENT ON TABLE post_reads IS 'staging:private'`);
  const server = app.listen(port, () => console.log(`Listening on :${port}`));
  // Let Envoy retire idle upstream connections at 60s, with a 15s margin.
  server.keepAliveTimeout = 75_000;
}

start().catch(err => { console.error(err); process.exit(1); });