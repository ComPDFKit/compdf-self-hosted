![ComPDF Solutions](images/ComPDF-Comprehensive%20PDF%20Solutions.png)

[English](README.md) | [简体中文](README_CN.md) | [繁體中文](README_TW.md)

# ComPDF Self-Hosted

Self-hosted PDF editing, document conversion and batch processing, with a Web UI,
administration Dashboard, REST APIs and MCP integration.

## Features

- PDF tools: merge, split, rotate, insert/delete/extract pages, compress,
  watermark, encrypt/decrypt, headers/footers and Bates numbers.
- Document/image conversion: PDF, Office, HTML, text and supported image formats.
  Actual capabilities depend on the App image and SDK license.
- Batch uploads, per-file passwords, sequential processing, status, failed-file
  retry and ZIP downloads.
- Dashboard: usage overview, logs, API keys, account/branding settings, License
  management and product updates.
- MCP: authenticated Streamable HTTP tools for operation discovery and batches.

![PDF tools](images/tools.png)

![Dashboard](images/dashboard.png)

## Installation

All three methods below are supported. Allow at least **32 GB RAM** and storage
for images, data and backups. Default Infra/App images target `linux/amd64`.
Docker methods require Docker Engine/Desktop in Linux container mode and
Compose v2 supporting `up --wait --wait-timeout`.

### Method 1: Standalone installer (no clone)

On Linux, WSL or macOS, run in a writable directory. Bash, curl and Docker must
already be installed; Git and Node.js are not required. The default directory is
`./compdf-self-hosted`:

```sh
curl -fsSL https://raw.githubusercontent.com/ComPDFKit/compdf-self-hosted/main/deploy/install.sh | bash -s -- --prepare-only
```

To review the script first or choose an installation directory:

```sh
curl -fsSL https://raw.githubusercontent.com/ComPDFKit/compdf-self-hosted/main/deploy/install.sh -o compdf-install.sh
# Review the script; the current user needs write permission to /opt.
bash compdf-install.sh --dir /opt/compdf --prepare-only
```

The installer resolves one source commit, downloads minimal deployment assets
and creates configuration, font and data directories. `--prepare-only` prepares
files for configuration without starting services; `--dry-run` prints the plan.
Use `--ref` to select an existing release tag or source commit. Image tags come from the
configuration; controlled deployments should use verified digests.

Place the issued trial or production license at
`configs/app-license/license.xml` inside the installation directory before
starting services. The directory is mounted into App automatically; the repository
does not include a valid SDK license. Put authorized fonts in `fonts/windows/`.
Fresh installs can import the directory containing `license.xml` with
`--sdk-license-dir`; use `--fonts-dir` for fonts.

From the parent of the default installation directory, run:

```sh
# Start services or apply the configured environment.
bash ./compdf-self-hosted/install.sh install --dir ./compdf-self-hosted
bash ./compdf-self-hosted/install.sh status --dir ./compdf-self-hosted
bash ./compdf-self-hosted/install.sh logs --dir ./compdf-self-hosted
# Stop services while preserving configuration and data.
bash ./compdf-self-hosted/install.sh stop --dir ./compdf-self-hosted
```

For `/opt/compdf`, use `/opt/compdf/install.sh` and `--dir /opt/compdf`.
Repeated installation preserves existing files/data and pulls configured images;
it does not update deployment scripts or roll back the database. Use the saved
installer commands to retain its Compose project identity. Back up the database,
storage, configuration and licenses together before changing versions.

### Method 2: Apple container

Requires Apple Silicon, macOS 26+, Apple `container` 1.5.0, jq and curl. Default
amd64 images require Rosetta. Select the Apple runtime in the same installer:

```sh
curl -fsSL https://raw.githubusercontent.com/ComPDFKit/compdf-self-hosted/main/deploy/install.sh | bash -s -- --runtime apple --prepare-only
```

Place the issued license at `configs/app-license/license.xml` in the prepared
directory, then run the `install` command below. The installer starts
Infra → App → Server, checks health and injects dependency IP addresses.
Configuration is saved in `.apple.env`; the default published endpoint is local
`http://localhost:8080`. Later commands must include `--runtime apple`:

```sh
bash ./compdf-self-hosted/install.sh install --runtime apple --dir ./compdf-self-hosted
bash ./compdf-self-hosted/install.sh status --runtime apple --dir ./compdf-self-hosted
bash ./compdf-self-hosted/install.sh logs --runtime apple --dir ./compdf-self-hosted
bash ./compdf-self-hosted/install.sh stop --runtime apple --dir ./compdf-self-hosted
```

Existing containers are not overwritten. Recreating them requires refreshing
dependency IPs and preserving persistent volumes. This mode does not integrate
the Docker Updater or supply an automatic restart daemon. After stopping services,
recreate all three containers in dependency order to refresh their IPs. Read
`PROJECT` from `.apple.env`, remove only that project's stopped containers with
`container delete`, then run the saved install command again. Retain the network,
named volumes and mounted configuration/storage directories.

### Method 3: Manual Docker Compose

For a complete checkout or custom Compose configuration:

```sh
git clone https://github.com/ComPDFKit/compdf-self-hosted.git
cd compdf-self-hosted
cp .env.example .env
mkdir -p configs/app-license fonts/windows data/server-storage
```

Configure `.env`, image versions, issued licenses and fonts as described in
Method 1, then start:

```sh
docker compose --env-file .env config --quiet
docker compose --env-file .env pull
docker compose --env-file .env up -d --wait --wait-timeout 600
docker compose --env-file .env ps
```

Environment changes require `docker compose up -d` to recreate affected containers.
Retain the original project name and persistent volumes. The base Compose publishes
port 8080; it may listen on all host interfaces. Use `up` to create containers;
`start` only resumes containers that already exist.

