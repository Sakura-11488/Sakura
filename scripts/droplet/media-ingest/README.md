# Sakura media ingest service

Makes hosting on the droplet automatic. One authenticated HTTP call stores the
file under nginx's web root, generates thumbnails (ffmpeg poster frame for
video, sharp resize/webp for images), and updates the per-work `manifest.json`
the app reads at runtime — replacing the old scp + nginx-edit + app-rebuild
flow.

## Deploy

```bash
scp -r scripts/droplet/media-ingest root@<droplet>:/root/media-ingest
ssh root@<droplet> "cd /root/media-ingest && MEDIA_INGEST_TOKEN=$(openssl rand -hex 32) bash deploy.sh"
```

Config lives in `/etc/sakura/media-ingest.env` after first deploy. Save the
token — every admin call needs it.

Then seed the manifests for the existing shows (one-time, from the repo root
on your machine — this also generates 2heAnime's missing per-episode thumbs):

```bash
MEDIA_INGEST_TOKEN=<token> node scripts/droplet/media-ingest/bootstrap-manifests.mjs
```

Ongoing PsyopAnime syncs: run `scripts/psyop-sync-from-youtube.mjs` with
`MEDIA_INGEST_TOKEN` set so new episodes are registered in the manifest (the
app reads the manifest at runtime; the TS arrays are fallback only).

## Admin API (Originals) — `Authorization: Bearer $MEDIA_INGEST_TOKEN`

Base: `http://<droplet>/media/v1`

| Call | Purpose |
| --- | --- |
| `POST /works` `{slug,title,description,status,genres,score}` | Upsert work metadata in its manifest |
| `POST /works/:slug/cover` (multipart `file` or `{url}`) | Cover → 600×900 jpg + 300×450 webp thumb |
| `POST /works/:slug/episodes` (multipart `file` or `{url}`; fields `id`,`title`,`number?`) | Store video, auto-generate `thumbs/<id>.jpg`, update manifest |
| `DELETE /works/:slug/episodes/:epId` | Remove from manifest (files kept) |
| `GET /works/:slug/manifest` | Inspect current manifest |

Example — publish a new 2heAnime episode from a local file:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  -F "file=@newep.mp4" -F "id=moon-landing" -F "title=Moon Landing" \
  http://<droplet>/media/v1/works/2heanime/episodes
```

The app picks it up within ~5 minutes (manifest TTL). No app release needed.

## Creator API — wallet-signature headers

`POST /v1/creator/videos` (multipart `file`, field `workId`) with the app's
standard wallet-auth headers (`x-wallet-address` / `x-signature` /
`x-message`, action `upload-work-media`). Stores under
`/var/www/creator-media/<wallet>/<workId>/`, generates a poster frame, and
returns `{videoUrl, posterUrl}` (path-absolute; prepend the media base). The
app then records these URLs through the `upload-work-media` edge function,
which enforces work ownership before writing `asset_files`/`work_assets`.

## Work roots

Legacy Originals keep their historical paths; new slugs land under
`/var/www/sakura-originals/<slug>/`:

- `psyopanime` → `/var/www/psyopanime` (public `/psyopanime`)
- `2heanime` → `/var/www/2heanime` (public `/2heanime`)
- everything else → `/var/www/sakura-originals/<slug>`

Manifest schema matches the client's `RemoteWorkManifest`
(`sakura-mobile/lib/sakura-originals.ts`): `{id,title,description,status,
genres,score,image,cover,episodes:[{id,number,title,thumbnail,videoUrl}]}`,
URLs path-absolute (e.g. `/2heanime/videos/x.mp4`).
