# Convo · WhatsApp WooCommerce Assistant

An implementation of the supplied specification: WhatsApp product discovery, encrypted checkout Flows, WooCommerce pending orders and payment links, verified payment updates, and a full administration workspace.

The redesigned panel includes Overview, Conversations, Orders, Product catalog, Checkout sessions, Integrations, Delivery & jobs, Team & access, Activity log, Settings, account security, and a dedicated mock Test lab. Read the [panel guide](docs/panel.md) for controls and configuration behavior.

AI service selection supports **OpenAI, Anthropic Claude, Google Gemini, DeepSeek, Groq, OpenRouter, Ollama, and custom OpenAI-compatible endpoints**. Choose the provider and load or enter its model in the panel. See [AI provider setup](docs/ai-providers.md). Only the selected provider's credentials are required in live mode.

**Status:** runnable demo with persistent MAMP MySQL and live provider adapters. The configured store is `https://sastrybalm.in`; only its public API availability has been checked. Authenticated store access, staging acceptance and production activation remain pending. Start with the [store connection and security guide](docs/store-connection.md) and the installable bridge in `artifacts/wa-commerce-bridge-0.2.0.zip`.

## Run the local demo

Requires Node.js 22.9+ (implemented and checked here with Node.js 26). Dependencies are optional for the in-memory mock server; live mode requires `npm install`.

```sh
cp .env.example .env
```

Set `MOCK_OPERATOR_EMAIL` and a unique `MOCK_OPERATOR_PASSWORD` of at least 12 characters in `.env`. These are local demo credentials, not production credentials.

```sh
npm start
```

Open **http://localhost:3000** and sign in. Open **Test lab** from the sidebar. Its customer simulator accepts:

- `Hi` — list fixture products.
- `variants 101` — list T-shirt variations.
- `buy 101 1001 x2` — start a two-item T-shirt checkout.
- `buy 102 x1` — start a Canvas Bag checkout.
- `human` — request an operator.
- `pay 5001` — resend the existing payable order's link after checking ownership and current Woo state.

Choose **Open latest checkout** to preview the screens. The mock preview offers clearly identified sample contact/address values; change them as needed. Use the customer's WhatsApp ID as the checkout phone, a six-digit Indian PIN, and state code `TS`. `DEMO10` is a mock-only coupon. The order ID is filled after confirmation; choose **Simulate verified payment** to test the notification. All catalog values and payment links are fixtures; `.invalid` links cannot take payments. The Test lab requires an authenticated administrator and CSRF protection.

With `STORE_DRIVER=memory`, mock data resets when the process restarts. With `STORE_DRIVER=mysql`, application records and simulated provider orders/messages persist in MySQL, including login sessions, settings, request limits, and error counts. Set `REQUIRE_PERSISTENCE=true` to reject accidental memory storage. A missing or unavailable MySQL database causes a failure; it never falls back to memory. See [local MAMP setup](docs/mamp.md).

Mock routes are omitted in live mode, and mock mode only binds to loopback. If your environment blocks listening sockets, the HTTP contract tests still run through the same request handler without opening ports.

## Validate

```sh
npm test
npm run check
```

The real MySQL integration case is skipped unless `MYSQL_TEST_URL` names a dedicated test database and dependencies have been installed. PHP lint and WordPress/Meta/gateway acceptance require their respective runtimes/accounts.

The optional `npm run test:browser` suite uses Playwright and captures screenshots; see the [panel guide](docs/panel.md). Existing MySQL installations must apply migration 002 with `npm run db:migrate` before starting this version.

## Project layout

| Area | Location |
|---|---|
| Configuration, bootstrap, HTTP server | `src/config`, `src/bootstrap.js`, `src/http` |
| Persistence and migrations | `src/db` |
| WooCommerce, Meta, OpenAI, and mock adapters | `src/adapters` |
| Provider registry, native/compatible AI adapters, model discovery | `src/ai` |
| Agent, checkout, orders, events, operator services | `src/services` |
| Durable queue, outbox, maintenance | `src/jobs` |
| Private operator console and mock journey | `public` |
| WhatsApp Flow artifact | `flows/checkout.json` |
| Private WordPress bridge | `wordpress/wa-commerce-bridge` |
| Unit, contract, integration, and journey tests | `tests` |

Read [setup](docs/setup.md), [module architecture](docs/architecture.md), [operations](docs/runbook.md), and [acceptance status](docs/uat.md) before staging deployment.

## Create your GitHub repository

From your desktop terminal, install GitHub CLI, sign in with `gh auth login --hostname github.com --git-protocol https`, and run `gh auth setup-git --hostname github.com`. Then run `npm run repo:create` from this folder. An optional name can be supplied with `npm run repo:create -- your-repository-name`.

The helper creates a private repository under your authenticated GitHub account, uses your username and ID-based no-reply email as the initial commit's author and committer, and sets the package author, repository URL, and README maintainer to that owner. It requires a project without existing commits or an origin remote, preserves existing history, and refuses publication if local environment files or private keys are staged. It needs network access and write access to `.git`.

## Important implementation limits

- Dependencies and the npm lockfile are included; use `npm ci` for reproducible installation.
- The MySQL repository uses JSON documents with generated unique columns and a single database-row lock for domain transactions. This deliberately serializes the single-store MVP; remote checkout calls can hold the lock. Expected traffic must be load-tested before release. Higher volume requires indexed per-aggregate queries and narrower locks.
- The bridge handles simple products, fully specified variations, ordinary coupons, and a single shipping package. Bundles, subscriptions, open-ended variation attributes, required custom checkout fields, and multiple shipping packages require store-specific extension and staging validation. Unsupported cases fail closed.
- Zero-total orders and gateways that do not record a transaction ID require an explicit alternative payment-verification policy; the current backend does not claim they are paid.
- Exactly-once order creation is enforced by session recovery and uniqueness. Exactly-once external message delivery cannot be guaranteed after a network timeout; uncertain sends are surfaced for manual provider review.
- Flow JSON is provided in English; the conversational agent supports English and Telugu. Validate translations with native speakers during UAT.
- No public storefront, marketing campaigns, media understanding, AI refunds, native WhatsApp payments, or full CRM is included.
