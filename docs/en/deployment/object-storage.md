# Object storage

HeoPress stores uploads and image derivatives either on the local filesystem or in an S3-compatible object store. Switching is configuration only.

## Choosing a backend

| Variable | Default | Meaning |
|---|---|---|
| `HEOPRESS_STORAGE` | `local`, or `s3` when `S3_BUCKET` / `S3_ENDPOINT` is set | `local` or `s3` |
| `HEOPRESS_STORAGE_DIR` | `./data/storage` | Root directory for `local` (mount a volume here in Docker) |
| `S3_ENDPOINT` | AWS S3 | Endpoint of an S3-compatible service |
| `S3_REGION` | `us-east-1` | Region (`auto` for R2) |
| `S3_FORCE_PATH_STYLE` | `true` with a custom endpoint, `false` for AWS | Path-style (`endpoint/bucket/key`) vs virtual-hosted (`bucket.endpoint/key`) addressing |
| `S3_BUCKET` | `heopress-media` | Bucket |
| `S3_ACCESS_KEY` / `S3_SECRET_KEY` | — | Credentials (`*_FILE` variants are read from files) |

## Local filesystem

The default for a minimal deployment. Each object is one file under `<dir>/objects/`, a small metadata header followed by the bytes, so metadata and bytes are always replaced together. Keys are validated: absolute paths, `..` and `.` segments, empty segments, backslashes and control characters are refused, and the resolved path must stay inside the directory. `<dir>` itself may be a symbolic link; nothing below it is followed (`objects`, directories on the way and objects are refused if they are links, and files are opened with `O_NOFOLLOW`). Writes are atomic (temporary file, then rename). The directory must be writable by the HeoPress process only: someone who can change it while the server runs could race these checks.

## S3-compatible services

The S3 endpoint is a service connection under the [outbound boundary](../security/outbound-requests.md): it is checked at startup and on every connection. A private-network endpoint (SeaweedFS in compose) must be listed in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`.

**SeaweedFS** — the compose `s3` profile, and what CI tests against (`chrislusf/seaweedfs:3.97`, S3 gateway). MinIO works the same way (`S3_ENDPOINT=http://minio:9000`), but its images are no longer freely pullable:

```bash
docker compose -f docker/docker-compose.yml --profile s3 up -d
HEOPRESS_STORAGE=s3
S3_ENDPOINT=http://seaweedfs:8333
S3_FORCE_PATH_STYLE=true
S3_BUCKET=heopress-media
S3_ACCESS_KEY=…
S3_SECRET_KEY=…
HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS=http://seaweedfs:8333
```

The profile configures SeaweedFS with one identity: `S3_ACCESS_KEY` / `S3_SECRET_KEY`, allowed to read, write and list `S3_BUCKET` only. Without an identity file SeaweedFS accepts any key pair, so the container refuses to start when either key is empty (or contains a quote or backslash). Use long random values; any container on the compose network can reach the gateway.

**AWS S3:**

```bash
HEOPRESS_STORAGE=s3
S3_REGION=eu-central-1
S3_BUCKET=heopress-media
```

**Cloudflare R2:**

```bash
HEOPRESS_STORAGE=s3
S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com
S3_REGION=auto
S3_BUCKET=heopress-media
```

The following two are **configuration examples, not verified in CI**. Both services document an S3-compatible API but require virtual-hosted-style addressing; check your bucket's region and the provider's current S3 compatibility notes before relying on them.

**Alibaba Cloud OSS:**

```bash
HEOPRESS_STORAGE=s3
S3_ENDPOINT=https://oss-cn-hangzhou.aliyuncs.com
S3_REGION=oss-cn-hangzhou
S3_FORCE_PATH_STYLE=false
S3_BUCKET=heopress-media
```

**Tencent Cloud COS:**

```bash
HEOPRESS_STORAGE=s3
S3_ENDPOINT=https://cos.ap-guangzhou.myqcloud.com
S3_REGION=ap-guangzhou
S3_FORCE_PATH_STYLE=false
S3_BUCKET=heopress-media-1250000000
```

