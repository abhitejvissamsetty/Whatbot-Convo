CREATE TABLE IF NOT EXISTS wa_mock_orders (
  id VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  data JSON NOT NULL,
  checkout_session_id VARCHAR(64) GENERATED ALWAYS AS (JSON_UNQUOTE(JSON_EXTRACT(data, '$.checkout_session_id'))) STORED,
  UNIQUE KEY uq_mock_checkout (checkout_session_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS wa_mock_messages (
  id VARCHAR(190) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  data JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
