# Petal Wind


# Documenting Pensieve 


great unlock

launch 2028






-----------

A three.js meadow. You ride the wind as a petal, wake sleeping buds, and turn grey hills green. The page is plain static HTML, CSS and an ES module, served by a small Bun server and deployed on Fly.io.

## Layout

```
public/
  index.html             page shell and HUD
  style.css              HUD styling
  main.js                the scene (ES module)
  favicon.svg
  vendor/three.module.js three.js r128, pinned and served locally
server.ts                Bun.serve static server: gzip, cache headers, /healthz
Dockerfile               oven/bun:1.2-alpine image
fly.toml                 Fly app config (port 8080, scales to zero)
```

## Run locally

```sh
bun run dev        # http://localhost:8080, restarts when server.ts changes
```

Edits to files in `public/` show up on the next browser reload.

## Deploy to Fly.io

```sh
fly auth login
fly launch --no-deploy --copy-config --name <your-app-name>   # or edit `app` in fly.toml
fly deploy
fly open
```

- `fly.toml` sets the region to `dfw` (Dallas). Change `primary_region` to move it.
- Machines stop when nobody is visiting and start again on the next request, so idle cost is close to zero. The first visit after an idle period takes a second or two.
- To add a custom domain, run `fly certs add petalwind.example.com` and point a CNAME at `<app>.fly.dev`.

## Server behavior

| Path | Response |
|---|---|
| `/healthz` | `ok`. Fly's health check uses it. |
| `/vendor/*` | Cached for one year as immutable, since three.js is pinned. |
| `*.js`, `*.css`, `*.svg` | Cached for one hour. Gzipped when the browser asks for it. |
| `index.html` | `no-cache`, so a deploy shows up right away. |
| Unknown paths with no extension | Fall back to `index.html`. |
| Unknown files | 404. |

## Controls

Press and hold, or hold space or the up arrow, to fly. Steer with the pointer or the arrow keys.
