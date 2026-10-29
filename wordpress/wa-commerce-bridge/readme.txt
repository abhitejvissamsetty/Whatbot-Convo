=== WhatsApp Commerce Bridge ===
Requires PHP: 8.1
Requires Plugins: woocommerce
Stable tag: 0.2.0

Private WooCommerce checkout connector for Convo.

== Installation ==
Upload this ZIP through WordPress Plugins > Add New Plugin > Upload Plugin.
Activate with WooCommerce installed. Activation creates a checkout-session mapping table.
Open WooCommerce > WhatsApp Bridge over HTTPS as an administrator.
Generate a connection key and copy it into Convo's Bridge bearer secret setting.
WordPress stores only the generated key's SHA-256 digest. Copy it immediately;
it cannot be displayed again. Generating a new key revokes the previous key.
Disable connection revokes API access. A wp-config.php WA_COMMERCE_BRIDGE_SECRET
constant, if present, takes precedence and must be managed there instead.

Use separate WooCommerce REST API credentials with Read permission for catalog
access. Never put credentials in URLs, browser code, chat, or public repositories.

== Scope and requirements ==
The bridge can calculate quotes, create pending orders and read status/payment
URLs for bridge-created orders. It has no refund, product-editing or user-management
endpoint. Every bridge route requires HTTPS and bearer authentication.
Requests are validated and bounded; responses must not be cached.

Use InnoDB for all participating order/session tables. Test on staging with the
site's actual checkout, stock, shipping, tax, coupon, payment and cache plugins.
Custom required fields, advanced product types and multiple shipping packages
may require additional implementation. The local security contract harness does
not certify real WordPress/WooCommerce compatibility or production security.
Keep WordPress, WooCommerce and plugins updated and restrict admin access.

== Changelog ==
0.2.0: Administrator-only key generation/revocation with hash-only storage,
HTTPS checks, bounded request validation and explicit no-cache responses.
