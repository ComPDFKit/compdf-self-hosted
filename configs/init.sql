-- configs/init.sql — ComPDF Self-Hosted v4.1.0 server schema
--
-- Six tables owned by the server application:
--   users, api_keys, operation_logs, login_records, tasks, license_display,
--   system_settings.
--
-- Placeholder policy:
--   Placeholders <bcrypt-of-default-password> / <generated-key-id> /
--   <hash-of-generated-key> have been REMOVED. The admin user and the initial
--   API key are seeded on first boot by scripts/init-db.ts, which persists the
--   API key plaintext for ComPDF Web auto-injection. If an active API key
--   already exists, init-db will not auto-generate another key. No literal
--   placeholders remain in this file, so re-running it cannot pollute the
--   database with bogus rows.
--
-- Authoritative source of license limits/enforcement is the SDK signature check,
-- NOT these tables: `license_display` is a display cache only.

CREATE DATABASE IF NOT EXISTS compdfkit CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE compdfkit;

-- Admin account.
CREATE TABLE IF NOT EXISTS users (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  username     VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,          -- bcrypt
  role         VARCHAR(20)  NOT NULL DEFAULT 'admin',
  status       TINYINT      NOT NULL DEFAULT 1, -- 1 active, 0 disabled
  token_version INT         NOT NULL DEFAULT 0, -- increment to invalidate issued JWT sessions
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME    NULL
);

-- API keys.
CREATE TABLE IF NOT EXISTS api_keys (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  key_id     VARCHAR(32)  NOT NULL UNIQUE,      -- public key identifier for display
  key_hash   VARCHAR(255) NOT NULL,             -- hashed secret used for validation
  status     TINYINT     NOT NULL DEFAULT 1,
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME  NULL
);

-- Operation logs.
CREATE TABLE IF NOT EXISTS operation_logs (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  log_type    VARCHAR(20)  NOT NULL,            -- user_action|api_call|error|system
  operator    VARCHAR(50)  NULL,                -- NULL for API calls, 'system' for system events
  api_key_id  VARCHAR(32)  NULL,
  method      VARCHAR(10)  NULL,
  endpoint    VARCHAR(255) NULL,
  feature     VARCHAR(50)  NULL,
  file_info   VARCHAR(255) NULL,
  status_code INT          NULL,
  level       VARCHAR(10)  NOT NULL,            -- INFO|WARN|ERROR|FATAL
  result      VARCHAR(10)  NULL,                -- success|fail
  result_category VARCHAR(20) NULL,             -- success|invalid|fail|exception (PRD §5 stat分类)
  action      VARCHAR(64)  NULL,                -- user_action: 操作行为 (e.g. update_settings)
  target      VARCHAR(255) NULL,                -- user_action: 操作对象 (e.g. site_name)
  duration_ms INT          NULL,                -- 仅成功请求记录耗时
  message     TEXT         NULL,
  stack       TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_time (log_type, created_at),
  INDEX idx_level_time (level, created_at),
  INDEX idx_category_time (result_category, created_at)
);

-- Login records. Separate from operation_logs on purpose: operation_logs answers
-- "what did the user do" (config change, API call, task create); login_records
-- answers "when/from where/with what result did someone try to log in". The two
-- have different query shapes, retention, and audiences (audit vs security).
CREATE TABLE IF NOT EXISTS login_records (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  username    VARCHAR(50)  NOT NULL,
  result      VARCHAR(10)  NOT NULL,            -- success|fail
  reason      VARCHAR(64)  NULL,                -- ok|invalid_credentials|locked|user_disabled
  ip          VARCHAR(45)  NULL,
  user_agent  VARCHAR(255) NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_username_time (username, created_at),
  INDEX idx_result_time (result, created_at)
);

