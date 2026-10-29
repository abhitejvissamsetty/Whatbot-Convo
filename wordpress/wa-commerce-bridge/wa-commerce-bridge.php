<?php
/**
 * Plugin Name: WhatsApp Commerce Bridge
 * Description: Private checkout quotes, idempotent pending orders, and canonical payment URLs.
 * Version: 0.2.0
 * Requires PHP: 8.1
 * Requires Plugins: woocommerce
 */
defined('ABSPATH') || exit;
require_once __DIR__ . '/security.php';
require_once __DIR__ . '/admin.php';

register_activation_hook(__FILE__, function () {
    global $wpdb;
    require_once ABSPATH . 'wp-admin/includes/upgrade.php';
    $table = $wpdb->prefix . 'wa_checkout_sessions';
    dbDelta("CREATE TABLE $table (
        checkout_session_id varchar(64) NOT NULL,
        order_id bigint unsigned DEFAULT NULL,
        created_at datetime NOT NULL,
        PRIMARY KEY (checkout_session_id),
        UNIQUE KEY order_id (order_id)
    ) ENGINE=InnoDB " . $wpdb->get_charset_collate() . ';');
});

function wa_bridge_permission(WP_REST_Request $request) {
    if (!is_ssl()) return new WP_Error('https_required', 'HTTPS is required.', ['status' => 403]);
    $expected = wa_bridge_secret_hash();
    if (!$expected) return new WP_Error('bridge_unconfigured', 'Bridge is not configured.', ['status' => 503]);
    $header = (string) $request->get_header('authorization');
    if (!preg_match('/^Bearer ([^\s]{32,4096})$/D', $header, $matches) || !hash_equals($expected, hash('sha256', $matches[1]))) return new WP_Error('forbidden', 'Invalid credentials.', ['status' => 401]);
    if (strlen($request->get_body()) > 65536) return new WP_Error('payload_too_large', 'Request is too large.', ['status' => 413]);
    if (!function_exists('WC')) return new WP_Error('woocommerce_unavailable', 'WooCommerce is unavailable.', ['status' => 503]);
    return true;
}

function wa_bridge_error($code, $message, $status = 400) { throw new RuntimeException(wp_json_encode(['code' => $code, 'message' => $message, 'status' => $status])); }
function wa_bridge_response_error(Throwable $error) {
    $value = json_decode($error->getMessage(), true);
    if (!is_array($value) || !isset($value['code'])) $value = ['code' => 'checkout_failed', 'message' => 'Checkout could not be completed. Contact support.', 'status' => 500];
    return new WP_Error($value['code'], $value['message'], ['status' => $value['status']]);
}
function wa_bridge_order_data(WC_Order $order) {
    return [
        'id' => $order->get_id(), 'status' => $order->get_status(),
        'paid' => $order->is_paid() && (bool) $order->get_date_paid(),
        'transaction_id' => $order->get_transaction_id(),
        'total' => $order->get_total(), 'currency' => $order->get_currency(),
        'checkout_session_id' => $order->get_meta('_wa_checkout_session_id'),
        'payment_url' => $order->needs_payment() ? $order->get_checkout_payment_url() : null,
    ];
}

function wa_bridge_lookup($session_id) {
    global $wpdb;
    $table = $wpdb->prefix . 'wa_checkout_sessions';
    $order_id = $wpdb->get_var($wpdb->prepare("SELECT order_id FROM $table WHERE checkout_session_id = %s", $session_id));
    if ($order_id) return wc_get_order($order_id);
    // Recover a crash between Woo's order save and updating our mapping table.
    $args = ['limit' => 1, 'return' => 'objects', 'type' => 'shop_order'];
    if (class_exists('\Automattic\WooCommerce\Utilities\OrderUtil') && \Automattic\WooCommerce\Utilities\OrderUtil::custom_orders_table_usage_is_enabled()) {
        $args['meta_query'] = [['key' => '_wa_checkout_session_id', 'value' => $session_id]];
    } else {
        $args['meta_key'] = '_wa_checkout_session_id'; $args['meta_value'] = $session_id;
    }
    $orders = wc_get_orders($args);
    if (!$orders) return null;
    $wpdb->query($wpdb->prepare("INSERT INTO $table (checkout_session_id, order_id, created_at) VALUES (%s, %d, UTC_TIMESTAMP()) ON DUPLICATE KEY UPDATE order_id = VALUES(order_id)", $session_id, $orders[0]->get_id()));
    return $orders[0];
}

