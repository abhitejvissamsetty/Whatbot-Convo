<?php
defined('ABSPATH') || exit;

function wa_bridge_manage_key($action) {
    if (!current_user_can('manage_options')) wp_die('Administrator access required.', '', ['response' => 403]);
    if (!is_ssl()) wp_die('HTTPS is required to manage connection keys.', '', ['response' => 403]);
    check_admin_referer('wa_bridge_manage_key');
    if (defined('WA_COMMERCE_BRIDGE_SECRET')) wp_die('This key is managed in wp-config.php.', '', ['response' => 403]);
    if ($action === 'generate') {
        $secret = bin2hex(random_bytes(32));
        // Store only its digest; display the actual key once to this administrator.
        if (!update_option('wa_bridge_secret_hash', hash('sha256', $secret), false)) wp_die('Connection key could not be saved.', '', ['response' => 503]);
        return $secret;
    }
    if ($action === 'disable') { delete_option('wa_bridge_secret_hash'); return null; }
    wp_die('Invalid action.', '', ['response' => 400]);
}

function wa_bridge_admin_page() {
    if (!current_user_can('manage_options')) wp_die('Administrator access required.', '', ['response' => 403]);
    if (!headers_sent()) nocache_headers();
    $secret = null;
    if (($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
        $action = isset($_POST['bridge_action']) && is_string($_POST['bridge_action']) ? sanitize_key(wp_unslash($_POST['bridge_action'])) : '';
        $secret = wa_bridge_manage_key($action);
    }
    echo '<div class="wrap"><h1>WhatsApp Commerce Bridge</h1>';
    echo '<p>This connection allows the assistant to calculate checkout totals, create pending orders, and read payment status for orders created through this bridge. It cannot refund orders, edit products, or manage WordPress users.</p>';
    if (!is_ssl()) echo '<div class="notice notice-error"><p>Open this admin page over HTTPS before generating a key. Bridge API requests require HTTPS.</p></div>';
    if ($secret) {
        echo '<div class="notice notice-success"><p>Copy this key now into your assistant’s WooCommerce integration, in the <strong>Bridge bearer secret</strong> field. It will not be shown again. Generating another key immediately revokes this one.</p></div>';
        echo '<label for="wa-bridge-key">Connection key</label><input id="wa-bridge-key" class="large-text code" type="text" readonly autocomplete="off" value="' . esc_attr($secret) . '">';
    }
    echo '<p>Connection: <strong>' . (wa_bridge_secret_hash() ? 'Key configured' : 'Disabled — no key configured') . '</strong></p>';
    echo '<p>Use a separate WooCommerce REST API key with <strong>Read</strong> permission for catalog access. Enter credentials only in the assistant’s protected settings; do not put them in URLs or send them in chat.</p>';
    echo '<p>Test on a staging copy with sandbox payments before live checkout. Keep WordPress, WooCommerce and other plugins updated.</p>';
    if (defined('WA_COMMERCE_BRIDGE_SECRET')) echo '<p>The connection key is managed in wp-config.php. Rotate or remove that constant there.</p>';
    elseif (is_ssl()) {
        echo '<form method="post">'; wp_nonce_field('wa_bridge_manage_key');
        echo '<p><button class="button button-primary" name="bridge_action" value="generate">Generate new connection key</button> <button class="button" name="bridge_action" value="disable">Disable connection</button></p></form>';
    }
    echo '</div>';
}

add_action('admin_menu', function () {
    add_submenu_page('woocommerce', 'WhatsApp Commerce Bridge', 'WhatsApp Bridge', 'manage_options', 'wa-commerce-bridge', 'wa_bridge_admin_page');
});
