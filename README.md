# RSS Reader

A single-screen RSS reader built on Homeroom. You are signed in through
Homeroom automatically — each person's feeds, posts and read state are
their own.

## What it does

- **Add feed** — paste an `https://` RSS or Atom feed URL. The server
  fetches it right away to validate it, saves it under your account, and
  backfills its recent posts. Re-adding a URL you already follow doesn't
  create a duplicate.
- **Unread list** — one scrolling list of unread posts across all your
  feeds, newest first. Each row shows a teal unread dot, the feed name and
  the post's date. At most the newest 200 unread posts are shown.
- **Preview** — tap a row to expand a plain-text preview of the post with
  an **Open original** link. Opening the preview marks the post read; read
  posts leave the list on the next load (there is no un-read in v1).
- **Feeds line** — a collapsed-by-default list of your feeds with an **×**
  to remove each one (its stored posts and read marks go with it).
- **Refresh** — feeds are fetched when the list is opened; there is no
  background refresh job in v1. A feed that fails to refresh is skipped
  silently — its already-fetched posts still show.

## How it's built

- Node/Express server (`server.js`) with its own Postgres database. Three
  private per-user tables: `feeds`, `posts` (append-only, deduped by feed
  guid) and `post_reads`.
- Feeds are fetched over HTTPS on demand with a 10s timeout and a ~2 MB
  cap and parsed with built-in code — no RSS library. Only public
  addresses are fetched (loopback/private ranges are refused).
- Feed text is third-party input: stripped to plain text server-side and
  rendered with `textContent` in the frontend.
- Tailwind CSS precompiled by `npm run build` during image creation, in a
  light and a dark look that follow the viewer's Homeroom theme. Teal
  accent on warm stone neutrals; see `CLAUDE.md` for the design note.