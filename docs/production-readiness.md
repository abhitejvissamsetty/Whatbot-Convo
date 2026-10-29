# Production review baseline — 29 October 2026

This software is a working local demo with persistent MySQL and live-provider adapters. It is **not yet accepted for production**. The intended store is `https://sastrybalm.in`; authenticated store integration and real staging checkout remain pending.

## Included and verified

- Administration panel, conversations, product lookup, checkout Flows, assistant-created orders, payment verification, operator handoff, settings, audit history and durable processing queues.
- Persistent MAMP MySQL with no automatic memory fallback; database identity separates demo/live deployments, stores, phones and environments.
- WooCommerce bridge 0.2.0 with HTTPS/bearer protection, administrator-only key generation/revocation, hash-only key storage and bounded requests.
- 88 automated tests passed with no failures or skips against this repository copy. These include isolated real MySQL checks and a PHP security contract harness. JavaScript syntax checks passed.
- A separate private local backup was restored into a temporary database: all 19 tables' data, column metadata and indexes matched. Credentials, database dumps and private backups are excluded from this repository.

Automated provider calls use mocks. The PHP harness does not run the actual WordPress/WooCommerce installation. Local passing tests do not establish real gateway/plugin compatibility or production security.

## Required customer experience still to implement

Shopping, contact/address entry, account creation/linking, order review and support must remain inside WhatsApp. Only payment should require external navigation.

The current connector creates guest orders. It does **not** yet create WooCommerce customer accounts, verify/link existing website accounts, or prefill returning-customer addresses. Implement explicit account ownership verification before exposing saved addresses or order history. A typed email address or billing phone alone must never grant account access. WooCommerce should remain authoritative for customer accounts and addresses.

After secure linking, returning customers should be able to shop again, repeat an order, confirm/edit saved delivery details and check their order status in WhatsApp. Reorders must recheck current stock, prices, taxes and shipping before customer confirmation and payment. The current Orders panel lists assistant-created orders only; it does not import all historical website orders.

## Remaining release gates

1. Implement and test new/returning-customer account handling, including account isolation, changed contact details and recovery.
2. Install the connector on staging; configure WooCommerce, WhatsApp, encrypted Flow, AI provider and approved templates using separate staging credentials.
3. Use a fresh live staging database. Apply migrations, configure the final mode/store/phone/environment and create staff before starting the API and worker. Do not convert a demo database by bypassing its identity marker.
4. Test real WordPress/WooCommerce/HPOS, required checkout fields, stock reservations, tax/shipping/coupon/cache plugins and the payment gateway. Exercise duplicate checkout, failed/cancelled/verified payments, webhook recovery and operator handoff.
5. Review public HTTPS/proxy controls, secret handling, monitoring, capacity, retention, backup restoration and rollback. Back up remote WordPress files/database separately before a live plugin release.
6. Record staged acceptance and production approval before enabling live customers.

See [store connection](store-connection.md), [setup](setup.md), [acceptance evidence](uat.md) and [operations](runbook.md). The installable plugin is [wa-commerce-bridge-0.2.0.zip](../artifacts/wa-commerce-bridge-0.2.0.zip).
