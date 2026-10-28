-- Upgrade the 1.0.0 Server schema to 1.1.0. Forward-only and safe to retry.

-- Batch file processing lifecycle. Forward-only and safe to retry.
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

-- Batch output manifests, attempt history and encrypted output passwords.
-- MySQL DDL commits implicitly; column checks make interrupted runs retryable.
SET @compdf_batch_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'batch_items' AND column_name = 'relative_path') = 0,
  'ALTER TABLE batch_items ADD COLUMN relative_path VARCHAR(1024) NULL AFTER sequence_no', 'SELECT 1');
PREPARE compdf_batch_stmt FROM @compdf_batch_ddl;
EXECUTE compdf_batch_stmt;
DEALLOCATE PREPARE compdf_batch_stmt;

SET @compdf_batch_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'batches' AND column_name = 'output_passwords_ciphertext') = 0,
  'ALTER TABLE batches ADD COLUMN output_passwords_ciphertext TEXT NULL AFTER options_json', 'SELECT 1');
PREPARE compdf_batch_stmt FROM @compdf_batch_ddl;
EXECUTE compdf_batch_stmt;
DEALLOCATE PREPARE compdf_batch_stmt;

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


-- API key ownership was added with the 1.1.0 Dashboard.
SET @compdf_owner_ddl = IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'api_keys' AND column_name = 'created_by_user_id') = 0,
  'ALTER TABLE api_keys ADD COLUMN created_by_user_id BIGINT NULL', 'SELECT 1');
PREPARE compdf_owner_stmt FROM @compdf_owner_ddl;
EXECUTE compdf_owner_stmt;
DEALLOCATE PREPARE compdf_owner_stmt;
