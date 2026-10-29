<?php
// Contract harness for plugin auth/validation. Does not emulate WooCommerce checkout.
define('ABSPATH', __DIR__ . '/');
$options = []; $actions = []; $filters = []; $routes = [];
$secure = true; $admin = true; $nonce = true;
function register_activation_hook($file, $callback) {}
function add_action($name, $callback, ...$args) { global $actions; $actions[$name][] = $callback; }
function add_filter($name, $callback, ...$args) { global $filters; $filters[$name][] = $callback; }
function register_rest_route($namespace, $path, $options) { global $routes; $routes[$path] = $options; }
function get_option($name, $default = false) { global $options; return $options[$name] ?? $default; }
function update_option($name, $value, $autoload) { global $options; expect($autoload === false, 'Secret hash must not autoload'); $options[$name] = $value; return true; }
function delete_option($name) { global $options; unset($options[$name]); }
function is_ssl() { global $secure; return $secure; }
function current_user_can($capability) { global $admin; expect($capability === 'manage_options', 'Administrator capability required'); return $admin; }
function check_admin_referer($action) { global $nonce; if (!$nonce) throw new RuntimeException('nonce denied'); }
function wp_die($message, $title = '', $args = []) { throw new RuntimeException('denied: ' . $message); }
function wp_json_encode($data) { return json_encode($data); }
function WC() { return new stdClass(); }
function is_wp_error($value) { return $value instanceof WP_Error; }
function rest_ensure_response($response) { return $response; }
class WP_Error { public function __construct(public $code, public $message, public $data) {} }
class WP_REST_Request {
    public function __construct(public $raw = '', public $headers = [], public $route = '/wa-commerce/v1/quote') {}
    public function get_header($name) { return $this->headers[$name] ?? ''; }
    public function get_body() { return $this->raw; }
    public function get_json_params() { return json_decode($this->raw, true); }
    public function get_route() { return $this->route; }
}
function expect($condition, $message) { if (!$condition) throw new RuntimeException($message); }
function denied($callback, $message) { try { $callback(); } catch (Throwable $e) { return; } throw new RuntimeException($message); }
require __DIR__ . '/../../wordpress/wa-commerce-bridge/wa-commerce-bridge.php';

$secret = wa_bridge_manage_key('generate');
expect(strlen($secret) === 64 && ctype_xdigit($secret), 'Generate 256-bit key');
expect($options['wa_bridge_secret_hash'] === hash('sha256', $secret), 'Store only the digest');
expect(!in_array($secret, $options, true), 'Never store plaintext key');
$headers = ['authorization' => 'Bearer ' . $secret, 'content-type' => 'application/json'];
expect(wa_bridge_permission(new WP_REST_Request('{}', $headers)) === true, 'Valid HTTPS bearer accepted');
expect(wa_bridge_permission(new WP_REST_Request('{}')) instanceof WP_Error, 'Missing auth denied');
expect(wa_bridge_permission(new WP_REST_Request('{}', ['authorization' => 'Bearer invalid']))->data['status'] === 401, 'Invalid auth denied');
$secure = false;
expect(wa_bridge_permission(new WP_REST_Request('{}', $headers))->data['status'] === 403, 'HTTP API denied');
denied(fn() => wa_bridge_manage_key('generate'), 'HTTP key generation must fail');
$secure = true; $admin = false;
denied(fn() => wa_bridge_manage_key('generate'), 'Non-administrator key generation must fail');
$admin = true; $nonce = false;
denied(fn() => wa_bridge_manage_key('generate'), 'Missing nonce must fail');
$nonce = true;
expect(wa_bridge_permission(new WP_REST_Request(str_repeat('x', 65537), $headers))->data['status'] === 413, 'Oversized body denied');

$input = ['lines' => [['product_id' => 102, 'variation_id' => 0, 'quantity' => 1]], 'customer' => ['name' => 'Test Customer', 'phone' => '919876543210', 'email' => 'test@example.test'], 'delivery' => ['address_1' => 'Test Street', 'address_2' => '', 'city' => 'Hyderabad', 'state' => 'TS', 'country' => 'IN', 'postcode' => '500001']];
expect(wa_bridge_input(new WP_REST_Request(json_encode($input), $headers)) === $input, 'Valid payload accepted');
$invalid = [null, [], ['lines' => 'bad'], array_merge($input, ['total' => '0.01']), array_merge($input, ['customer' => ['name' => ['malformed']]]), array_merge($input, ['delivery' => ['country' => 'IND']]), array_merge($input, ['coupon' => ['invalid']]), array_merge($input, ['lines' => [['product_id' => -1, 'quantity' => 1]]]), array_merge($input, ['lines' => [['product_id' => 1, 'quantity' => '1']]]), array_merge($input, ['lines' => [['product_id' => 1, 'quantity' => 21]]])];
foreach ($invalid as $payload) denied(fn() => wa_bridge_input(new WP_REST_Request(json_encode($payload), $headers)), 'Malformed payload accepted');
denied(fn() => wa_bridge_input(new WP_REST_Request(json_encode($input), ['content-type' => 'text/plain'])), 'Non-JSON accepted');
expect(wa_bridge_create(new WP_REST_Request(json_encode(array_merge($input, ['checkout_session_id' => []])), $headers)) instanceof WP_Error, 'Malformed session is a controlled error');
$order = array_merge($input, ['checkout_session_id' => '12345678-1234-1234-1234-123456789abc', 'expected_fingerprint' => str_repeat('a', 64)]);
expect(wa_bridge_input(new WP_REST_Request(json_encode($order), $headers), true) === $order, 'Valid create payload accepted');
expect(wa_bridge_response_error(new RuntimeException('sensitive internal failure'))->message === 'Checkout could not be completed. Contact support.', 'Internal errors must be redacted');

foreach ($actions['rest_api_init'] as $callback) $callback();
expect(count($routes) === 5, 'Expected scoped routes');
foreach ($routes as $route) expect($route['permission_callback'] === 'wa_bridge_permission', 'Every bridge endpoint requires authorization');
$response = new class { public $headers = []; public function header($key, $value) { $this->headers[$key] = $value; } };
$response = $filters['rest_post_dispatch'][0]($response, null, new WP_REST_Request());
expect(str_contains($response->headers['Cache-Control'], 'no-store'), 'Bridge responses cannot be cached');
$rotated = wa_bridge_manage_key('generate');
expect($rotated !== $secret, 'Rotation creates a new random secret');
expect(wa_bridge_permission(new WP_REST_Request('{}', $headers))->data['status'] === 401, 'Old key revoked');
wa_bridge_manage_key('disable');
expect(wa_bridge_permission(new WP_REST_Request('{}', ['authorization' => 'Bearer ' . $rotated]))->data['status'] === 503, 'Disabled connection denies all keys');
echo "Bridge security contracts passed: authentication, HTTPS, admin capability, nonce, rotation/revocation, payload validation, route protection and no-store responses.\n";
