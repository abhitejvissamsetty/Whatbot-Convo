<?php
defined('ABSPATH') || exit;

function wa_bridge_secret_hash() {
    if (defined('WA_COMMERCE_BRIDGE_SECRET')) {
        $secret = WA_COMMERCE_BRIDGE_SECRET;
        if (!is_string($secret) || strlen($secret) < 32 || strlen($secret) > 4096 || count(array_unique(str_split($secret))) < 8 || preg_match('/change[-_ ]?me|replace[-_ ]?me|example|demo-secret/i', $secret)) return null;
        return hash('sha256', $secret);
    }
    $hash = get_option('wa_bridge_secret_hash', '');
    return is_string($hash) && preg_match('/^[a-f0-9]{64}$/D', $hash) ? $hash : null;
}

function wa_bridge_input(WP_REST_Request $request, $creating = false) {
    if (strtolower(trim(explode(';', (string) $request->get_header('content-type'))[0])) !== 'application/json') wa_bridge_error('invalid_cart', 'JSON content type is required.', 415);
    $input = $request->get_json_params();
    if (!is_array($input) || array_is_list($input)) wa_bridge_error('invalid_cart', 'A JSON object is required.');
    $allowed = ['lines', 'customer', 'delivery', 'shipping_method', 'coupon'];
    if ($creating) $allowed = array_merge($allowed, ['checkout_session_id', 'expected_fingerprint']);
    if (array_diff(array_keys($input), $allowed)) wa_bridge_error('invalid_cart', 'Unsupported checkout fields.');
    if (!isset($input['lines']) || !is_array($input['lines']) || !array_is_list($input['lines']) || count($input['lines']) < 1 || count($input['lines']) > 10) wa_bridge_error('invalid_cart', 'Select between one and ten product lines.');
    foreach ($input['lines'] as $line) {
        if (!is_array($line) || array_diff(array_keys($line), ['product_id', 'variation_id', 'quantity'])) wa_bridge_error('invalid_cart', 'Invalid product line.');
        foreach (['product_id', 'quantity'] as $key) if (!isset($line[$key]) || !is_int($line[$key]) || $line[$key] < 1) wa_bridge_error('invalid_cart', 'Product and quantity must be positive integers.');
        if ($line['quantity'] > 20 || (isset($line['variation_id']) && (!is_int($line['variation_id']) || $line['variation_id'] < 0))) wa_bridge_error('invalid_cart', 'Invalid quantity or variation.');
    }
    foreach (['customer' => ['name' => 300, 'phone' => 20, 'email' => 254], 'delivery' => ['address_1' => 600, 'address_2' => 600, 'city' => 300, 'state' => 100, 'country' => 2, 'postcode' => 20]] as $group => $fields) {
        if (!isset($input[$group]) || !is_array($input[$group]) || array_is_list($input[$group]) || array_diff(array_keys($input[$group]), array_keys($fields))) wa_bridge_error('invalid_address', 'Invalid customer or delivery fields.');
        foreach ($fields as $key => $max) {
            $value = $input[$group][$key] ?? '';
            if (!is_string($value) || strlen($value) > $max || preg_match('/[\x00-\x1f\x7f]/', $value)) wa_bridge_error('invalid_address', 'Invalid customer or delivery value.');
            if (!in_array($key, ['email', 'address_2'], true) && trim($value) === '') wa_bridge_error('invalid_address', 'Customer and delivery details are required.');
        }
    }
    if (!preg_match('/^\+?\d{8,15}$/D', $input['customer']['phone']) || !preg_match('/^[A-Za-z]{2}$/D', $input['delivery']['country'])) wa_bridge_error('invalid_address', 'Invalid phone number or country.');
    foreach (['shipping_method', 'coupon'] as $key) if (isset($input[$key]) && (!is_string($input[$key]) || strlen($input[$key]) > 100 || preg_match('/[\x00-\x1f\x7f]/', $input[$key]))) wa_bridge_error('invalid_cart', 'Invalid shipping or coupon value.');
    if ($creating) {
        if (!isset($input['checkout_session_id']) || !is_string($input['checkout_session_id']) || !preg_match('/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/D', $input['checkout_session_id'])) wa_bridge_error('invalid_session', 'Invalid checkout session.');
        if (!isset($input['expected_fingerprint']) || !is_string($input['expected_fingerprint']) || !preg_match('/^[a-f0-9]{64}$/D', $input['expected_fingerprint'])) wa_bridge_error('quote_changed', 'A valid reviewed quote is required.', 409);
    }
    return $input;
}

add_filter('rest_post_dispatch', function ($response, $server, $request) {
    if (str_starts_with($request->get_route(), '/wa-commerce/v1/')) {
        $response = rest_ensure_response($response);
        $response->header('Cache-Control', 'private, no-store, max-age=0');
        $response->header('Pragma', 'no-cache');
        $response->header('X-Content-Type-Options', 'nosniff');
    }
    return $response;
}, 10, 3);
