# RSS Reader — notes for Claude Code

This app runs on **Homeroom**. If you're Claude Code
editing this repo, read the platform conventions before making
changes:

**Platform conventions (authoritative, always current):**
https://app.onhomeroom.com/claude.md

Fetch that URL at the start of each session — it's the single source
of truth for platform-wide behavior (auth model, `USERNODE_ENV`,
public/private tables, "don't `git push`", etc.). The hosted copy is
updated in place when platform rules change, so fetching it gives you
today's rules, not a stale snapshot.

When running inside Homeroom's dev-chat, those same conventions are
already injected into your system prompt, so the fetch is a no-op in
that path — but it's the right reflex when someone runs Claude Code
against this repo locally or from another harness.

## Connector permission prompts

This repo ships `.claude/settings.json`, which allows the **read-only**
Homeroom connector calls (`mcp__homeroom__get_*`,
`…__list_*`, `…__whoami`) so they stop prompting one at a time. Everything
that acts — filing a request, opening or advancing a proposal — still asks.
Claude Code applies those rules only after you accept the
workspace trust dialog, which lists them for review. See `.claude/README.md`
for the whole story, including what to do if you are still being prompted
(usually: your connector is registered under a different name than the rules
assume).

## Check that this checkout is current

You may be working in a fork of this app whose `main` is behind the app's
canonical repository, and nothing in the checkout says so: `git fetch origin`
compares the fork with itself. This matters before you **read** code to answer
a question about how the app behaves now, not only before you edit it.

The canonical repository is named in `.claude/homeroom-canonical-repo`. Check against
it, not against `origin`:

```sh
git fetch "$(cat .claude/homeroom-canonical-repo)" main
git merge-base --is-ancestor FETCH_HEAD HEAD && echo current || echo behind
```

`behind` means this checkout does not contain the canonical `main`. To answer
a question, read the canonical code instead (`git show FETCH_HEAD:<path>`,
`git grep <pattern> FETCH_HEAD`). To change code, start from the exact base
commit your Homeroom work order gives, and never merge or rebase onto the
canonical `main` yourself: which commit a change is diffed against decides
what the group votes on. With the Homeroom connector, `get_checkout_status`
answers the same question.

A session-start hook (`.claude/hooks/homeroom-freshness.sh`, see `.claude/README.md`) runs
this check for you and tells you when you are behind. It is silent offline, so
its silence is not proof the checkout is current. Inside Homeroom's dev-chat
the platform fixes the base commit, and none of this applies.

## Starter template

The screen this app currently ships — the hero, the "What's already
working" card, and the Press! example (the demo markup in
`public/index.html`, the `/api/press` and `/api/leaderboard` routes, and
the `presses` table bootstrap in `server.js`) — is placeholder content
from the Homeroom starter template, not product intent.

When the user asks for their first real feature, REPLACE the template
screen rather than building alongside it:

- remove the `usernode-starter-notice@1` block in `public/index.html`
  (both sentinel comments and everything between them),
- remove or repurpose the "Try the example" card, its demo endpoints and
  the `presses` table as appropriate,
- rewrite `README.md` to describe the actual app.

Keep the `usernode-dev-console@1` forwarder `<script>` when rewriting the
HTML — that block is platform infrastructure, not template content. So is
the bridge `<script>`.

The screen has a light and a dark look and follows the viewer's Homeroom
theme, switching live when they change it: the theme `<script>` right after
the bridge tag sets a `dark` class on `<html>`. Keep that script, and give
everything you build both looks (Tailwind's `dark:` variants), unless one
fixed look is the point of this app, like a game's own scene; then say so
under "App-specific conventions" below. Unless a request asks for one, add
no theme picker: the viewer's Homeroom setting is the control. "The
platform's light/dark theme inside the app frame" in the platform
conventions has the details.

If a rule below this line conflicts with the hosted conventions, the
hosted conventions win. This file is **app-specific** — write down
things about *this* app that belong in the repo: product intent,
data-model quirks, style preferences, opt-in policies (e.g. which
tables you've marked private), etc.

---

## About RSS Reader

A single-screen RSS reader: each person adds their own RSS/Atom feeds and
catches up on their unread posts in one scrolling list. Reading — not feed
management — is the point: the one primary action is **Add feed**, feed
management is a quiet collapsible corner of the same screen. Tapping a
post expands an in-page preview and marks it read; the full article stays
in the browser.

## App-specific conventions

**Design:** teal accent on warm stone-grey neutrals, in a light and a dark
look that follow the viewer's Homeroom theme via `dark:` variants — no
theme picker. Accent: `teal-600` light / `teal-400` dark for text, links
and the unread dot; the filled primary button is `teal-600` with white
text in both looks. Neutrals: stone (`stone-50`/`stone-900` light,
`stone-950`/`stone-100` dark). The native UI kit's `--un-*` tokens are
overridden to the same palette in the `<style>` block in `index.html`.
Type/spacing: phone-width single column (`max-w-md`), feed names in small
teal caps (`text-xs uppercase`), `text-sm` body. Signature element: the
**unread dot** — a small teal dot at the left of every unread post row,
the only thing that disappears when a post is read.

**Data:** `feeds`, `posts` and `post_reads` are private per-user tables
(`staging:private`, no staging seed). `posts` is append-only: a refresh
inserts new guids with `ON CONFLICT DO NOTHING` and never updates stored
rows. Read state is a `post_reads` row, not a column — there is no
un-read in v1. Removing a feed cascades to its posts and read marks.

**Feed-content safety:** feed text is third-party input. The server
strips it to plain text before storing; the frontend renders every
feed-derived string with `textContent` (never `innerHTML`) and only
accepts `http(s)` links for the Open original `href`.

**No new npm dependencies** — feed fetching and parsing are built-in code.