function wa_bridge_cart(array $input) {
    if (empty($input['lines']) || !is_array($input['lines']) || count($input['lines']) > 10) wa_bridge_error('invalid_cart', 'Select between one and ten product lines.');
    $customer = $input['customer'] ?? [];
    $delivery = $input['delivery'] ?? [];
    foreach (['name', 'phone'] as $field) if (empty($customer[$field])) wa_bridge_error('invalid_address', 'Customer details are incomplete.');
    foreach (['address_1', 'city', 'state', 'country', 'postcode'] as $field) if (empty($delivery[$field])) wa_bridge_error('invalid_address', 'Delivery details are incomplete.');
    $country = strtoupper(sanitize_text_field($delivery['country']));
    if (!isset(WC()->countries->get_shipping_countries()[$country])) wa_bridge_error('shipping_unavailable', 'Delivery is unavailable in this country.');
    if (!WC_Validation::is_postcode($delivery['postcode'], $country)) wa_bridge_error('invalid_address', 'Invalid postcode.');
    $states = WC()->countries->get_states($country);
    if (is_array($states) && $states && !isset($states[$delivery['state']])) wa_bridge_error('invalid_address', 'Use a valid state code.');
    if (!empty($customer['email']) && !is_email($customer['email'])) wa_bridge_error('invalid_address', 'Email is invalid.');

    if (!WC()->session) WC()->initialize_session();
    WC()->customer = new WC_Customer(0);
    WC()->cart = new WC_Cart();
    WC()->cart->empty_cart(false);
    WC()->session->set('order_awaiting_payment', null);
    wc_clear_notices();
    $parts = preg_split('/\s+/', trim(sanitize_text_field($customer['name'])), 2);
    $address = [
        'first_name' => $parts[0], 'last_name' => $parts[1] ?? '',
        'address_1' => sanitize_text_field($delivery['address_1']), 'address_2' => sanitize_text_field($delivery['address_2'] ?? ''),
        'city' => sanitize_text_field($delivery['city']), 'state' => sanitize_text_field($delivery['state']),
        'country' => $country, 'postcode' => wc_format_postcode($delivery['postcode'], $country),
    ];
    $billing = array_merge($address, ['phone' => sanitize_text_field($customer['phone']), 'email' => sanitize_email($customer['email'] ?? '')]);
    foreach ($billing as $key => $value) { $setter = 'set_billing_' . $key; WC()->customer->$setter($value); }
    foreach ($address as $key => $value) { $setter = 'set_shipping_' . $key; WC()->customer->$setter($value); }
    WC()->customer->set_calculated_shipping(true);
    $checkout_data = ['ship_to_different_address' => 1, 'payment_method' => '', 'customer_note' => '', 'createaccount' => 0];
    foreach ($billing as $key => $value) $checkout_data['billing_' . $key] = $value;
    foreach ($address as $key => $value) $checkout_data['shipping_' . $key] = $value;
    foreach (WC()->checkout()->get_checkout_fields() as $group => $fields) {
        if (!in_array($group, ['billing', 'shipping'], true)) continue;
        foreach ($fields as $key => $field) if (!empty($field['required']) && empty($checkout_data[$key])) wa_bridge_error('invalid_address', 'A required checkout field is missing: ' . sanitize_text_field($field['label'] ?? $key));
    }
    $seen = [];
    foreach ($input['lines'] as $line) {
        $product_id = absint($line['product_id'] ?? 0); $variation_id = absint($line['variation_id'] ?? 0); $quantity = $line['quantity'] ?? 0;
        if (!is_int($quantity) || $quantity < 1 || $quantity > 20) wa_bridge_error('invalid_cart', 'Invalid quantity.');
        $key = "$product_id:$variation_id";
        if (isset($seen[$key])) wa_bridge_error('invalid_cart', 'Duplicate product lines.');
        $seen[$key] = true;
        $parent = wc_get_product($product_id);
        if (!$parent || $parent->get_status() !== 'publish' || !$parent->is_type(['simple', 'variable'])) wa_bridge_error('invalid_cart', 'Product is unavailable.');
        $product = $variation_id ? wc_get_product($variation_id) : $parent;
        if (!$product || ($variation_id && ($product->get_parent_id() !== $product_id || $product->get_status() !== 'publish')) || ($parent->is_type('variable') && !$variation_id)) wa_bridge_error('invalid_cart', 'Select a valid variation.');
        if (!$product->is_purchasable() || !$product->is_in_stock() || !$product->has_enough_stock($quantity)) wa_bridge_error('out_of_stock', 'Stock is unavailable.', 409);
        $attributes = $variation_id ? $product->get_variation_attributes() : [];
        foreach ($attributes as $attribute => $option) if ($option === '') wa_bridge_error('invalid_cart', 'Open-ended variation attributes require operator assistance.');
        if (!WC()->cart->add_to_cart($product_id, $quantity, $variation_id, $attributes)) wa_bridge_error('invalid_cart', 'Cannot add this product to checkout.');
    }
    if (!empty($input['coupon']) && !WC()->cart->apply_coupon(wc_format_coupon_code($input['coupon']))) wa_bridge_error('invalid_coupon', 'Coupon is invalid.');
    WC()->session->set('chosen_shipping_methods', []);
    WC()->cart->calculate_shipping();
    $packages = WC()->shipping()->get_packages();
    if (WC()->cart->needs_shipping() && count($packages) !== 1) wa_bridge_error('shipping_unavailable', 'This shipment requires operator assistance.');
    $methods = [];
    if (WC()->cart->needs_shipping()) {
        $rates = $packages[0]['rates'] ?? [];
        foreach ($rates as $rate) $methods[] = ['id' => $rate->get_id(), 'title' => $rate->get_label(), 'total' => wc_format_decimal($rate->get_cost(), wc_get_price_decimals())];
        if (!$methods) wa_bridge_error('shipping_unavailable', 'No delivery service is available.');
        $selected = !empty($input['shipping_method']) ? $input['shipping_method'] : $methods[0]['id'];
        if (!isset($rates[$selected])) wa_bridge_error('shipping_unavailable', 'Selected delivery service is unavailable.');
        WC()->session->set('chosen_shipping_methods', [$selected]);
        $checkout_data['shipping_method'] = [$selected];
    } else { $selected = 'none'; $methods[] = ['id' => 'none', 'title' => 'No shipping required', 'total' => '0.00']; }
    WC()->cart->calculate_totals();
    $errors = new WP_Error();
    WC()->cart->check_cart_items();
    WC()->cart->check_customer_coupons($checkout_data);
    do_action('woocommerce_after_checkout_validation', $checkout_data, $errors);
    if ($errors->has_errors() || wc_notice_count('error')) wa_bridge_error('invalid_cart', 'The store requires a correction to your checkout details.');
    $lines = [];
    foreach (WC()->cart->get_cart() as $item) $lines[] = [
        'product_id' => $item['product_id'], 'variation_id' => $item['variation_id'], 'quantity' => $item['quantity'],
        'name' => wp_strip_all_tags($item['data']->get_name()), 'price' => wc_format_decimal($item['data']->get_price(), wc_get_price_decimals()),
        'total' => wc_format_decimal($item['line_subtotal'], wc_get_price_decimals()),
    ];
    $quote = [
        'lines' => $lines, 'shipping_methods' => $methods, 'shipping_method' => $selected,
        'subtotal' => wc_format_decimal(WC()->cart->get_subtotal(), wc_get_price_decimals()),
        'discount' => wc_format_decimal(WC()->cart->get_discount_total(), wc_get_price_decimals()),
        'shipping' => wc_format_decimal(WC()->cart->get_shipping_total(), wc_get_price_decimals()),
        'tax' => wc_format_decimal(WC()->cart->get_total_tax(), wc_get_price_decimals()),
        'fees' => array_values(array_map(function ($fee) { return ['name' => wp_strip_all_tags($fee->name), 'total' => wc_format_decimal($fee->total, wc_get_price_decimals())]; }, WC()->cart->get_fees())),
        'total' => wc_format_decimal(WC()->cart->get_total('edit'), wc_get_price_decimals()), 'currency' => get_woocommerce_currency(),
    ];
    $quote['fingerprint'] = hash('sha256', wp_json_encode([$quote, $billing, $address, WC()->cart->get_applied_coupons()]));
    return [$quote, $checkout_data];
}

