# Setup and staging integration

## 1. Confirm prerequisites

Record store URL, WooCommerce/WordPress/PHP versions, product types, HPOS setting, tax/shipping/coupon plugins, gateway, sandbox credentials, WhatsApp WABA and phone eligibility, HTTPS domain, expected volume, retention/deletion rules, and operator account owners. Do not reuse production credentials for staging.

Use supported Node.js, MySQL 8.0+, PHP 8.1+, an existing staging WooCommerce site, and a sandbox gateway. Every participating WooCommerce/WordPress order, metadata, item, reservation, and bridge-mapping table must use InnoDB. The bridge wraps order creation and mapping in one transaction; store checkout hooks must not issue commits or schema changes. Validate crash recovery with the site's actual plugins and object cache. The bridge uses HPOS metadata queries when HPOS is active; validate the store's WooCommerce version supports them. Required custom checkout fields, advanced product types, and multiple shipping packages need additional implementation before that store can go live.

## 2. Install backend and database

```sh
npm install
cp .env.example .env
```

Use `npm ci` with the provided `package-lock.json` for reproducible installation. Review dependencies before release.

Create a dedicated MySQL database and migration user. Set `STORE_DRIVER=mysql` and `MYSQL_URL`. For initial migration, keep `APP_MODE=mock` so external credentials are unnecessary:

```sh
npm run db:migrate
```

Use a runtime database user with only application-table DML privileges after migration; it does not need schema-change privileges. Migration 002 adds `wa_settings` and `wa_audit`; migration 003 adds durable demo-provider orders and messages. Apply all migrations with a separate migration account before upgrading. Set `REQUIRE_PERSISTENCE=true` to require MySQL even in mock mode. Use TLS to remote MySQL and encrypted, access-controlled storage/backups.

Use a fresh database for each live environment. Migrations do not bind its identity; application startup and operator creation do. Configure the final live mode, store, phone and staging/production environment before provisioning live operators. Never run a demo against the intended live database. Existing identities or unmarked business data that conflict with configuration cause startup to fail; review migrations deliberately rather than deleting the identity marker.

Provision operators after configuration is complete, using a secret manager or protected stdin (passwords are never command arguments):

```sh
read -s operator_password
printf '%s' "$operator_password" | npm run operator:create -- owner@example.com admin
unset operator_password
```

For additional staff, pass `operator` instead of `admin`. Do not commit credentials to the repository. Demo bootstrap variables are ignored in live mode.

## 3. Install the WooCommerce bridge on staging

Upload `artifacts/wa-commerce-bridge-0.2.0.zip` through WordPress Plugins and activate it (or copy `wordpress/wa-commerce-bridge` into `wp-content/plugins`). Activation creates a private checkout-session mapping table. Over HTTPS, open **WooCommerce → WhatsApp Bridge** as an administrator and generate a connection key. Copy it into backend `WOO_BRIDGE_SECRET`; WordPress stores only its hash. Generating another key revokes the old one. Existing secret-manager deployments may instead define `WA_COMMERCE_BRIDGE_SECRET` in `wp-config.php` using a cryptographically random secret of at least 32 characters; this takes precedence over the admin-managed key. See the [store connection guide](store-connection.md).

Create dedicated WooCommerce REST API credentials for catalog reads and set `WOO_URL`, `WOO_KEY`, and `WOO_SECRET`. Read-only keys suffice for the catalog because writes use the separate bridge. Set `WOO_WEBHOOK_SECRET`; configure `order.updated` plus relevant order-created/status webhooks to `/api/webhooks/woocommerce` using that secret.

Validate baseline store checkout, tax settings, coupons, stock behavior, variable products, shipping zones/rates, and the gateway's order-pay page. The bridge uses WooCommerce cart calculations and checkout hooks, but plugin compatibility must be demonstrated; it cannot be inferred from API access. Confirm guest payment verification behavior. Default required Woo fields such as email and surname remain required by the store even though Flow email is optional; enter them when requested. Custom checkout fields require Flow/bridge extensions.

