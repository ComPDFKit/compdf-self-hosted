[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

# ComPDF Self-Hosted — Open Source PDF Editor & PDF Converter

Leverage [ComPDF Self-hosted](https://www.compdf.com/self-hosted-deployment?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) (Part of the KDAN ecosystem), an open-source PDF platform in Docker containers for private deployment—use it to edit, convert, and transform documents across PDFs, Office formats, HTML, TXT, CSV, RTF, JSON, and images.

> * If you find ComPDF Self-hosted useful, please consider giving us a ⭐ **Star** on GitHub. It helps us grow and improve.
> * Got questions or ideas? Join the conversation in our [Discussions](https://github.com/ComPDFKit/compdf-self-hosted/discussions).

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/docker-supported-blue" alt="Docker"></a>
  <a href="#"><img src="https://img.shields.io/github/stars/compdfkit/compdf-self-hosted" alt="GitHub Stars"></a>
  <a href="#"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome"></a>
</p>

<p align="center">
    <a href="#features"><b>Features</b></a> •
  <a href="#quick-start"><b>Quick Start</b></a> •
  <a href="#architecture"><b>Architecture</b></a> •
  <a href="#upgrade-to-enterprise"><b>Upgrade to Enterprise</b></a> •
   <a href="#support"><b>support</b></a> •
  <a href="#license"><b>License</b></a> •
  <a href="https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en" target="_blank"><b>Enterprise →</b></a>
</p>

## Why ComPDF Self-Hosted?

Unlike traditional SDKs that require deep integration, ComPDF Self-Hosted is a ready-to-deploy open-source PDF processing platform. It combines PDF editing and conversion capabilities, while also supporting image format conversion—covering the full spectrum from documents to images. This enables enterprises to quickly establish a fully controllable, self-owned document center.

### Key Advantages

* Docker Compose deployment
* Complete PDF tool center — edit, convert, merge, split
* API key management and license management
* Private deployment with enterprise-ready architecture
* Commercial support and dedicated assistance available

Whether you're building an internal document platform, document automation workflow, or enterprise PDF service, ComPDF Self-Hosted helps you get started in minutes.


## Features
![Tools](images/tools.png)

ComPDF Self-Hosted provides a ready-to-use **open source PDF editor**, **open source PDF converter**, and **open source image converter** center directly accessible through a browser. 

### PDF Editing

* Merge PDF
* Split PDF
* Rotate PDF
* Insert Pages
* Delete Pages
* Extract Pages
* Add Watermark
* Remove Watermark
* Encrypt PDF
* Decrypt PDF

### PDF Conversion

#### PDF to Others

* PDF to Word
* PDF to Excel
* PDF to Slide
* PDF to Image (PNG, JPG, JPEG, JPEG2000, BMP, TIFF, TGA, GIF, WEBP)
* PDF to HTML
* PDF to TXT
* PDF to CSV
* PDF to RTF
* PDF to JSON
* PDF to Markdown
* PDF to Searchable PDF
* PDF to OFD

#### Others to PDF

* Word to PDF
* Excel to PDF
* Slide to PDF
* HTML to PDF
* TXT to PDF
* CSV to PDF
* RTF to PDF
* PNG to PDF

#### Image Conversion (photo converter open source)

* Image to Word
* Image to Excel
* Image to Slide
* Images to JSON
* Image to HTML
* Image to CSV
* Image to TXT
* Image to RTF
* Images to PDF



<a id="quick-start"></a>

## Quick Start

### 1. Start with Docker Compose

1. Clone the repository and enter the project directory:

```bash
git clone https://github.com/ComPDFKit/compdf-self-hosted.git
cd compdf-self-hosted
```

2. Prepare the environment file before starting services:

```bash
cp .env.example .env
```

`.env` includes a free License by default for local development, feature
evaluation, and API verification. Docker Compose automatically loads `.env`
from the project directory.

3. Start the full stack:

```bash
docker compose up -d
```

4. Open ComPDF Web:

```text
http://localhost:8080/
```

To use an Enterprise license, replace `COMPDF_LICENSE_KEY` in `.env` with the
issued License Key. Restart the services after updating the License Key.

**[Apply for the Enterprise version](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) to obtain the following benefits:**

* Watermark-free document processing
* No limit on the number of document pages processed
* Batch document processing

### 2. Start the development environment

Development uses Docker for the infra and SDK services, while the middleware and
Web UI can run locally for hot reload.

Terminal 1: start MySQL, Redis, RustFS, and the SDK services:

```bash
docker compose -f docker-compose.dev.yml up -d compdf-infra compdf-app
docker compose -f docker-compose.dev.yml ps
```


Terminal 2: start the NestJS middleware locally. It connects to the dev Compose
services through their host-mapped ports:

```bash
cd server
npm install
DATABASE_HOST=127.0.0.1 \
DATABASE_PORT=13306 \
DATABASE_USER=compdfkit \
DATABASE_PASSWORD=compdfkit-pass-2026 \
DATABASE_NAME=compdfkit \
REDIS_HOST=127.0.0.1 \
REDIS_PORT=16379 \
COMPDF_SDK_BASE_URL=http://127.0.0.1:7000 \
PDF_SDK_BASE_URL=http://127.0.0.1:7001 \
CONVERSION_BASE_URL=http://127.0.0.1:7000 \
LICENSE_TOKEN_PATH=../configs/license.jwt \
SETTINGS_PATH=../configs/settings.yml \
STORAGE_DIR=./storage \
npm run start:dev
```

The middleware exposes the API at:

```text
http://localhost:8080/api/v1/*
```

Terminal 3: start the Web UI. Vite proxies `/api` to the middleware on port
`8080`:

```bash
cd frontend/compdf-web
npm install
npm run dev
```

Open the URL printed by Vite, for example:

```text
http://localhost:5173/
```

For LAN access, use the machine IP printed by Vite's `Network` URL and make
sure the middleware is also reachable from that machine.

If you prefer running the middleware in Docker during development:

```bash
docker compose -f docker-compose.dev.yml up -d --build compdf-infra compdf-app web
```

### 3. Check status and logs

```bash
docker compose ps
docker compose logs -f compdf-server
```

The production deployment stores persistent data in Docker volumes and mounts `./configs` into the middleware container.

### 4. Build the production image from source

Keep this path when you changed local source code and need to package a new
production `compdf-server` image from the root `Dockerfile`. The Dockerfile
compiles `frontend/compdf-web`, builds the NestJS server, copies the Web UI into
`/app/public/compdf-web`, and starts the middleware on port `8080`.

```bash
docker compose -f docker-compose.yml up -d --build compdf-infra compdf-app compdf-server
```

All features above come with [ComPDF](https://www.compdf.com/?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) — check them out [here](https://www.compdf.com/pdf-tools?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en).


<a id="architecture"></a>

## Architecture

```text
┌────────────────────────────────────────────────────────────────────┐
│                              Browser                               │
│                   http://localhost:8080/ in production             │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                                │ HTML/CSS/JS + HTTP /api/v1/*
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         compdf-server container                       │
│                 frontend/compdf-web + server                       │
│                        Server, port 8080                           │
├────────────────────────────────────────────────────────────────────┤
│ - Serves the Web UI from /app/public/compdf-web                    │
│ - Proxies PDF edit APIs: /api/v1/pdf/*                             │
│ - Proxies conversion APIs: /api/v1/* conversion routes             │
│ - Orchestrates async task status and downloads                     │
│ - Injects display-only license metadata into the Web UI            │
│ - Normalizes upstream errors and writes operation logs             │
└───────────────┬───────────────────────────────┬────────────────────┘
                │                               │
                │ HTTP                          │ MySQL / Redis
                ▼                               ▼
┌────────────────────────────────┐  ┌────────────────────────────────┐
│ compdf-app container           │  │ compdf-infra container         │
│                                │  │ MySQL 8 + Redis 7 + RustFS     │
│                                │  │ persistent Docker volumes      │
└────────────────────────────────┘  └────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         Project-mounted data                       │
├────────────────────────────────────────────────────────────────────┤
│ configs/: license.jwt, settings.yml, init.sql                      │
│ storage/: async task result files                                  │
│ fonts/: optional fonts mounted into the SDK container              │
└────────────────────────────────────────────────────────────────────┘
```

In local development, `compdf-infra` and `compdf-app` still run in Docker. The
NestJS middleware can run from `server/`, and the Web UI can run from
`frontend/compdf-web` with Vite hot reload.


## Upgrade to Enterprise

[Contact sales](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) to update to the **Enterprise Edition**.

| Feature               | Free Edition | Enterprise |
| --------------------- | ------------ | ---------- |
| PDF Editing           | ✅           | ✅          |
| PDF Conversion        | ✅           | ✅          |
| Web UI                | ✅           | ✅          |
| Dashboard             | ✅           | ✅          |
| Watermark-Free Output | ❌           | ✅          |
| Unlimited Pages       | ❌           | ✅          |
| Custom Concurrency    | ❌           | ✅          |
| Commercial License    | ❌           | ✅          |
| Technical Support     | ❌           | ✅          |

## Support

Have suggestions? [Start a discussion](https://github.com/ComPDFKit/compdf-self-hosted/discussions). If you find **ComPDF Self-Hosted** useful, please consider giving us a ⭐ **Star** on GitHub. It helps us grow and improve.


## License

- This project is licensed under the MIT License. See the LICENSE file for details.

- [Contact Sales](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) for the Commercial / Enterprise licenses for ComPDF Self-Hosted.

---

<p align="center">
  <b>Built by the ComPDF team.</b><br>
  <a href="https://compdf.com?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en">Website</a> ·
  <a href="https://www.compdf.com/guides/idp/self-hosted-deployment/overview?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en">Docs</a> ·
  <a href="https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en">Enterprise Inquiries</a>
</p>