function wa_bridge_create(WP_REST_Request $request) {
    global $wpdb;
    try { $input = wa_bridge_input($request, true); }
    catch (Throwable $error) { return wa_bridge_response_error($error); }
    $session = $input['checkout_session_id'];
    $lock = 'wa_' . hash('sha256', $session);
    $lock = substr($lock, 0, 64);
    if ((int) $wpdb->get_var($wpdb->prepare('SELECT GET_LOCK(%s, 10)', $lock)) !== 1) return new WP_Error('checkout_busy', 'Checkout is busy. Retry shortly.', ['status' => 503]);
    $in_transaction = false;
    $metadata = function ($order) use ($session) { $order->update_meta_data('_wa_checkout_session_id', $session); $order->set_created_via('whatsapp'); };
    try {
        $existing = wa_bridge_lookup($session);
        if ($existing) return wa_bridge_order_data($existing);
        [$quote, $checkout_data] = wa_bridge_cart($input);
        if (!hash_equals($quote['fingerprint'], (string) ($input['expected_fingerprint'] ?? ''))) wa_bridge_error('quote_changed', 'Quote changed. Review and confirm again.', 409);
        // Woo order rows, metadata, stock hold, and bridge mapping must commit together.
        // All participating tables must be InnoDB; store plugins must not commit here.
        if ($wpdb->query('START TRANSACTION') === false) wa_bridge_error('checkout_failed', 'Unable to start order transaction.', 500);
        $in_transaction = true;
        $table = $wpdb->prefix . 'wa_checkout_sessions';
        if ($wpdb->query($wpdb->prepare("INSERT INTO $table (checkout_session_id, created_at) VALUES (%s, UTC_TIMESTAMP())", $session)) === false) wa_bridge_error('checkout_failed', 'Unable to reserve checkout session.', 500);
        add_action('woocommerce_checkout_create_order', $metadata, 10, 1);
        $order_id = WC()->checkout()->create_order($checkout_data);
        if (is_wp_error($order_id) || !$order_id) wa_bridge_error('checkout_failed', 'Order could not be created.', 500);
        $order = wc_get_order($order_id);
        if (!$order || $order->get_meta('_wa_checkout_session_id') !== $session) wa_bridge_error('checkout_failed', 'Order session identity could not be established.', 500);
        if (wc_format_decimal($order->get_total(), wc_get_price_decimals()) !== $quote['total']) wa_bridge_error('checkout_failed', 'Order total differs from quote. Contact support.', 500);
        if ($wpdb->query($wpdb->prepare("UPDATE $table SET order_id = %d WHERE checkout_session_id = %s", $order_id, $session)) === false) wa_bridge_error('checkout_failed', 'Order mapping needs recovery.', 500);
        // WooCommerce owns stock reservation and all payment transitions.
        if (!function_exists('wc_reserve_stock_for_order')) wa_bridge_error('checkout_failed', 'WooCommerce stock reservation support is required.', 500);
        wc_reserve_stock_for_order($order);
        $result = wa_bridge_order_data($order);
        if ($wpdb->query('COMMIT') === false) wa_bridge_error('checkout_failed', 'Order commit needs verification.', 500);
        $in_transaction = false;
        return $result;
    } catch (Throwable $error) {
        if ($in_transaction) $wpdb->query('ROLLBACK');
        return wa_bridge_response_error($error);
    }
    finally { remove_action('woocommerce_checkout_create_order', $metadata, 10); $wpdb->get_var($wpdb->prepare('SELECT RELEASE_LOCK(%s)', $lock)); }
}