## Image derivatives

Image transforms run in process with sharp — no image service. Requests must name a preset (`?preset=<key>`) or carry a valid signature (`?sig=` over the file key and parameters, with the site's `media.signedTransform.secret`); an unsigned arbitrary size gets `403`. Width and height are capped by `HEOPRESS_IMAGE_MAX_DIMENSION` (default 4096). Each derivative is stored once under `derived/<source key>/<hash>` and reused; deleting the source removes its derivatives. Media from remote URLs is never fetched by the transform path; future import features use the outbound boundary.

## Per-site storage profiles

The settings above are the **instance default**. A site can use a bucket of its own, with its own public media address, through a **storage profile** (HeoPress P04). This keeps the images and attachments of each site in a network apart, served under that site's domains.

**In Studio**: *Settings → Storage* lists the site's profiles and the instance default, marks the one new media goes to, and lets an administrator create a profile, test its connection and choose it for new media. The secret key field is write-only: after saving, the page (like the API) shows only `••••••••`. Moving existing media and editing or clearing a secret are done through the API below.

`/api/v1/storage-profiles` (site administrators only):

| Call | What it does |
|---|---|
| `POST /` `{name, driver: 'local' \| 's3', bucket?, endpoint?, region?, forcePathStyle?, accessKeyId?, secretAccessKey?, publicBaseUrl?}` | Create a profile. An `s3` profile needs a bucket, an access key and a secret |
| `GET /`, `GET /:id` | Read profiles. `secretAccessKey` shows `••••••••` when a secret is stored, and is never returned |
| `PATCH /:id` | Change a profile. `secretAccessKey`: omit it to keep the secret, `null` to clear it |
| `POST /:id/test` | Write, read back and delete a probe object; returns `{ok, latencyMs, error?}` |
| `PUT /binding` `{profileId \| null}` | Where the site's **new** media goes (`null`: the instance default) |
| `POST /migration` `{profileId \| null, confirm: true}` | Move the site's **existing** media there: copy, read back, compare, then switch. A failure leaves that object where it was and is listed |
| `POST /migration/undo` | Point moved media back to where it was (the old copies are kept) |
| `DELETE /:id` | Delete a profile: `409 PROFILE_IN_USE` while it is bound or still holds media |

Storing or using an S3 secret needs the instance encryption key — the active one to store a secret, the version it was sealed with to use it (`ENCRYPTION_KEY`, `ENCRYPTION_KEY_<id>`; see [encryption keys](../operations/encryption-keys.md)). Without it, creating or changing the secret and testing or using the profile answer `503 ENCRYPTION_NOT_CONFIGURED`.

**What stays true:**

- **Separate namespaces.** Every object is stored under `sites/<site id>/media/<key>` in whatever profile holds it. Sites that share a bucket, or the default, stay apart. A site can only name its own keys, so guessing another site's key reaches nothing.
- **Old media keeps working.** Each object records which profile it was written to. Binding another profile only changes where *new* uploads go. Media from before profiles existed is read from the instance default.
- **Public URLs.** An upload's response carries `url`. When the profile has a `publicBaseUrl` (for example `https://img.example.com`), it is `<publicBaseUrl>/sites/<site id>/media/<key>`. Point that address at the bucket, through a CDN or the bucket's public endpoint.
- **Secrets.** The secret key is encrypted with the instance KEK (`ENCRYPTION_KEY`, rotation as for field encryption), bound to its profile, and never logged or returned.
- **Outbound boundary.** An S3 endpoint is an outbound connection, like the default's. Private networks and metadata addresses are refused unless the operator lists the exact origin in `HEOPRESS_TRUSTED_INTERNAL_ENDPOINTS`.
- **Local profiles.** A `local` profile keeps its objects in `HEOPRESS_STORAGE_DIR/profiles/<profile id>/` on this instance. It takes no path, so it cannot be pointed elsewhere on the file system.
