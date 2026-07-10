# <mark>⚠️ 倉庫地址已遷移</mark>

<mark>**本倉庫已停止維護，最新程式碼與後續更新請前往新倉庫查看：[https://github.com/ComPDF/compdf-self-hosted](https://github.com/ComPDF/compdf-self-hosted)**</mark>



[English](README.md) | [繁體中文](README_TW.md) | [简体中文](README_CN.md)

# ComPDF Self-hosted — 開源 PDF 編輯器與 PDF 轉檔工具

透過 [ComPDF Self-hosted](https://www.compdf.com/self-hosted-deployment?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)（KDAN 生態系），可快速完成採用 Docker 容器的私有化部署，實現編輯、轉換和處理 PDF、Office 格式、HTML、TXT、CSV、RTF、JSON 及圖片等文件。



> * 如果您覺得 ComPDF Self-hosted 實用，請考慮在 GitHub 上為我們點一顆 ⭐ **Star**，這有助於我們成長與改進。
> * 有任何問題或想法？歡迎加入我們的 [Discussions](https://github.com/ComPDF/compdf-self-hosted/discussions) 討論。

<p align="center">
  <a href="#"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
  <a href="#"><img src="https://img.shields.io/badge/docker-supported-blue" alt="Docker"></a>
  <a href="#"><img src="https://img.shields.io/github/stars/compdf/compdf-self-hosted" alt="GitHub Stars"></a>
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

不同於需要深度整合的傳統 SDK，ComPDF Self-hosted 是一個可直接部署的開源 PDF 處理平台。它整合 PDF 編輯與轉檔功能，並支援圖像轉檔處理，涵蓋從文件到圖片的完整需求鏈，讓企業能夠快速擁有自主可控的文件中心。

### 主要優勢

* Docker Compose 部署
* 完整的 PDF 工具中心——編輯、轉換、合併、分割
* API 金鑰管理與授權管理
* 私有化部署，架構符合企業級標準
* 提供商業支援與專屬技術協助

無論您正在建置內部文件平台、文件自動化流程或企業 PDF 服務，ComPDF Self-hosted 都能讓您在幾分鐘內快速上手。

<a id="features"></a>

## 功能特色

![Tools](images/tools.png)

### 1. PDF 工具中心

ComPDF Self-hosted 提供可直接在瀏覽器中使用的**開源 PDF 編輯器**、**開源 PDF 轉檔工具**與**開源圖片轉檔工具**中心。

| 類別        | 功能                                                                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PDF 編輯    | 合併 PDF，分割 PDF，旋轉 PDF，插入頁面，刪除頁面，擷取頁面，新增浮水印，移除浮水印，加密 PDF，解密 PDF                                                                                                                                |
| PDF 轉其他格式 | PDF 轉 Word，PDF 轉 Excel，PDF 轉 Slide，PDF 轉 Image（PNG，JPG，JPEG，JPEG2000，BMP，TIFF，TGA，GIF，WEBP），PDF 轉 HTML，PDF 轉 TXT，PDF 轉 CSV，PDF 轉 RTF，PDF 轉 JSON，PDF 轉 SearchablePDF，PDF 轉 OFD，PDF 轉 Markdown |
| 其他格式轉 PDF | Word 轉 PDF，Excel 轉 PDF，Slide 轉 PDF，HTML 轉 PDF，TXT 轉 PDF，CSV 轉 PDF，RTF 轉 PDF，PNG 轉 PDF                                                                                                        |
| 圖片轉其他格式   | 圖片轉 Word，圖片轉 Excel，圖片轉 Slide，圖片轉 HTML，圖片轉 CSV，圖片轉 TXT，圖片轉 RTF，圖片轉 JSON，圖片轉 PDF                                                                                                               |

### 2. Dashboard 控制台

ComPDF Self-hosted 提供統一管理控制台，用於查看 API Key、API 呼叫情況與 License 狀態，並支援操作記錄審計、帳號管理及系統基礎配置等核心功能。

![Dashboard](images/dashboard.png)

* 概覽面板：展示 API Key 詳情、API 呼叫數據、授權（License）範圍及狀態等資訊。
* 操作日誌：追蹤、搜尋，並匯出所有操作日誌
* 帳號管理：設定使用者名稱與密碼
* 系統設定：設定系統名稱、標誌與主題色

<a id="quick-start"></a>

## 快速開始

### 1. 使用 Docker Compose 啟動

1. 複製倉庫並進入專案目錄：

```bash
git clone https://github.com/ComPDF/compdf-self-hosted.git
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

4. 開啟 ComPDF Web 和 Dashboard：

```text
ComPDF Web: http://localhost:8080/
Dashboard:  http://localhost:8080/admin
```

首次部署時，Dashboard 預設管理員帳號為：`admin / admin`

如需使用正式版授權，請將申請到的正式 License Key 替換到 `.env` 檔案中的
`COMPDF_LICENSE_KEY` 欄位。License Key 修改後需要重新啟動服務以生效。

**[申請正式版授權](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)，可獲得以下權益：**

* 無浮水印文件處理
* 無文件頁數限制
* 批次文件處理

### 2. 啟動開發環境

開發環境使用 Docker 啟動基礎設施與 SDK 服務，Server 服務和 Web UI 可在本機執行，
方便熱更新除錯。

啟動開發環境：

```bash
docker compose -f docker-compose.dev.yml up -d --build compdf-infra compdf-app compdf-server
docker compose -f docker-compose.dev.yml ps
```

Server API 地址：

```text
http://localhost:8080/api/v1/
```

也可查看[文檔](https://www.compdf.com/guides/pdf-sdk/self-hosted-deployment/overview?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)

開啟 ComPDF Web 和 Dashboard：

```text
ComPDF Web: http://localhost:8080/
Dashboard:  http://localhost:8080/admin
```

### 3. 查看狀態和日誌

```bash
docker compose ps
docker compose logs -f compdf-server
```

生產部署會把持久化資料存放在 Docker volumes 中，並將 `./configs` 掛載到 Server 容器。

### 4. 從原始碼打包生產環境映像

如果修改了本機原始碼，需要從根目錄 `Dockerfile` 重新打包生產環境
`compdf-server` 映像，請使用以下命令。Dockerfile 會建置 `frontend/compdf-web`
中的 ComPDF Web 與 Dashboard，並將靜態資源複製到 `/app/public/compdf-web`；
隨後建置 Server 服務端，在 `8080` 連接埠統一提供頁面和 API。

```bash
docker compose -f docker-compose.yml up -d --build compdf-infra compdf-app compdf-server
```

以上功能均可於 [ComPDF](https://www.compdf.com/?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw) 上體驗使用，→ [體驗地址](https://www.compdf.com/pdf-tools?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)

<a id="architecture"></a>

## 系統架構

```text
┌────────────────────────────────────────────────────────────────────┐
│                              Browser                               │
│          生產環境造訪 / 使用 ComPDF Web，造訪 /admin 使用 Dashboard       │
└───────────────────────────────┬────────────────────────────────────┘
                                │
                                │ HTML/CSS/JS + HTTP /api/v1/*
                                ▼
┌────────────────────────────────────────────────────────────────────┐
│                       compdf-server container                      │
│          ComPDF Web + Dashboard + Server, port 8080                │
├────────────────────────────────────────────────────────────────────┤
│ - 從 /app/public/compdf-web 提供 ComPDF Web 與 Dashboard             │
│ - ComPDF Web 使用 /api/v1/process/* 和 /api/v1/task/* 完成文件處理       │
│ - Dashboard 使用 /api/v1/dashboard/* 管理 API Key、License、日誌和設定    │
│ - 編排非同步任務狀態、取消與下載                                         │
│ - 向頁面注入品牌設定、API Key 和僅供顯示的 license metadata                │
│ - 標準化處理服務錯誤並寫入操作日誌                                       │
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

本機開發時，`compdf-infra`、`compdf-app` 和 `compdf-server` 都透過
`docker-compose.dev.yml` 執行，以確保服務之間的連線方式與實際部署拓撲一致。

<a id="upgrade-to-enterprise"></a>

## 升級至企業版

[聯絡銷售團隊](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)以升級至 **Enterprise** 版。

| 功能     | 免費版 | 企業版 |
| ------ | --- | --- |
| PDF 編輯 | ✅   | ✅   |
| PDF 轉檔 | ✅   | ✅   |
| Web 介面 | ✅   | ✅   |
| 儀表板    | ✅   | ✅   |
| 無浮水印輸出 | ❌   | ✅   |
| 不限制頁數  | ❌   | ✅   |
| 自訂並發數  | ❌   | ✅   |
| 商業授權   | ❌   | ✅   |
| 技術支援   | ❌   | ✅   |

## 文檔

### 開發文檔

https://www.compdf.com/documentation?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw

### API Reference

https://www.compdf.com/guides/pdf-sdk/self-hosted-deployment/api-reference-conversion?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw

### SDK 文檔

https://www.compdf.com/guides/pdf-sdk/self-hosted-deployment/overview?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw

<a id="support"></a>

## 支援

有任何建議？[發起討論](https://github.com/ComPDF/compdf-self-hosted/discussions)。如果您覺得 **ComPDF Self-hosted** 實用，請考慮在 GitHub 上為我們點一顆 ⭐ **Star**，這有助於我們成長與改進。

<a id="license"></a>

## 授權條款

- 本專案採用 MIT 授權條款。詳見 LICENSE 檔案。
- ComPDF Self-hosted 的商業版/企業版授權請[聯絡銷售團隊](https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw)。

---

<p align="center">
  <b>ComPDF 團隊打造</b><br>
  <a href="https://compdf.com?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw">官網</a> ·
  <a href="https://www.compdf.com/guides/idp/self-hosted-deployment/overview?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw">技術文件</a> ·
  <a href="https://www.compdf.com/contact-sales?utm_source=github_ai_sefhosted_open_tw&utm_medium=referral&utm_campaign=github_ai_sefhosted_open_tw&ref_platform_id=github_compdfkit_tw">企業洽詢</a>
</p>