## 4. Configure Meta and the Flow

Set up the developer app, WABA, system-user token, test phone, and required permissions. Choose an account-supported `META_GRAPH_VERSION`; set `META_TOKEN`, `META_PHONE_NUMBER_ID`, `META_APP_SECRET`, and a separate `META_VERIFY_TOKEN`.

Configure the GET/POST callback at `https://YOUR-STAGING-DOMAIN/api/webhooks/whatsapp` and subscribe to messages. Verify real inbound text and status events before enabling checkout.

Generate an RSA keypair using your secret-management workflow; the private key must not be committed. Register the public key for the business phone and configure the private key path/passphrase. Import `flows/checkout.json`, set the encrypted data endpoint to `/api/flows/data`, and fix any validator differences for the chosen Meta Flow version. Test all four screens and signed requests. Record `META_FLOW_ID`. Staging sends the Flow in draft mode; production sends published mode.

Publish only after endpoint/phone tests pass. Validate text/labels with native speakers. Flow back navigation moves one persisted screen backward and invalidates the prior quote; validate native-client navigation during UAT.

## 5. AI provider and messaging templates

Select an AI provider and a tool-capable model in **Integrations → AI provider → Configure**. Available integrations include OpenAI, Anthropic Claude, Google Gemini, DeepSeek, Groq, OpenRouter, Ollama, and custom compatible endpoints. The application does not guess an account-accessible model; use **Load available models** or enter its exact ID. Each provider has separate masked credentials. OpenAI remains the default for existing configurations. See [AI provider setup](ai-providers.md) for environment fields, model discovery, local endpoints, and restart behavior.

The agent sends redacted recent text history and catalog tool outputs to the selected service; checkout address/contact data bypasses the AI tool arguments. Do not ask customers to send card data or passwords. Test the selected provider/model's factual English/Telugu responses and tool execution in staging.

Set daily-turn, tool-call, and output-token limits to fit the approved budget. Verify model tool quality and factual English/Telugu responses with real product queries before acceptance.

Configure approved utility templates in `META_TEMPLATES`, mapping `payment_verified`, `order_status`, and optionally `payment_pending` to `{ "name": "...", "language": "en" }`. Each configured body takes **two text parameters: order ID and status**. Templates and their categories/content must be approved by Meta. A template can direct the customer to reply to retrieve their payment link; this implementation does not inject a payment URL into template parameters or buttons. Missing templates block out-of-window delivery visibly in the console.

## 6. Enable live adapters on staging

Set `APP_MODE=live`, `INTEGRATION_ENVIRONMENT=staging`, the HTTPS `PUBLIC_URL`, and all required credentials. `NODE_ENV=production` means hardened runtime configuration; `INTEGRATION_ENVIRONMENT` controls staging versus published Flow behavior. Keep integrations on sandbox accounts until acceptance is complete.

The panel can save integration details to the environment file; these apply only after restarting both processes. Set `CONFIG_ENV_PATH` when the loaded environment file is outside the project directory. Operational policies/templates apply through the shared database. See [panel configuration](panel.md).

```sh
npm start
npm run worker
```

Run these as separate services backed by the same database. Use Nginx TLS termination and only trust forwarded HTTPS in WordPress when your proxy configuration is correct. Express does not trust client-forwarded IP headers; use Nginx limits for public traffic and keep the application bound to loopback on the host.

## 7. Verify before release

```sh
npm test
npm run check
php -l wordpress/wa-commerce-bridge/wa-commerce-bridge.php
```

To exercise the real database, set `MYSQL_TEST_URL` to a **dedicated disposable database**, then run `npm test`. That test applies migrations and creates/cleans only its own test records. It must never target production.

Complete every row in `docs/uat.md` against real staging providers and sandbox payments. Record evidence and operator signoff. Production configuration changes and deployment require explicit approval after reviewing the staged result.
