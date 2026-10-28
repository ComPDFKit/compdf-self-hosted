-- configs/init.sql — ComPDF Self-Hosted v1.1.0 server schema
--
-- Server tables include users, api_keys, operation_logs, login_records, tasks,
-- license_display, system_settings, schema_migrations and batch lifecycle tables.
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

-- The deployment layer creates the database and selects it through
-- DATABASE_NAME. Keep this baseline database-agnostic so custom database names
-- cannot accidentally initialize the default compdfkit database instead.

-- Applied database schema versions. New installations and legacy deployments
-- normalized by init-db.ts start at the 1.1.0 baseline; subsequent versions are
-- recorded only by the dedicated migration runner.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version    VARCHAR(32)  PRIMARY KEY,
  checksum   VARCHAR(128) NOT NULL,
  applied_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Admin account.
CREATE TABLE IF NOT EXISTS users (
  id           BIGINT PRIMARY KEY AUTO_INCREMENT,
  username     VARCHAR(50)  NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,          -- bcrypt
  role         VARCHAR(20)  NOT NULL DEFAULT 'admin',
  status       TINYINT      NOT NULL DEFAULT 1, -- 1 active, 0 disabled
  token_version INT         NOT NULL DEFAULT 0, -- increment to invalidate issued JWT sessions
  avatar_path  VARCHAR(255) NULL,
  created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at DATETIME    NULL
);

-- API keys.
CREATE TABLE IF NOT EXISTS api_keys (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  key_id     VARCHAR(32)  NOT NULL UNIQUE,      -- public key identifier for display
  key_hash   VARCHAR(255) NOT NULL,             -- hashed secret used for validation
  status     TINYINT     NOT NULL DEFAULT 1,
  created_by_user_id BIGINT NULL,               -- Dashboard user that created/provisioned the key
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_used_at DATETIME  NULL,
  INDEX idx_api_keys_creator (created_by_user_id)
);

-- Operation logs.
CREATE TABLE IF NOT EXISTS operation_logs (
  id          BIGINT PRIMARY KEY AUTO_INCREMENT,
  log_type    VARCHAR(20)  NOT NULL,            -- user_action|api_call|error|system
  operator    VARCHAR(50)  NULL,                -- API calls use the API key creator; 'system' for system events
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

-- Batch file processing. Each source/result is stored on disk; the database
-- stores lifecycle, lease and metadata so workers can resume after restart.
CREATE TABLE IF NOT EXISTS batches (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  batch_id CHAR(36) NOT NULL,
  api_key_id VARCHAR(32) NULL,
  kind VARCHAR(16) NOT NULL,
  op VARCHAR(64) NOT NULL,
  target VARCHAR(64) NULL,
  type VARCHAR(64) NULL,
  operation VARCHAR(64) NULL,
  request_json JSON NULL,
  options_json JSON NULL,
  output_passwords_ciphertext TEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  total_count INT UNSIGNED NOT NULL DEFAULT 0,
  queued_count INT UNSIGNED NOT NULL DEFAULT 0,
  processing_count INT UNSIGNED NOT NULL DEFAULT 0,
  success_count INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count INT UNSIGNED NOT NULL DEFAULT 0,
  canceled_count INT UNSIGNED NOT NULL DEFAULT 0,
  archive_path VARCHAR(512) NULL,
  idempotency_key VARCHAR(128) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batches_batch_id (batch_id),
  UNIQUE KEY uq_batches_api_idempotency (api_key_id, idempotency_key),
  KEY idx_batches_api_created (api_key_id, created_at),
  KEY idx_batches_status (status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS batch_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id CHAR(36) NOT NULL,
  batch_id CHAR(36) NOT NULL,
  sequence_no INT UNSIGNED NOT NULL,
  relative_path VARCHAR(1024) NULL,
  source_name VARCHAR(512) NOT NULL,
  source_path VARCHAR(512) NOT NULL,
  source_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  source_sha256 CHAR(64) NULL,
  source_password_ciphertext TEXT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'uploaded',
  attempt_count INT UNSIGNED NOT NULL DEFAULT 0,
  lease_owner CHAR(36) NULL,
  lease_until DATETIME NULL,
  output_path VARCHAR(512) NULL,
  output_name VARCHAR(512) NULL,
  output_content_type VARCHAR(128) NULL,
  output_size BIGINT UNSIGNED NULL,
  failure_code VARCHAR(64) NULL,
  failure_reason TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_items_item_id (item_id),
  UNIQUE KEY uq_batch_items_sequence (batch_id, sequence_no),
  KEY idx_batch_items_queue (status, lease_until, updated_at),
  KEY idx_batch_items_batch (batch_id, sequence_no),
  CONSTRAINT fk_batch_items_batch FOREIGN KEY (batch_id) REFERENCES batches(batch_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS batch_item_outputs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  output_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  output_sequence INT UNSIGNED NOT NULL,
  output_name VARCHAR(512) NOT NULL,
  output_path VARCHAR(512) NOT NULL,
  output_content_type VARCHAR(128) NOT NULL,
  output_size BIGINT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_outputs_output_id (output_id),
  UNIQUE KEY uq_batch_outputs_sequence (item_id, output_sequence),
  KEY idx_batch_outputs_item (item_id, output_sequence),
  CONSTRAINT fk_batch_outputs_item FOREIGN KEY (item_id) REFERENCES batch_items(item_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS batch_attempts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  attempt_id CHAR(36) NOT NULL,
  item_id CHAR(36) NOT NULL,
  attempt_no INT UNSIGNED NOT NULL,
  worker_id CHAR(36) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'processing',
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  failure_code VARCHAR(64) NULL,
  failure_reason TEXT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_batch_attempts_attempt_id (attempt_id),
  UNIQUE KEY uq_batch_attempts_number (item_id, attempt_no),
  KEY idx_batch_attempts_item (item_id, started_at),
  CONSTRAINT fk_batch_attempts_item FOREIGN KEY (item_id) REFERENCES batch_items(item_id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
  dark_mode    TINYINT      NOT NULL DEFAULT 0,
  file_retention_days INT   NOT NULL DEFAULT 7,
  -- v1.1.0 brand/marketing fields (nullable: NULL = "use frontend default"):
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

SET @c := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='avatar_path');
SET @s := IF(@c=0,'ALTER TABLE users ADD COLUMN avatar_path VARCHAR(255) NULL AFTER token_version','DO 1'); PREPARE _p FROM @s; EXECUTE _p; DEALLOCATE PREPARE _p;

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
-- v1.1.0 operation_logs: result_category + action + target (idempotent adds for
-- previously initialized databases). CREATE TABLE IF NOT EXISTS is
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
