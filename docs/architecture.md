# Modules and implementation

This repository follows the approved 13-module plan. It is one backend and one background worker, with a static private console and a WooCommerce bridge plugin.

| Module | Implemented behavior |
|---|---|
| Foundation | Validated configuration, provider interfaces, health, request correlation, syntax/test scripts |
| Customer/conversation storage | Customer IDs, message history, carts/revisions, expiring Flows, order links, handoffs, users/sessions |
| WhatsApp gateway | Raw signature checks, challenge, normalized messages/statuses, outbound text/Flow/template adapter |
| Background reliability | Durable jobs/outbox, leases, deduplication, backoff, failures and uncertainty visibility |
| Catalog | Published products, variations, live purchasability and stock checks; no catalog cache in v1 to avoid stale data |
| AI orchestration | Selectable native/compatible providers, common tool interface, schema/input constraints, bounded calls/output/daily turns, redacted history, bilingual policy |
| Cart/session service | Approved IDs/quantities, revision binding, random tokens, expiry, screen sequencing |
| WhatsApp Flows | Four screens, RSA-OAEP/AES-GCM endpoint, encrypted responses, server validation, explicit quote confirmation |
| Woo bridge | Woo cart calculations, required billing/address checks, shipping/coupon checks, native checkout order creation/payment URL |
| Orders | Session lookup recovery, unique mapping, payable amount checks, verified paid state, customer-owned lookup |
| Notifications | Window-aware delivery, configured approved templates, deduplicated payment/status updates |
| Operator console | Login, inbox, history, assignment, replies, release/resume, metrics, administrator operations review |
| Operations | Periodic reconciliation, expired-session handling, transient-data retention, runbooks and deployment samples |

## Data flow

1. Verify a webhook over raw bytes. Persist a deduplicated event and job in one transaction before acknowledgement.
2. A worker claims the job with a lease. Text messages enter the agent only while the bot is active.
3. Catalog tools read WooCommerce. Checkout tools create a Flow session bound to that customer and cart revision.
4. The encrypted Flow endpoint advances PRODUCT → CUSTOMER → DELIVERY → REVIEW. Customer/address data goes directly to WooCommerce, not into agent tool arguments.
5. REVIEW contains an authoritative quote fingerprint. Final confirmation re-quotes, looks for a remotely committed order, and creates a pending order only if needed.
6. The WordPress bridge serializes creation by checkout-session key using a MySQL advisory lock. An InnoDB transaction groups Woo order creation, metadata, stock reservation, and bridge mapping. Metadata lookup also provides recovery for legacy/partial mappings. Store plugins must preserve transaction boundaries; validate crash recovery before launch.
7. The backend commits its link and payment-link outbox entry together. Payment takes place on the existing WooCommerce order-payment page.
8. Signed Woo events enqueue reconciliation; the worker fetches current order state and verifies identity, amounts, paid state, and transaction ID before sending confirmation.

Customers can reply `pay ORDER_ID` to retrieve an existing payable order's canonical link. The worker checks ownership, current payable state, identity and amounts; it never creates a replacement order. Payment URLs are sent directly by the backend rather than through LLM context.

## Public contracts

| Route | Authentication | Purpose |
|---|---|---|
| `GET /api/webhooks/whatsapp` | Verify token | Meta challenge |
| `POST /api/webhooks/whatsapp` | Meta HMAC over raw bytes | Messages, statuses, Flow completion |
| `POST /api/flows/data` | Meta HMAC + RSA/AES protocol + session token | Flow transitions |
| `POST /api/webhooks/woocommerce` | Woo HMAC over raw bytes | Order reconciliation intake |
| `GET /api/health` | No secrets in output | Database-backed readiness |

Operator endpoints are under `/api/operator`: `login`, `logout`, `me`, `conversations`, `metrics`, `overview`, `orders`, `catalog`, `checkouts`, and `conversations/:id/{messages,claim,reply,release,resume}`. Administrator endpoints additionally manage `settings`, `deployment`, `system`, `team`, `queue`, `audit`, `retry`, `maintenance`, delivery review, and read-only integration checks. Order actions queue reconciliation or send an existing payable order's link. All mutations require the configured origin; authenticated mutations also require the session's CSRF header. Replies include a client-generated request ID. No public account creation exists. Operators share the single store's inbox; assignment controls mutation, not visibility. The [panel guide](panel.md) describes controls and the boundary between runtime, credential, infrastructure, and WooCommerce settings.

Bridge endpoints are under `/wp-json/wa-commerce/v1`: `GET catalog-context` (store currency), `POST quote`, `POST orders`, `GET orders/:checkout_session_id`, and `GET order-status/:order_id`. HTTPS and a separate bearer secret are required. The backend's Woo REST key is used only for catalog reads; the bridge owns checkout writes.

`POST /api/operator/ai/models` is administrator/CSRF protected and performs explicit read-only discovery with the chosen provider and optionally an entered key/base URL/API version. It returns model metadata and never returns credentials. AI selection is saved through the versioned deployment editor; the `ai` integration replaces the OpenAI-only card. The legacy `/integrations/openai/check` path aliases the selected-AI read check. The provider adapters and immutable per-turn selection are documented in [AI providers](ai-providers.md).

`quote` accepts approved `lines`, `customer`, `delivery`, `shipping_method`, and `coupon`, returning items, methods, subtotal, discount, shipping, tax, currency, total, and fingerprint. `orders` additionally requires `checkout_session_id` and `expected_fingerprint` and returns order identity, paid/status data, and the canonical payable URL. The LLM has access to neither bridge method nor credentials.

## State and reliability

Flow state: `FLOW_ACTIVE` → `QUOTE_VALIDATED` → `ORDER_PENDING`, or `EXPIRED`. The linked order separately tracks payment (`PAYMENT_PENDING`, `PAID_VERIFIED`, `FAILED`, `CANCELLED`, `REFUNDED`) and fulfillment. Once payment is verified, historical verification is preserved even if a later fetch appears unpaid; the current fulfillment/refund status is recorded separately.

The Flow protocol does not independently authenticate a WhatsApp sender on each screen. Its random token is a short-lived capability bound to one customer/cart. Never log or expose it outside the intended customer channel. A signed completion message is also checked against its verified sender and cannot create an order.

Jobs are at-least-once. Order creation and local notification scheduling are idempotent. Message sends record `sending` before contacting Meta; connection loss or worker death during sending yields `uncertain`, rather than an automatic duplicate. Known HTTP rejections retry with exponential backoff, up to six attempts. Expired leases can be reclaimed. Template-blocked messages are not sent outside the service window.

The database is an MVP document repository backed by InnoDB, not a high-throughput event platform. Generated unique indices enforce WhatsApp IDs, provider message IDs, Flow tokens, checkout/Flow/Woo order mappings, and operator emails. Versioned migrations use a database advisory lock. Do not run more than one worker until staging load tests validate lock behavior.

## Documentation checked during implementation

- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling): Responses function calls and corresponding outputs, strict schemas, continuation items.
- [Meta endpoint cryptography reference](https://github.com/WhatsApp/WhatsApp-Flows-Tools/blob/main/examples/endpoint/nodejs/basic/src/encryption.js): RSA-OAEP SHA-256, AES-128-GCM, and complemented response IV. The implementation here is independently written.
- [WooCommerce checkout reference](https://woocommerce.github.io/code-reference/classes/WC-Checkout.html): native order creation from the Woo cart.

Provider capabilities and versions must be revalidated against the actual accounts during staging setup. The full Meta guide was rate-limited during this session; Flow Builder validation/publication remains a release gate.
