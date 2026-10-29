# Acceptance and milestone evidence

Local checks exercise real service/HTTP-handler logic with mock provider state and both memory and isolated MySQL storage. They do **not** demonstrate live account eligibility, tax/shipping plugin compatibility, gateway processing, native-language quality, or successful Flow publication.

The original implementation passed 35 local tests. Subsequent verification history is retained below. The latest report supersedes the earlier environment limitations: MAMP MySQL/PHP and the local browser are now available. Provider calls in automated tests remain mocked; no external writes were performed.

| ID | Scenario | Local evidence | Staging status |
|---|---|---|---|
| A01 | Inbound greeting/product query | Signature, dedupe, catalog and HTTP journey tests | Pending real WhatsApp/Woo query |
| A02 | Variable product selection | Exact variation preserved into mock order | Pending real variation purchase |
| A03 | Stock changes | Order blocked after stock changes | Pending real Woo reservation/concurrency |
| A04 | Invalid PIN/unavailable shipping | Invalid input and correction response, no order | Pending shipping-zone/plugin tests |
| A05 | Coupon/tax/shipping | Mock coupon/total equality | Pending taxable/exempt/inclusive/exclusive tax and real coupon/rate cases |
| A06 | Duplicate submission/retry | Eight concurrent submissions and remote-commit timeout recovery | Pending bridge crash/concurrency/HPOS validation |
| A07 | Unsuccessful payment/customer claims paid | Unpaid and failed remain unverified | Pending gateway failure/cancel tests |
| A08 | Verified successful payment | One notification on repeated reconciliation | Pending sandbox gateway paid date/transaction |
| A09 | Out-of-order/missed webhook | Scheduled reconciliation and no paid regression | Pending callback disable/re-enable recovery |
| A10 | Another customer's order | Access denied without order details | Pending two real phone numbers |
| A11 | English/Telugu | Mock bilingual facts; mocked Responses tool continuation | Pending real model/native-speaker UAT |
| A12 | Human handoff | Pause, claim, deduplicated reply, resume | Pending actual staff workflow and messaging-window tests |

Additional local cases: password hashing, authentication/CSRF/origin checks, encrypted request/response and tamper rejection, stale/expired sessions, explicit confirmation, quote changes, unknown/invalid tools, AI turn/tool budgets, redacted AI context, template blocking, known-failure backoff, ambiguous message delivery, and non-regressing message statuses.

## Original execution constraints (superseded by later reports)

- Node.js is installed. Registry DNS/network access failed, so Express/mysql2 were not installed and no lockfile was generated.
- MySQL/PHP executables are absent and Docker access is denied. Real MySQL tests are opt-in and skipped locally; PHP lint and plugin runtime tests remain pending.
- This sandbox denies listening on `127.0.0.1:3000` with `EPERM`. Tests inject requests into the HTTP handler without sockets. No browser screenshot/visual verification was claimed.
- No Meta, OpenAI, WooCommerce, WordPress, gateway, or production credentials were provided. All automated provider calls are mocked.

## Milestone status

M1–M5 implementation artifacts and local tests are present. Their live staging exit gates remain open. M6 deployment/runbook artifacts are present; security review, dependency review, capacity testing, staged UAT and production approval remain open.

For every staged case, attach date, environment/version, tester, input, expected/observed result, relevant redacted correlation IDs, and evidence location. Production readiness must not be declared until all A01–A12 and the store-specific compatibility gates pass.

## Administration redesign verification — 28 October 2026

