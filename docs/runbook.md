# Operations runbook

## Health and monitoring

Monitor `/api/health` through an internal monitoring path. It performs a database transaction and returns a non-sensitive status. Private console metrics show job/outbox/event counts, verified payments, and handoff backlog. Logs contain correlation IDs, error codes, job types, and attempt counts; they omit webhook bodies, phones, addresses, tokens, and payment links. Do not enable proxy body/header logging or raw provider error logging.

The new administration workspace separates Overview, Conversations, Orders, Checkout sessions, Delivery & jobs, Integrations, Team & access, Settings, and Activity log. Use [the panel guide](panel.md) for each control. Apply migration 002 before upgrading a MySQL installation.

Alert on sustained HTTP 5xx/signature failures, failed jobs, blocked/uncertain messages, pending-payment age, order mismatch codes, reconciliation lag, and growing handoff backlog. Forward application stdout to the organization's log/metrics stack. Configure access-log path redaction and exclude webhook query strings from stored URLs because verification URLs contain tokens.

Use the administrator **Delivery & jobs** page to see failed jobs and blocked/uncertain messages. Failed jobs can be retried after the root cause is corrected. A job retries at most six times with exponential backoff; resetting a failed job restarts that counter. Never retry indefinitely without investigation. **Review** on an uncertain delivery records the provider check and closes the case without an automatic resend.

## Payment and order issues

- Customers saying “paid” is not evidence. Check the Woo order, gateway transaction, amount/currency, and paid date. The backend requires a transaction ID and current paid state.
- Webhook retries only enqueue reconciliation. Periodic reconciliation also checks linked orders created within the configured retention horizon. Increase that horizon or perform supervised reconciliation for longer-lived orders.
- `ORDER_MISMATCH` stops processing. Inspect checkout-session metadata and quoted versus actual Woo amounts. Do not alter payment verification to bypass the mismatch.
- A pending order can be repaid through its canonical link while WooCommerce permits it. Failed/cancelled orders may require store-approved recovery; do not generate arbitrary replacement orders.
- Zero-value orders, manual/offline gateways, and refunds require explicit store policy. Refund status can be notified; the bot never initiates a refund. Historical `PAID_VERIFIED` is preserved alongside current fulfillment/refund state.
- If a bridge request times out, retry the original checkout session. Never replace its ID to force a second order. The plugin checks both its mapping table and Woo order metadata.

## Message delivery and handoff

- Messages outside the 24-hour window require an approved template. Configure it, then retry a `blocked` message from the administrator console.
- `uncertain` means Meta acceptance could not be established after a send or worker crash. Check Meta's delivery records before any supervised resend. The console deliberately does not automatically retry these messages.
- Delivery-status webhooks are retained in the conversation history. A later “sent” event cannot regress a “read” status.
- Human handoff pauses future conversational bot replies and Flow sends; an already in-flight provider request cannot be recalled. Verified transactional updates continue. Operators claim a thread before replying; releasing assignment keeps the bot paused. **Resume bot** is explicit.
- Replies obey the same service-window rules. Ordinary operator messages outside the window are blocked; have an approved customer-reengagement procedure.

## Data lifecycle and deletion

The default `RETENTION_DAYS=30` deletes old messages, events, AI usage counters, completed/failed jobs, sent/suppressed outbox records, and finished/expired Flow data. Authentication sessions expire after eight hours. Blocked/uncertain outbox items remain until reviewed because they may require recovery.

Customer IDs, conversations, order links, and handoff history are retained until supervised deletion; they are needed for order authorization and auditing. Decide their legal retention periods before launch. Backups must follow the same approved retention policy. Data minimization is not permission to erase financial records required by the store.

For a verified deletion request: authenticate the requester, identify the customer by WhatsApp ID, stop their pending conversational jobs, resolve pending orders and uncertain deliveries, delete/anonymize linked local customer/conversation/message/cart/Flow/handoff/usage records in a database transaction, and apply the approved order-link policy. Do not delete operator records or another customer's records. WooCommerce/payment records and backups have separate store-owned deletion procedures. This version supplies a dry-run-first local cleanup CLI; see below. It does not delete provider records.

```sh
npm run customer:delete -- 919876543210
npm run customer:delete -- 919876543210 --apply
```

The CLI requires MySQL and refuses active unpaid orders, queued/running work, or unresolved delivery outcomes. Use only after verifying the request and resolving those conditions. Deletion also removes that customer's local order links; export any legally required audit evidence under the approved policy first. Subsequent customer order access will require supervised re-verification.

## Secrets, deployment, and rollback

Store `.env` and RSA private keys outside the checkout with restrictive permissions. Rotate Meta tokens, app/verify secrets, Woo keys, the bridge bearer secret, webhook HMAC secret, OpenAI key, and operator passwords through the organization's secret-management process. Update both endpoints when rotating shared secrets; verify signature checks in staging first. Rotating the Flow key requires re-registering the public key and testing decryption before resuming checkout.

Back up MySQL and the WordPress database before releases; test restoration. Deploy one backend and one worker initially. Run migrations once with a migration user, then start the runtime services. The repository includes PM2/Nginx samples, but domain, TLS, secret paths, monitoring, and capacity values must be supplied for your environment.

For rollback: pause inbound processing at the proxy while preserving provider retries, stop the worker, retain all database/session mappings, revert application and plugin to the last compatible artifacts, restore configuration, verify health, then resume workers and callbacks. Do not erase order mappings or restore a stale database over new orders. Migration 001 is additive; no automatic destructive down migration is provided. Reconcile orders and inspect uncertain messages after recovery.