add_action('rest_api_init', function () {
    $base = ['permission_callback' => 'wa_bridge_permission'];
    register_rest_route('wa-commerce/v1', '/catalog-context', array_merge($base, ['methods' => 'GET', 'callback' => function () { return ['currency' => get_woocommerce_currency(), 'bridge_version' => '0.2.0']; }]));
    register_rest_route('wa-commerce/v1', '/quote', array_merge($base, ['methods' => 'POST', 'callback' => function ($request) {
        try { return wa_bridge_cart(wa_bridge_input($request))[0]; } catch (Throwable $error) { return wa_bridge_response_error($error); }
    }]));
    register_rest_route('wa-commerce/v1', '/orders', array_merge($base, ['methods' => 'POST', 'callback' => 'wa_bridge_create']));
    register_rest_route('wa-commerce/v1', '/orders/(?P<session>[a-f0-9-]{36})', array_merge($base, ['methods' => 'GET', 'callback' => function ($request) {
        try { $order = wa_bridge_lookup($request['session']); return ['order' => $order ? wa_bridge_order_data($order) : null]; } catch (Throwable $error) { return wa_bridge_response_error($error); }
    }]));
    register_rest_route('wa-commerce/v1', '/order-status/(?P<id>\d+)', array_merge($base, ['methods' => 'GET', 'callback' => function ($request) {
        $order = wc_get_order(absint($request['id']));
        if (!$order || !$order->get_meta('_wa_checkout_session_id')) return new WP_Error('not_found', 'Order not found.', ['status' => 404]);
        return wa_bridge_order_data($order);
    }]));
});
