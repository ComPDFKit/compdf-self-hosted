[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

# ComPDF Self-Hosted — 開源 PDF 編輯器與 PDF 轉檔工具

透過 [ComPDF Self-hosted](https://www.compdf.com/self-hosted-deployment?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)（KDAN 生態系統的一部分），一個基於 Docker 容器的開源 PDF 平台進行私有化部署，可用於編輯、轉換和處理 PDF、Office 格式、HTML、TXT、CSV、RTF、JSON 及圖片等文件。

> * 如果您覺得 ComPDF Self-Hosted 實用，請考慮在 GitHub 上為我們點一顆 ⭐ **Star**，這有助於我們成長與改進。
> * 有任何問題或想法？歡迎加入我們的 [Discussions](https://github.com/ComPDFKit/compdf-self-hosted/discussions) 討論。

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/docker-supported-blue" alt="Docker"></a>
  <a href="#"><img src="https://img.shields.io/github/stars/compdfkit/compdf-self-hosted" alt="GitHub Stars"></a>
  <a href="#"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen" alt="PRs Welcome"></a>
</p>

<p align="center">
    <a href="#功能特色"><b>功能特色</b></a> •
  <a href="#快速開始"><b>快速開始</b></a> •
  <a href="#系統架構"><b>系統架構</b></a> •
  <a href="#升級至企業版"><b>升級至企業版</b></a> •
   <a href="#支援"><b>支援</b></a> •
  <a href="#授權條款"><b>授權條款</b></a> •
  <a href="https://www.compdf.com/contact-sales?utm_source=github&utm_medium=referral&utm_campaign=compdf_self_hosted_open&ref_platform_id=github_compdfkit" target="_blank"><b>企業版 →</b></a>
</p>

## 為什麼選擇 ComPDF Self-Hosted？
不同於需要深度整合的傳統 SDK，ComPDF Self-Hosted 是一個可直接部署的開源 PDF 處理平台。它整合 PDF 編輯與轉檔功能，並支援圖像轉檔處理，涵蓋從文件到圖片的完整需求鏈，讓企業能夠快速擁有自主可控的文件中心。

### 主要優勢

* Docker Compose 部署
* 完整的 PDF 工具中心——編輯、轉換、合併、分割
* API 金鑰管理與授權管理
* 私有化部署，架構符合企業級標準
* 提供商業支援與專屬技術協助

無論您正在建置內部文件平台、文件自動化流程或企業 PDF 服務，ComPDF Self-Hosted 都能讓您在幾分鐘內快速上手。


<a id="features"></a>

## 功能特色
![Tools](images/tools.png)

ComPDF Self-Hosted 提供可直接在瀏覽器中使用的**開源 PDF 編輯器**、**開源 PDF 轉檔工具**與**開源圖片轉檔工具**中心。

### PDF 編輯

* 合併 PDF
* 分割 PDF
* 旋轉 PDF
* 插入頁面
* 刪除頁面
* 擷取頁面
* 新增浮水印
* 移除浮水印
* 加密 PDF
* 解密 PDF

### PDF 轉檔

#### PDF 轉其他格式

* PDF 轉 Word
* PDF 轉 Excel
* PDF 轉 Slide
* PDF 轉圖片
* PDF 轉 HTML
* PDF 轉 TXT
* PDF 轉 CSV
* PDF 轉 RTF
* PDF 轉 JSON
* PDF 轉 SearchablePDF
* PDF 轉 OFD


#### 其他格式轉 PDF

* Word 轉 PDF
* Excel 轉 PDF
* Slide 轉 PDF
* HTML 轉 PDF
* TXT 轉 PDF
* CSV 轉 PDF
* RTF 轉 PDF
* TIFF 轉 PDF

#### 圖片轉檔（開源圖片轉檔方案）

* 圖片轉 Word
* 圖片轉 Excel
* 圖片轉 Slide
* 圖片轉 HTML
* 圖片轉 CSV
* 圖片轉 TXT
* 圖片轉 RTF


<a id="quick-start"></a>

## 快速開始

### 1. 使用 Docker Compose 啟動

1. 複製倉庫並進入專案目錄：

```bash
git clone https://github.com/ComPDFKit/compdf-self-hosted.git
cd compdf-self-hosted
```

2. 啟動服務前先準備環境檔案：

```bash
cp .env.example .env
```

`.env` 中預設內建免費 License，用於本機開發、功能體驗與介面驗證。Docker Compose
會自動讀取專案目錄下的 `.env`。

3. 啟動完整服務：

```bash
docker compose up -d
```

4. 開啟 ComPDF Web：

```text
http://localhost:8080/
```

如需使用正式版授權，請將申請到的正式 License Key 替換到 `.env` 檔案中的
`COMPDF_LICENSE_KEY` 欄位。License Key 修改後需要重新啟動服務以生效。

**[申請正式版授權](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)，可獲得以下權益：**

* 無浮水印文件處理
* 無文件頁數限制
* 批次文件處理

### 2. 啟動開發環境

開發環境使用 Docker 啟動基礎設施與 SDK 服務，中介層和 Web UI 可在本機執行，
方便熱更新除錯。

終端機 1：啟動 MySQL、Redis、RustFS 和 SDK 服務：

```bash
docker compose -f docker-compose.dev.yml up -d compdf-infra compdf-app
docker compose -f docker-compose.dev.yml ps
```

常用開發健康檢查位址：

```text
http://localhost:7000/health
http://localhost:7001/livez
http://localhost:9903/health
```

終端機 2：本機啟動 Server 服務。它會透過開發 Compose 暴露到主機的連接埠連線
MySQL、Redis 和 SDK 服務：

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

中介層 API 位址：

```text
http://localhost:8080/api/v1/*
```

終端機 3：啟動 Web UI。Vite 會將 `/api` 代理到 `8080` 連接埠的中介層：

```bash
cd frontend/compdf-web
npm install
npm run dev
```

開啟 Vite 輸出的 URL，例如：

```text
http://localhost:5173/
```

若需區域網路存取，請使用 Vite 的 `Network` URL 中所列的機器 IP，並確保該機器也能存取中介層服務。

如果希望開發時也用 Docker 執行中介層：

```bash
docker compose -f docker-compose.dev.yml up -d --build compdf-infra compdf-app web
```

### 3. 查看狀態和日誌

```bash
docker compose ps
docker compose logs -f compdf-server
```

開啟 ComPDF Web：

```text
http://localhost:8080/
```

生產部署會把持久化資料存放在 Docker volumes 中，並將 `./configs` 掛載到中介層容器。

### 4. 從原始碼打包生產環境映像

如果修改了本機原始碼，需要從根目錄 `Dockerfile` 重新打包生產環境
`compdf-server` 映像，請使用以下命令。Dockerfile 會編譯 `frontend/compdf-web`、
建置 Server 服務端，將 Web UI 複製到 `/app/public/compdf-web`，並在 `8080`
連接埠啟動中介層。

```bash
docker compose -f docker-compose.yml up -d --build compdf-infra compdf-app compdf-server
```

以上功能均可於 [ComPDF](https://www.compdf.com/?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en) 上體驗使用，→ [體驗地址](https://www.compdf.com/pdf-tools?utm_source=github_ai_sefhosted_open_en&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_en&ref_platform_id=github_compdfkit_en)


<a id="architecture"></a>

## 系統架構

```text
┌────────────────────────────────────────────────────────────────────┐
│                              Browser                               │
│                   生產環境造訪 http://localhost:8080/                │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                                │ HTML/CSS/JS + HTTP /api/v1/*
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                         compdf-server container                       │
│                 frontend/compdf-web + server                       │
│                        Server, port 8080                           │
├────────────────────────────────────────────────────────────────────┤
│ - 從 /app/public/compdf-web 提供 Web UI                             │
│ - 代理 PDF 編輯 API: /api/v1/pdf/*                                  │
│ - 代理轉檔 API: /api/v1/* 轉檔路由                                    │
│ - 編排非同步任務狀態與下載                                             │
│ - 向 Web UI 注入僅供顯示的 license metadata                           │
│ - 標準化上游錯誤並寫入操作日誌                                          │
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
│                         專案掛載資料                                 │
├────────────────────────────────────────────────────────────────────┤
│ configs/: license.jwt、settings.yml、init.sql                       │
│ storage/: 非同步任務結果檔案                                          │
│ fonts/: 可選字型，掛載到 SDK 容器                                     │
└────────────────────────────────────────────────────────────────────┘
```

本機開發時，`compdf-infra` 和 `compdf-app` 仍執行在 Docker 中； Server 服務可從 `server/` 本機執行，Web UI 可從 `frontend/compdf-web` 透過 Vite 熱更新執行。


<a id="upgrade-to-enterprise"></a>

## 升級至企業版

[聯絡銷售團隊](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)以升級至 **Enterprise** 版。

| 功能 | 免費版 | 企業版 |
| --- | --- | --- |
| PDF 編輯 | ✅ | ✅ |
| PDF 轉檔 | ✅ | ✅ |
| Web 介面 | ✅ | ✅ |
| 儀表板 | ✅ | ✅ |
| 無浮水印輸出 | ❌ | ✅ |
| 不限制頁數 | ❌ | ✅ |
| 自訂並發數 | ❌ | ✅ |
| 商業授權 | ❌ | ✅ |
| 技術支援 | ❌ | ✅ |


<a id="support"></a>

## 支援

有任何建議？[發起討論](https://github.com/ComPDFKit/compdf-self-hosted/discussions)。如果您覺得 **ComPDF Self-Hosted** 實用，請考慮在 GitHub 上為我們點一顆 ⭐ **Star**，這有助於我們成長與改進。


<a id="license"></a>

## 授權條款

- 本專案採用 MIT 授權條款。詳見 LICENSE 檔案。
- ComPDF Self-Hosted 的商業版/企業版授權請[聯絡銷售團隊](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)。

---

<p align="center">
  <b>ComPDF 團隊打造</b><br>
  <a href="https://compdf.com?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw">官網</a> ·
  <a href="https://www.compdf.com/guides/idp/self-hosted-deployment/overview?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw">技術文件</a> ·
  <a href="https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw">企業洽詢</a>
</p>
