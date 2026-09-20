# RSS Reader

A Feedly-style RSS reader for Homeroom, built with a mobile-native UI.

## What it does

- **Per-user private feeds.** Each Homeroom user has their own feed list and
  read state. The `feeds` and `items` tables are marked `staging:private`, so
  staging previews never show anyone else's subscriptions.
- **Unread / All.** The main screen is a flat, scrollable item list with an
  Unread / All segmented control, Feedly-style.
- **Inline article preview.** Tapping an item pushes an article screen with
  the feed's summary HTML and an "Open in browser" link to the original post.
- **Feed management.** Add an RSS/Atom URL from the "+" button, refresh all
  feeds from the Feeds screen, swipe a feed row left to remove it.

## Stack notes

- Node/Express server (`server.js`) with Postgres via `pg`; feeds are fetched
  and parsed server-side with `rss-parser`.
- The frontend uses the platform's hosted native UI kit (`usernode-native`)
  for nav bars, grouped lists, swipe actions, sheets and push/pop transitions,
  with a precompiled Tailwind stylesheet.
- Staging previews seed obviously fake demo feeds and items so the screens
  can be reviewed without real credentials; production requires the normal
  Homeroom iframe token on every API call.
