# Local persistent storage

This workspace uses MAMP MySQL 8 on `127.0.0.1:8889`, database `convo`.
The local `.env` selects `STORE_DRIVER=mysql` and `REQUIRE_PERSISTENCE=true`.
Its `convo_app` account has only SELECT, INSERT, UPDATE and DELETE privileges on this database.
Credentials stay in the ignored, private `.env` file. Existing demo login credentials remain unchanged.

Start MySQL in MAMP, then run `npm start` and open `http://localhost:3000`.
Keep MAMP MySQL running while using the app. Stopping MySQL makes the app unavailable;
the app does not switch to temporary storage. MySQL data remains on disk under
MAMP's database directory. Check Settings → System → Storage for “MySQL · persistent”.

Application records, sessions, operational settings, audit events, queues, error counts,
request limits, simulated orders and simulated outgoing messages are persisted. The
sample catalog is a fixture in source code. Secrets remain in the local environment file.
Runtime variables and read-through configuration copies are not authoritative data stores.
Sessions still expire after eight hours; the existing retention policy still removes
eligible old message, event and checkout records. Persistence does not disable deliberate
expiry/deletion or replace database backups.

`APP_MODE=mock` remains enabled: WhatsApp, WooCommerce, payments and AI responses
are simulated. Database setup does not activate external integrations.

The persistent demo commits its simulated order and local checkout in one database
transaction. If that transaction fails, both roll back. Tests using the in-memory
provider fixtures separately cover independent external-provider commits and timeout recovery.

All three schema migrations must run using a migration account before the restricted
application account starts. Do not grant the runtime account schema permissions.

## Verification

The ignored `.env.test-mysql` points to the separate `convo_test` database. Run:

```sh
node --env-file=.env.test-mysql scripts/test.js
npm run check
```

The persistence test runs three separate Node processes to verify checkout, payment,
message history, settings, authentication, rate limits, unique IDs, concurrent
confirmations, rollback and privacy deletion. Never point this test at the app's database.
