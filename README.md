# ZiKiBoard

ZiKiBoard is an embeddable blog comment system built for Cloudflare Workers.
It uses D1 for relational data, R2 for uploaded images, KV for OAuth/OIDC
state and discovery caching, and Worker static assets for the widget.

## Features

- OpenID Connect login for providers such as Google, Microsoft, DingTalk, and
  any issuer with a discovery document.
- GitHub login via OAuth 2.0 provider support.
- Blog-isolated comment threads keyed by `data-blog-id`.
- Markdown subset rendering, image uploads to R2, nested replies, mentions,
  emoji content, and emoji reactions.
- Session cookies backed by hashed D1 session records.

## Local development

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npm run types
npm run db:migrate:local
npm run dev
```

Open `http://localhost:8787`.

## Auth configuration

Set `AUTH_PROVIDERS` to a JSON array. Keep client secrets in dedicated secret
variables referenced by `clientSecretEnv`.

```json
[
  {
    "id": "google",
    "name": "Google",
    "type": "oidc",
    "issuer": "https://accounts.google.com",
    "clientId": "GOOGLE_CLIENT_ID",
    "clientSecretEnv": "GOOGLE_CLIENT_SECRET"
  },
  {
    "id": "microsoft",
    "name": "Microsoft",
    "type": "oidc",
    "issuer": "https://login.microsoftonline.com/common/v2.0",
    "clientId": "MICROSOFT_CLIENT_ID",
    "clientSecretEnv": "MICROSOFT_CLIENT_SECRET"
  },
  {
    "id": "github",
    "name": "GitHub",
    "type": "github",
    "clientId": "GITHUB_CLIENT_ID",
    "clientSecretEnv": "GITHUB_CLIENT_SECRET"
  }
]
```

For production secrets:

```powershell
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put MICROSOFT_CLIENT_SECRET
npx wrangler secret put GITHUB_CLIENT_SECRET
```

When embedding on a different origin, set `CORS_ORIGINS` to that site origin
and use `COOKIE_SAME_SITE=None` over HTTPS.

## Cloudflare resources

Create production resources and replace the placeholder IDs in
`wrangler.jsonc`.

```powershell
npx wrangler d1 create zikiboard-db
npx wrangler kv namespace create AUTH_CACHE
npx wrangler r2 bucket create zikiboard-images
npm run db:migrate:remote
npm run deploy
```

## Embed

```html
<link rel="stylesheet" href="https://comments.example.com/styles.css" />
<div id="zikiboard" data-blog-id="blog/post-slug"></div>
<script src="https://comments.example.com/embed.js"></script>
```

Each unique `data-blog-id` has a separate comment thread.