### Access and first configuration

| Entry | Default address |
| --- | --- |
| ComPDF Web | `http://localhost:8080/` |
| Dashboard | `http://localhost:8080/admin` |
| Health | `http://localhost:8080/api/v1/status` |

For a remote Docker host, replace `localhost` with its controlled endpoint.
First initialization creates `admin / admin`; change the password after login.
Configure HTTPS, CORS and access controls before external use. Keep issued
credentials, fonts and runtime data out of Git.

## Product updates: GitHub and Docker Hub

Clients check this repository's signed stable channel. A higher published product
version offers an update; an arbitrary source commit does not. After verification
and administrator approval, Updater pulls immutable App/Server images from Docker
Hub, backs up data, applies any declared migration, restarts services and verifies
real PDF processing.

Missing/unreachable or expired metadata does not confirm a successful
latest-version check. Updater independently verifies signatures before installation.

Dashboard product installation and online runtime XML License updates use the
containerized Updater included in the default Compose file. Copy `.env.example`
to `.env`; it already contains the current stable feed's
`COMPDF_UPDATE_KEY_ID` and Base64 Ed25519 `COMPDF_UPDATE_PUBLIC_KEY`. Replace
them only when the signing key changes. The default feed is this repository's
`updates` branch. From a complete checkout, start all published services with:

```sh
docker compose --env-file .env pull
docker compose --env-file .env up -d --wait --wait-timeout 600
```

Minimal Docker installations can continue using the recorded overlay and saved
project name from `.compdf-install`. New full checkouts do not need the overlay;
the older `docker-compose.updater-container.yml` remains for compatibility.

To build local source, use
`docker compose -f docker-compose.full.yml up -d --build --wait --wait-timeout 600`.
Installation always needs administrator confirmation. The default Compose command
starts the application, Updater and Infra together.

Back up the database, storage, configuration and licenses before an upgrade.
Do not delete persistent volumes or relabel an existing database's schema history.
After an update, use `docker compose -f tmp/runtime-updater/docker-compose.json up -d`
to restart business services with their installed versions; manage Updater with
its original Compose configuration. Rebuilding older source can replace an
installed update.

Maintainers publish images and signed metadata using the manual **Publish release**
workflow in [.github/workflows/release.yml](.github/workflows/release.yml).
Configure its `release` environment with secrets `DOCKERHUB_USERNAME`,
`DOCKERHUB_TOKEN`, `RELEASE_SIGNING_PRIVATE_KEY` (Base64-encoded 64-byte Ed25519
private key), and variable `RELEASE_SIGNING_KEY_ID`. Distribute the matching
32-byte Base64 public key and key ID to installations; keep the private key in
the release environment. Align versions in `release/version.json`, create an
immutable version tag, then run the workflow for that tag. It publishes Server/UI
and Updater images and signs `stable/release.json` plus `stable/release.json.sig`
on the `updates` branch. Pushing source alone does not create an update feed or
Docker Hub tags.

## Runtime and source layout

Infra supplies MySQL, Redis and object storage. App runs the PDF/conversion SDK.
Server provides APIs, batch/MCP logic and the packaged UI. Optional Updater manages
approved updates. Commercial SDK source is not included.

| Path | Purpose |
| --- | --- |
| `frontend/compdf-web/` | Vue 3 + Vite UI and Dashboard |
| `server/` | NestJS + TypeScript backend |
| `updater/` | Go updater/publisher and container bootstrap |
| `deploy/`, `helm/` | Canonical deployment assets |
| `deployment/`, `release/`, `migrations/` | Contracts, versions and forward upgrades |
| `configs/` | Settings and initial database schema |
| `tests/fixtures/` | Synthetic test samples; never release data |

## Source development

Use Node.js 24 and npm; Server and UI have separate packages and lock files.

```sh
test -f .env || cp .env.example .env
docker compose -f docker-compose.dev.yml up -d --build compdf-infra compdf-app compdf-server
```

In a separate terminal:

```sh
cd frontend/compdf-web
npm ci
npm run dev
```

Frontend is `http://localhost:5173`, backend `http://localhost:8080`. Development
exposes additional SDK/database ports; use an isolated environment. Windows users
with an existing local stack can use `scripts/start-backend-dev.ps1` for watch
mode.

To build and deploy the Server/UI image from a complete source checkout:

```sh
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build compdf-infra compdf-app compdf-server
```

App and Infra still use their configured images. These source commands are for
the complete repository, not the minimal directory created by the installer.

## Other deployment assets

| Option | Purpose | Files |
| --- | --- | --- |
| Kubernetes / Helm | Cluster deployment using the bundled chart | [Chart](helm/compdf-self-hosted/) |
| Source / binary | Controlled Linux Server/UI deployment; App/Infra remain separate | [Packaging scripts](deploy/binary/) |
| Nginx / Keepalived | TLS and entrypoint availability; application/data HA needs separate design | [Configuration](deploy/nginx/) |
| Offline delivery | Image export and signed offline packages | [Offline tools](deploy/offline/) |

Nginx is an entrypoint layer; online/offline describes delivery. These options
can accompany Compose or Kubernetes. Compose Updater does not manage Kubernetes
or Apple container.

## License and support

Repository code uses the [MIT License](LICENSE). Commercial PDF/Conversion SDKs,
valid runtime licenses and customer fonts are provided separately. Visit
[ComPDF](https://www.compdf.com/self-hosted-deployment) or
[contact sales](https://www.compdf.com/contact-sales) for product/enterprise support.
Report code issues through [GitHub Issues](https://github.com/ComPDFKit/compdf-self-hosted/issues).
