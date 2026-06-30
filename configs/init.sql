-- configs/init.sql — ComPDF Self-Hosted v4.1.0 server schema
--
-- Five tables owned by the server middleware.
--
-- Placeholder policy:
--   Placeholders <bcrypt-of-default-password> / <generated-key-id> /
--   <hash-of-generated-key> have been REMOVED. The admin user and the initial
--   API key are seeded on first boot by scripts/init-db.ts, which prints the
--   plaintext credentials exactly once. No literal placeholders remain in this
--   file, so re-running it cannot pollute the database with bogus rows.
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
  duration_ms INT          NULL,
  message     TEXT         NULL,
  stack       TEXT         NULL,
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_type_time (log_type, created_at),
  INDEX idx_level_time (level, created_at)
);

-- Async task storage for /api/v1/task/* (ComPDF-online-API-style envelope).
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
  status            VARCHAR(12)  NOT NULL DEFAULT 'pending', -- pending|processing|success|failed
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
  raw_token    TEXT         NULL,               -- current token passed through by middleware
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- System settings.
CREATE TABLE IF NOT EXISTS system_settings (
  id           TINYINT PRIMARY KEY DEFAULT 1,
  site_name    VARCHAR(100) NOT NULL DEFAULT 'ComPDF Self-Hosted',
  logo_path    VARCHAR(255) NULL,
  theme_color  VARCHAR(20)  NOT NULL DEFAULT '#1976D2',
  locale       VARCHAR(10)  NOT NULL DEFAULT 'zh-CN',
  dark_mode    TINYINT      NOT NULL DEFAULT 0,
  file_retention_days INT   NOT NULL DEFAULT 7,
  updated_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Idempotent initial rows. The admin user and first API key are generated by
-- scripts/init-db.ts on first boot and printed once, so no placeholders are
-- inserted here.
INSERT INTO system_settings (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;
INSERT INTO license_display (id) VALUES (1)
  ON DUPLICATE KEY UPDATE id = id;
