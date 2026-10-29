# Connect sastrybalm.in to Convo

## Current status — 29 October 2026

The configured store is **https://sastrybalm.in**. A public, read-only check confirmed HTTPS and the WooCommerce REST API. The WordPress API index did not advertise the `wa-commerce/v1` bridge namespace. No authenticated store access, checkout, payment, or message was performed.

Convo remains in **demo mode**. Saving credentials or passing a connection check does not switch its catalog or workers to live mode. The local app uses persistent MAMP MySQL, with no automatic memory fallback. Its sample catalog is explicitly labelled as demo data.

| Information | Authoritative source when live |
| --- | --- |
| Products, variations, prices and availability | WooCommerce API |
| Coupons, tax, delivery rates and final checkout totals | WooCommerce calculations through the bridge |
| Store orders and verified payment status | WooCommerce; the app keeps durable records linking assistant checkouts to store orders |
| Conversations, staff accounts, sessions, jobs and audit history | Convo's own MySQL database |
| Message delivery status | Meta WhatsApp API and signed callbacks, persisted in Convo |

The Orders screen lists orders created through this assistant. It does **not** import all historical website orders or customers. Product searches return up to ten matches; this is an API-backed search, not a full catalog mirror. The assistant rechecks stock and checkout totals before placing an order.

## Install and pair the connector

Use a staging copy first if available. A staging copy needs its own keys, database, phone/test account and sandbox gateway. Only the live URL has been supplied so far.

1. In WordPress, open **Plugins → Add New Plugin → Upload Plugin**. Upload `artifacts/wa-commerce-bridge-0.2.0.zip` and activate **WhatsApp Commerce Bridge**. It requires WooCommerce and PHP 8.1 or newer. Activation creates the bridge's checkout-session mapping table; existing products and orders are not imported or changed.
2. Open **WooCommerce → WhatsApp Bridge** over HTTPS as an administrator. Select **Generate new connection key**. Copy the key while it is displayed; WordPress saves only a SHA-256 digest. Generating another key revokes the previous key. **Disable connection** revokes access.
3. In Convo, open **Integrations → WooCommerce → Configure**. Enter the key in **Bridge bearer secret**. Keep the store URL as `https://sastrybalm.in` for this store. Do not send keys in chat or put them in a URL.
4. In WordPress, open **WooCommerce → Settings → Advanced → REST API → Add key**. Use a dedicated account with only the capabilities needed for the integration and select **Read**. Enter the consumer key and consumer secret in Convo's WooCommerce settings. Read permission can cover other resources that account may read; it is not a product-only permission. The separate bridge handles checkout writes. [WooCommerce authentication documentation](https://developer.woocommerce.com/docs/apis/rest-api/authentication/)
5. Save, restart the app and worker, and use the WooCommerce connection check. In demo mode this explicitly checks catalog/bridge read access and reports that normal application data remains simulated. It does not create an order or send a message.

Existing installations may instead manage a strong `WA_COMMERCE_BRIDGE_SECRET` in `wp-config.php`. That constant takes precedence and disables key management in the admin page; rotate or remove it through the hosting configuration. Use a random secret of at least 32 characters, not an example value.

Convo saves secrets on the server in its restricted environment file (mode 0600); the settings API returns empty values for secret fields. This file is not encrypted by the app. Protect the host and backups, use encrypted disks, and use a deployment secret manager when hosting publicly.

## Live activation requires a separate deployment

The local MAMP app is a development environment. `localhost` cannot receive callbacks from WooCommerce or Meta. Before activating real checkout, provide a public HTTPS app address and configure the WhatsApp account, encrypted Flow endpoint, AI provider and approved message templates as described in [setup](setup.md).

Create a **fresh database** for each live staging/production deployment. Apply migrations first; then configure its final live mode, store URL, WhatsApp phone and integration environment before creating operators or starting the API/worker. Do not start it once in demo mode and then change the same database to live. A database is bound to that identity at first startup; changes and unmarked databases containing business records are refused. Existing records are preserved for deliberate review/migration. Do not delete the identity marker to bypass the check, and do not copy demo orders, sessions or jobs into a live database.

Set a separately generated `WOO_WEBHOOK_SECRET` of at least 32 characters in both Convo and WooCommerce. Configure `order.created` and `order.updated` deliveries to `https://YOUR-APP-DOMAIN/api/webhooks/woocommerce`. The app verifies signatures and retrieves the store's canonical order/payment state before treating payment as verified. Monitor delivery failures and reconciliation. [WooCommerce webhook documentation](https://developer.woocommerce.com/docs/best-practices/urls-and-routing/webhooks/)

Before production, verify a real staging checkout with the site's actual products, stock rules, taxes, coupons, delivery plugins, required checkout fields, HPOS setting, caches and gateway. Test duplicate/retried checkout requests, stock changes, failed/cancelled payments, verified payments and webhook recovery. The local PHP checks do not establish compatibility with those plugins. See [acceptance tests](uat.md).

## Security checks and limits

The bridge requires HTTPS and a private bearer key on every route. It exposes catalog currency, checkout quotes, pending-order creation, and lookup/payment status for bridge-created orders; it does not provide refund, product-editing or user-management endpoints. Requests have bounded sizes, quantities and validated fields. Responses explicitly prohibit caching. Key changes require administrator access and a WordPress nonce. [WordPress endpoint permissions and validation](https://developer.wordpress.org/rest-api/extending-the-rest-api/adding-custom-endpoints/)

The app checks staff roles, sessions, request origins, CSRF tokens and signed callbacks. It rejects example shared secrets in live mode, redirects on outbound API requests, payment links outside the connected store origin, and credential reuse when changing stores. Database writes use parameterized queries; the local runtime database account is restricted to application data operations. API and worker startup both enforce the database identity.

On 29 October 2026, **88 automated tests passed, with zero failures or skips**, including actual isolated MySQL persistence/concurrency tests and the PHP security contract harness. First live startup also refuses unmarked staff accounts, sessions, settings, audit and usage records. JavaScript syntax checks and PHP lint passed. The dependency audit reported zero known vulnerabilities at that time. Provider responses in automated tests were mocked; the PHP harness does not run WordPress/WooCommerce itself.

No software can be guaranteed unhackable. Live credentials, real WordPress plugin compatibility, hosting access controls, TLS/proxy configuration and end-to-end payments remain unverified. Keep WordPress/WooCommerce/plugins updated, restrict administrative access, use strong unique passwords and WordPress MFA, rate-limit public endpoints at the hosting layer, and maintain protected, tested backups. Review and rotate keys after any suspected exposure. Installing the connector alone is not production acceptance.