-- Async task storage for /api/v1/task/* upload/status/download APIs.
-- Result FILES live on the filesystem at <storageDir>/<taskId>.bin (default
-- server/storage/); this table stores only the path (result_path), NOT the
-- BLOB — keeps the DB lean and avoids max_allowed_packet limits on large
-- results. All async ops wrap the SAME sync service calls.
CREATE TABLE IF NOT EXISTS tasks (
  id                BIGINT PRIMARY KEY AUTO_INCREMENT,
  task_id           CHAR(36)     NOT NULL UNIQUE,        -- UUID returned to the client
  api_key_id        VARCHAR(32)  NULL,                   -- which api_key created it
  kind              VARCHAR(12)  NOT NULL,               -- pdf | conversion
  op                VARCHAR(40)  NOT NULL,               -- merge | split | convert | convert-to-pdf | ...
  status            VARCHAR(12)  NOT NULL DEFAULT 'pending', -- pending|processing|success|failed|canceled
  file_name         VARCHAR(255) NULL,                   -- source file name
  down_file_name    VARCHAR(255) NULL,                   -- sanitized output file name
  file_size         BIGINT       NULL,                   -- source bytes
  convert_size      BIGINT       NULL,                   -- result bytes
  convert_time_ms   INT          NULL,
  failure_code      VARCHAR(64)  NULL,
  failure_reason    TEXT         NULL,
  result_path       VARCHAR(512) NULL,                   -- filesystem path to result file (NULL until success)
  result_content_type VARCHAR(128) NULL,
  created_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at        DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_status_created (status, created_at),
  INDEX idx_apikey_created (api_key_id, created_at)
);

-- License display cache. The SDK signature check is authoritative.
CREATE TABLE IF NOT EXISTS license_display (
  id           TINYINT PRIMARY KEY DEFAULT 1,
  license_id   VARCHAR(64)  NULL,               -- token subject
  status       VARCHAR(20)  NULL,               -- valid|expiring|expired|inactive
  scope        VARCHAR(255) NULL,
  platform     VARCHAR(64)  NULL,
  auth_method  VARCHAR(32)  NULL,
  nbf          DATETIME     NULL,
  exp          DATETIME     NULL,
  limits_json  TEXT         NULL,               -- raw token limits for display
  raw_token    TEXT         NULL,               -- current token passed through by the server
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- System settings. Brand config lives here (authoritative at runtime, NOT
-- settings.yml — that file is bootstrap defaults only). Both SPAs consume these
-- values via the SpaController-injected `window.COMPDF_CONFIG` payload.
CREATE TABLE IF NOT EXISTS system_settings (
  id           TINYINT PRIMARY KEY DEFAULT 1,
  site_name    VARCHAR(100) NOT NULL DEFAULT 'ComPDF Self-Hosted',
  logo_path    VARCHAR(255) NULL,
  theme_color  VARCHAR(20)  NOT NULL DEFAULT '#1976D2',
  locale       VARCHAR(10)  NOT NULL DEFAULT 'en',
  dark_mode    TINYINT      NOT NULL DEFAULT 0,
  file_retention_days INT   NOT NULL DEFAULT 7,
  -- v4.1.0 brand/marketing fields (nullable: NULL = "use frontend default"):
  upgrade_banner_text VARCHAR(255) NULL,   -- ComPDF Web fixed upgrade-prompt banner text
  doc_url             VARCHAR(255) NULL,   -- private-deployment documentation URL
  contact_url         VARCHAR(255) NULL,   -- "contact technical expert" form URL
  announcements_json  TEXT         NULL,   -- reserved: dashboard announcement cards
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Idempotent column adds for DBs already initialized with older users schema.
-- token_version increments whenever an admin password is reset/changed so already
-- issued JWT sessions become invalid immediately.
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='token_version');
SET @s := IF(@c=0,'ALTER TABLE users ADD COLUMN token_version INT NOT NULL DEFAULT 0 AFTER status','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;

-- Idempotent column adds for DBs already initialized with the v4.0 system_settings
-- schema (CREATE TABLE IF NOT EXISTS is a no-op when the table exists, so new
-- columns never get added without this guard). MySQL 8 has no ADD COLUMN IF NOT
-- EXISTS, so each column is guarded via INFORMATION_SCHEMA + PREPARE. The mysql2
-- driver runs these on a single connection, so the @c / @s user variables persist
-- across statements.
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='system_settings' AND COLUMN_NAME='upgrade_banner_text');
SET @s := IF(@c=0,'ALTER TABLE system_settings ADD COLUMN upgrade_banner_text VARCHAR(255) NULL','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='system_settings' AND COLUMN_NAME='doc_url');
SET @s := IF(@c=0,'ALTER TABLE system_settings ADD COLUMN doc_url VARCHAR(255) NULL','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='system_settings' AND COLUMN_NAME='contact_url');
SET @s := IF(@c=0,'ALTER TABLE system_settings ADD COLUMN contact_url VARCHAR(255) NULL','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='system_settings' AND COLUMN_NAME='announcements_json');
SET @s := IF(@c=0,'ALTER TABLE system_settings ADD COLUMN announcements_json TEXT NULL','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;
-- v4.1.0 operation_logs: result_category + action + target (idempotent adds for
-- DBs already initialized with the v4.0 schema). CREATE TABLE IF NOT EXISTS is
-- a no-op when the table exists, so these columns never get added without this
-- guard. MySQL 8 has no ADD COLUMN IF NOT EXISTS → INFORMATION_SCHEMA + PREPARE.
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='operation_logs' AND COLUMN_NAME='result_category');
SET @s := IF(@c=0,'ALTER TABLE operation_logs ADD COLUMN result_category VARCHAR(20) NULL AFTER result','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='operation_logs' AND COLUMN_NAME='action');
SET @s := IF(@c=0,'ALTER TABLE operation_logs ADD COLUMN action VARCHAR(64) NULL AFTER result_category','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;
SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='operation_logs' AND COLUMN_NAME='target');
SET @s := IF(@c=0,'ALTER TABLE operation_logs ADD COLUMN target VARCHAR(255) NULL AFTER action','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;

-- Idempotent initial rows. The admin user and first API key are generated by
-- scripts/init-db.ts on first boot, so no placeholders are inserted here.
INSERT INTO system_settings (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO license_display (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;
