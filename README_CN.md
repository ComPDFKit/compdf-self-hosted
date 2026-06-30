[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

# ComPDF Self-Hosted — 开源 PDF 编辑器与 PDF 转换器

通过 [ComPDF Self-hosted](https://www.compdf.com/self-hosted-deployment?utm_source=github_ai_sefhosted_open_zh&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_zh&ref_platform_id=github_compdfkit_zh) (KDAN 生态系统的一部分)，一个基于 Docker 容器的开源 PDF 平台进行私有部署，可用于编辑、转换和处理 PDF、Office 格式、HTML、TXT、CSV、RTF、JSON 及图片等文档。

> * 如果您觉得 ComPDF Self-Hosted 实用，请考虑在 GitHub 上为我们点一颗 ⭐ **Star**，这有助于我们成长与改进。
> * 有任何问题或想法？欢迎加入我们的 [Discussions](https://github.com/ComPDFKit/compdf-self-hosted/discussions) 讨论。

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/docker-supported-blue" alt="Docker"></a>
  <a href="#"><img src="https://img.shields.io/github/stars/compdfkit/compdf-self-hosted" alt="GitHub Stars"></a>
  <a href="#"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome"></a>
</p>

<p align="center">
  <a href="#功能特性"><b>功能特性</b></a> •
  <a href="#快速开始"><b>快速开始</b></a> •
  <a href="#系统架构"><b>系统架构</b></a> •
  <a href="#升级至企业版"><b>升级至企业版</b></a> •
   <a href="#支持"><b>支持</b></a> •
  <a href="#许可协议"><b>许可协议</b></a> •
  <a href="https://www.compdf.com/contact-sales?utm_source=github&utm_medium=referral&utm_campaign=compdf_self_hosted_open&ref_platform_id=github_compdfkit" target="_blank"><b>企业版 →</b></a>
</p>

## 为什么选择 ComPDF Self-Hosted？

不同于需要深度集成的传统 SDK，ComPDF 自托管版是一个可直接部署的开源 PDF 处理平台。它集 PDF 编辑、转换于一身，同时支持图像转换处理，让企业快速拥有自主可控的文档中心。

### 主要优势

* Docker Compose 部署
* 完整的 PDF 工具中心——编辑、转换、合并、拆分
* API 密钥管理与许可证管理
* 私有部署，架构符合企业级标准
* 提供商业支持与专属技术支持

无论您正在搭建内部文档平台、文档自动化流程还是企业 PDF 服务，ComPDF Self-Hosted 都能让您在几分钟内快速上手。


<a id="features"></a>
## 功能特性
![Tools](images/tools.png)

ComPDF Self-Hosted 提供可直接在浏览器中使用的**开源 PDF 编辑器**、**开源 PDF 转换器**与**开源图片转换器**中心。

### PDF 编辑

* 合并 PDF
* 拆分 PDF
* 旋转 PDF
* 插入页面
* 删除页面
* 提取页面
* 添加水印
* 移除水印
* 加密 PDF
* 解密 PDF

### PDF 转换

#### PDF 转其他格式

* PDF 转 Word
* PDF 转 Excel
* PDF 转 Slide
* PDF 转图片
* PDF 转 HTML
* PDF 转 TXT
* PDF 转 CSV
* PDF 转 RTF
* PDF 转 JSON
* PDF 转 SearchablePDF
* PDF 转 OFD

#### 其他格式转 PDF

* Word 转 PDF
* Excel 转 PDF
* Slide 转 PDF
* HTML 转 PDF
* TXT 转 PDF
* CSV 转 PDF
* RTF 转 PDF
* TIFF 转 PDF

#### 图片转换（开源图片转换方案）

* 图片转 Word
* 图片转 Excel
* 图片转 Slide
* 图片转 HTML
* 图片转 CSV
* 图片转 TXT
* 图片转 RTF


<a id="quick-start"></a>

## 快速开始

### 1. 使用 Docker Compose 启动

1. 克隆仓库并进入项目目录：

```bash
git clone https://github.com/ComPDFKit/compdf-self-hosted.git
cd compdf-self-hosted
```

2. 启动服务前先准备环境文件：

```bash
cp .env.example .env
```

`.env` 中默认内置免费 License，用于本地开发、功能体验与接口验证。Docker Compose
会自动读取项目目录下的 `.env`。

3. 启动完整服务：

```bash
docker compose up -d
```

4. 打开 ComPDF Web：

```text
http://localhost:8080/
```

如需使用正式版许可证，请将申请到的正式 License Key 替换到 `.env` 文件中的
`COMPDF_LICENSE_KEY` 字段。License Key 修改后需要重启服务以生效。

**[申请正式版许可证](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_zh&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_zh&ref_platform_id=github_compdfkit_zh)，可获得以下权益：**

* 无水印文档处理
* 无文档页数限制
* 批量文档处理

### 2. 启动开发环境

开发环境使用 Docker 启动基础设施与 SDK 服务，中间层和 Web UI 可在本地运行，
方便热更新调试。

终端 1：启动 MySQL、Redis、RustFS 和 SDK 服务：

```bash
docker compose -f docker-compose.dev.yml up -d compdf-infra compdf-app
docker compose -f docker-compose.dev.yml ps
```

常用开发健康检查地址：

```text
http://localhost:7000/health
http://localhost:7001/livez
http://localhost:9903/health
```

终端 2：本地启动  Server 服务。它会通过开发 Compose 暴露到宿主机的端口连接
MySQL、Redis 和 SDK 服务：

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

中间层 API 地址：

```text
http://localhost:8080/api/v1/*
```

终端 3：启动 Web UI。Vite 会将 `/api` 代理到 `8080` 端口的中间层：

```bash
cd frontend/compdf-web
npm install
npm run dev
```

打开 Vite 输出的 URL，例如：

```text
http://localhost:5173/
```

如需局域网访问，请使用 Vite 的 `Network` URL 中所列的机器 IP，并确保该机器也能访问中间层服务。

如果希望开发时也用 Docker 运行中间层：

```bash
docker compose -f docker-compose.dev.yml up -d --build compdf-infra compdf-app web
```

### 3. 查看状态和日志

```bash
docker compose ps
docker compose logs -f compdf-server
```

打开 ComPDF Web：

```text
http://localhost:8080/
```

生产部署会把持久化数据存放在 Docker volumes 中，并将 `./configs` 挂载到中间层容器。

### 4. 从源码打包生产环境镜像

如果修改了本地源码，需要从根目录 `Dockerfile` 重新打包生产环境
`compdf-server` 镜像，请使用以下命令。Dockerfile 会编译 `frontend/compdf-web`、
构建 Server 服务端，将 Web UI 复制到 `/app/public/compdf-web`，并在 `8080`
端口启动中间层。

```bash
docker compose -f docker-compose.yml up -d --build compdf-infra compdf-app compdf-server
```

以上功能均可在 [ComPDF](https://www.compdf.com/?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) 上体验使用，→[体验地址](https://www.compdf.com/pdf-tools?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en)


<a id="architecture"></a>

## 系统架构

```text
┌────────────────────────────────────────────────────────────────────┐
│                              Browser                               │
│                   生产环境访问 http://localhost:8080/                │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                                │ HTML/CSS/JS + HTTP /api/v1/*
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         compdf-server container                       │
│                 frontend/compdf-web + server                       │
│                       Server, port 8080                            │
├────────────────────────────────────────────────────────────────────┤
│ - 从 /app/public/compdf-web 提供 Web UI                             │
│ - 代理 PDF 编辑 API: /api/v1/pdf/*                                  │
│ - 代理转换 API: /api/v1/* 转换路由                                    │
│ - 编排异步任务状态与下载                                               │
│ - 向 Web UI 注入仅用于展示的 license 元数据                            │
│ - 标准化上游错误并写入操作日志                                          │
└───────────────┬───────────────────────────────┬────────────────────┘
                │                               │
                │ HTTP                          │ MySQL / Redis
                ▼                               ▼
┌────────────────────────────────┐   ┌────────────────────────────────┐
│ compdf-app container           │   │ compdf-infra container         │
│                                │   │ MySQL 8 + Redis 7 + RustFS     │
│                                │   │ 持久化 Docker volumes           │
└────────────────────────────────┘   └────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         项目挂载数据                                 │
├────────────────────────────────────────────────────────────────────┤
│ configs/: license.jwt、settings.yml、init.sql                       │
│ storage/: 异步任务结果文件                                            │
│ fonts/: 可选字体，挂载到 SDK 容器                                      │
└────────────────────────────────────────────────────────────────────┘
```

本地开发时，`compdf-infra` 和 `compdf-app` 仍运行在 Docker 中；Server 服务层
可从 `server/` 本地运行，Web UI 可从 `frontend/compdf-web` 通过 Vite 热更新运行。


<a id="upgrade-to-enterprise"></a>

## 升级至企业版

[联系销售](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_cn&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_cn&ref_platform_id=github_compdfkit_cn)  升级至 **Enterprise 版**

| 功能 | 免费版 | 企业版 |
| --- | --- | --- |
| PDF 编辑 | ✅ | ✅ |
| PDF 转换 | ✅ | ✅ |
| Web 界面 | ✅ | ✅ |
| 仪表板 | ✅ | ✅ |
| 无水印输出 | ❌ | ✅ |
| 不限制页数 | ❌ | ✅ |
| 自定义并发数 | ❌ | ✅ |
| 商业许可证 | ❌ | ✅ |
| 技术支持 | ❌ | ✅ |

<a id="support"></a>

## 支持

有任何建议？[发起讨论](https://github.com/ComPDFKit/compdf-self-hosted/discussions)。如果您觉得 **ComPDF Self-Hosted** 实用，请考虑在 GitHub 上为我们点一颗 ⭐ **Star**，这有助于我们成长与改进。


<a id="license"></a>

## 许可协议

- 本项目采用 MIT 许可协议。详见 LICENSE 文件。
- ComPDF Self-Hosted 的商业版/企业版许可证请[联系销售团队](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_zh&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_zh&ref_platform_id=github_compdfkit_zh)。

---

<p align="center">
  <b>ComPDF 团队打造</b><br>
  <a href="https://compdf.com?utm_source=github_ai_sefhosted_open_zh&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_zh&ref_platform_id=github_compdfkit_zh">官网</a> ·
  <a href="https://www.compdf.com/guides/idp/self-hosted-deployment/overview?utm_source=github_ai_sefhosted_open_zh&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_zh&ref_platform_id=github_compdfkit_zh">技术文档</a> ·
  <a href="https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_zh&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_zh&ref_platform_id=github_compdfkit_zh">企业咨询</a>
</p>
