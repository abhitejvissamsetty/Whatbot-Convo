# Convo administration workspace

The original single-screen operator panel has been replaced with a responsive administration workspace. All activity shown comes from the application store; the dashboard does not seed imaginary orders, revenue, or delivery history.

## Pages and controls

| Page | Controls |
|---|---|
| Overview | Actual conversation/order/payment/message totals, seven-day message chart, checkout counts, integration setup, activity, and shortcuts |
| Conversations | Search, unassigned/mine filters, conversation history, claim/release, operator replies, explicit AI resume, automatic refresh |
| Orders | Search/filter/pagination, CSV export, order details, queued WooCommerce reconciliation, existing payment-link delivery |
| Product catalog | Read-only product search, prices, stock state, purchasable variations, and mock checkout shortcuts |
| Checkout sessions | Selection/quote details, progress, expiry, and cancellation before an order exists |
| Integrations | WooCommerce, Meta, Flow, and selectable AI provider/model configuration; masked secrets; model discovery and read-only access checks; copyable webhook addresses |
| Delivery & jobs | Job/message status, filters/pagination, retry confirmed failures, review uncertain deliveries without resending, run maintenance |
| Team & access | Provision staff, administrator/operator roles, enable/disable accounts, reset passwords, session revocation |
| Activity log | Searchable records of configuration changes, team actions, conversation actions, checks, retries, and delivery reviews |
| Settings | Workspace name, AI pause and limits, outbound pause, approved template mapping, session lifetime, transient retention, reconciliation interval, system details |
| Your account | Change your password with current-password verification; sign out |
| Test lab | Administrator-only mock conversation, Flow preview, checkout confirmation, payment simulation, and support handoff |
| Workspace guide | Instructions for support, orders, configuration, and operations |

Use the page jump menu or Ctrl/Cmd+K for navigation. The inbox refreshes without replacing a reply while it is being edited. Table searches, status filters, and pagination operate on actual returned records. Delivery, job, and audit lists show at most 200 recent records; catalog search returns at most 10 products per query.

## Applying changes

Operational settings are versioned in `wa_settings` and refreshed by the API and worker. Concurrent edits return a conflict instead of silently overwriting another administrator's changes. MySQL keeps settings across restarts; the in-memory demo resets them along with its other application data.

**Choose your AI service** from Integrations or Settings → AI assistant. Provider and model dropdowns support OpenAI, Claude, Gemini, DeepSeek, Groq, OpenRouter, Ollama, and custom compatible endpoints. **Load available models** makes an explicit read-only catalog request using entered/stored credentials; it can be used in demo mode without enabling live conversations. Provider/model/credential changes apply after restarting the API and worker. See [the AI provider guide](ai-providers.md).

Pausing the assistant stops automated conversational replies; incoming messages continue to be stored. Transactional updates and operator replies remain available. Pausing outbound delivery holds send jobs, including operator replies, until delivery is enabled. An already in-flight provider request cannot be recalled. Checkout expiry changes affect newly created sessions.

Integration credentials are saved atomically to the configured environment file with mode `0600`. Secret values are never returned to the browser; an empty secret input preserves its current value. Non-secret fields show saved values, with pending-restart indicators. Newlines, null bytes, and single quotes are rejected in panel-entered environment values. Use deployment secret management for values that need unsupported quoting.

**Restart both API and worker after credential changes.** Access checks use active process credentials, not a saved draft. Stored access-check results are invalidated when the active credential fingerprint changes. A successful read check verifies only the tested read operation; it does not establish WhatsApp sending, model generation, shipping/tax compatibility, Flow publication, or payment acceptance.

By default the editable file is `.env` in the application working directory. If your processes read another file, set `CONFIG_ENV_PATH` to that same file. The PM2 sample points both processes at `/etc/wa-commerce/app.env`. Read-only or symlink-managed environment files cannot be edited through the panel; use the deployment system instead. Ensure the service user can read the file, and give write access only if in-panel configuration is intended.

Infrastructure settings (`APP_MODE`, `MYSQL_URL`, HTTPS/public domain, server binding, and production activation) remain deployment-owned. Product edits, native order cancellation, fulfillment, refunds, gateway settings, and final WooCommerce calculations remain store-owned. The panel does not offer a fake "mark paid" button or an AI refund control.

## Upgrade and run

For an existing MySQL installation, run `npm run db:migrate` before starting the updated application; migration 002 adds settings and audit tables. The memory-backed local demo needs no migration.

Stop the old server, then run `npm start` from the project folder. Reopen `http://localhost:3000` and sign in with your existing account. Restart the separate worker as well for MySQL/live integrations.

### Sign-in troubleshooting

If clicking Sign in does nothing, check the visible startup status. The redesigned page imports several JavaScript modules; an old server process may serve the new HTML but return 404 for those modules. Stop that process with Ctrl+C, run `npm start` again, and hard-refresh the page. The form stays disabled until the sign-in scripts initialize, and a separate startup script reports module-load failures. Native form submission uses POST, so credentials cannot accidentally appear in the URL if JavaScript fails.

On Linux, `npm run restart:local` discovers and gracefully stops direct Node servers owned by your user, started from this project directory with `src/server.js` as their entry point, then launches the current application. It refuses live mode, does not terminate workers or unrelated Node apps, and does not force-kill a process. Use your deployment manager for managed services. After restart, `curl -I http://localhost:3000/boot.js` should report HTTP 200 with a JavaScript content type. The static handler serves flat public JavaScript/CSS files without a hardcoded module whitelist; asset requests are independent of API rate limits.

The mock HTTP demo accepts `localhost`, `127.0.0.1`, and IPv6 loopback origins on its configured public port. Live mode requires the exact configured origin; CSRF protection stays enabled. Email matching ignores leading/trailing whitespace and capitalization; passwords remain exact. If authentication succeeds but dashboard APIs are unavailable, the panel reports a workspace startup problem instead of returning silently to the login form.

## Validation

`npm run check` parses all frontend/backend/test JavaScript. `npm test` runs provider contracts, the mock HTTP customer journey, and administration regression tests. The MySQL case remains opt-in through `MYSQL_TEST_URL`.

For real Chromium checks in an unrestricted local or CI environment:

```sh
npm install
npx playwright install chromium
npm run test:browser
```

The browser suite creates a temporary in-memory application and environment file, verifies page navigation and the customer checkout/payment journey, saves settings and test credentials, creates a team member, checks mobile overflow, and captures screenshots in `artifacts/`. It never changes the existing `.env` or uses real providers. The workflow also includes browser checks and screenshot uploads; that CI workflow has not been run from this environment.

This execution environment rejects listening sockets (`EPERM`) and Chromium launch, so browser interaction, screenshot review, and live-provider acceptance could not be completed here. These are recorded as unverified rather than passed.