- `npm run check`: passed, including the new frontend modules and browser-check script.
- `npm test`: **53 passed, 1 real-MySQL case skipped, 0 failures**.
- The 17 administration regression cases cover policy propagation/conflicts, validation, assistant and delivery pause/resume, actual template selection, safe environment persistence/masking, authorization/CSRF, truthful dashboard data, checkout cancellation, reconciliation, team/session controls, password changes, uncertain-delivery review, read-check identity/invalidation, opaque-secret quoting, and HTTP controls/assets.
- The WooCommerce adapter regression verifies that untracked stock is represented as unknown quantity, rather than an invented large stock count.
- `npm run test:browser`: blocked by `listen EPERM` in this environment. An independent Chromium launch also failed. No screenshots or successful browser run are claimed. The portable browser suite and CI screenshot capture are provided for an unrestricted environment.
- No existing `.env` credentials, production settings, or provider accounts were modified by these tests. Credential-write cases use temporary environment files.

## Login and static asset regression follow-up

The current suite passes **61 tests**, with **1 opt-in MySQL test skipped**. Login checks include localhost/loopback aliases, protected dashboard access, and startup module availability. Asset checks verify JavaScript MIME types, GET/HEAD responses, newly added public modules, and availability despite API rate limits. The local restart discovery test ensures workers and unrelated applications are not selected. Browser acceptance remains blocked by the execution environment; the user's running server must be restarted to load backend changes.

## Multiple AI providers — latest verification

`npm run check` passed and `npm test` completed with **75 passed, 1 MySQL test skipped, 0 failures**. Eight provider-contract tests cover native Claude/Gemini tool continuations, Gemini thought signatures, compatible service routing/reasoning metadata, model discovery/pagination, credential isolation, immutable per-turn selection, and malformed-output rejection. Six configuration tests cover provider/model persistence, masked credentials, invalid settings, model-discovery authentication/CSRF, selected-provider completeness, active-key reuse, and live configuration with Claude and no OpenAI key. All external API responses are mocked. The browser suite was extended for the provider/model chooser but remains unverified here because browser/socket execution is restricted. No real account access checks or generation calls were performed.

## MAMP persistence and store security — 29 October 2026

This report supersedes the earlier local environment limitations above.

- **88 tests passed, zero failures, zero skips**, using `PHP_BIN=/Applications/MAMP/bin/php/php8.3.28/bin/php node --env-file=.env.test-mysql scripts/test.js`. MySQL tests use a separate disposable database, never the app database or store database.
- Actual MySQL checks cover migrations, rollback, cross-connection locking, uniqueness and persistence of checkout, payment, message, settings, session and rate-limit records across three processes. An unavailable database fails instead of falling back to memory.
- Identity tests reject mode/store/phone/environment changes, unmarked business data, malformed identity records, competing initial binding, and unmarked staff/session/configuration records on first live startup. Rejected migrations preserve records.
- Security cases cover shared-secret quality, HTTPS configuration, payment-URL origin checks, masked-credential isolation when changing stores, administrator-only read checks and continued demo isolation.
- The PHP 8.3.28 contract harness exercises connector authentication, HTTPS, administrator capability and nonce checks, key rotation/revocation, validated request shapes and bounds, protected routes and no-store response headers. All three PHP source files passed lint. This harness does not run WordPress/WooCommerce or certify plugin compatibility.
- JavaScript syntax checks passed. A point-in-time dependency audit reported zero known vulnerabilities.
- The local app restarted successfully; health reported `mock` and `mysql`, and the browser retained its signed-in session. Browser inspection confirmed explicit sample catalog labels, 12px sidebar text, 16px body text and no horizontal page overflow at the current viewport. Screenshots are in `artifacts/security-review/`.
- The installable `artifacts/wa-commerce-bridge-0.2.0.zip` contains only the three checked PHP files and the readme. Archive contents were compared byte-for-byte with source; its checksum and verification details are recorded in `artifacts/security-review/verification.json`.
- The supplied store's public HTTPS/REST index responded and advertised WooCommerce, but did not advertise the bridge namespace. No authenticated store request, external write, message, order or payment was performed. Store credentials, real staging checkout/gateway/webhook tests and production hosting acceptance remain pending; the app remains demo.

Use [the connection guide](store-connection.md) for installation, key handling, deployment separation and remaining acceptance steps.
