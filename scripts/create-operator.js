import { bootstrap } from '../src/bootstrap.js';
const [email, role = 'operator'] = process.argv.slice(2);
// Use stdin so passwords do not appear in shell history or process arguments.
let password = ''; for await (const chunk of process.stdin) password += chunk;
if (!email || !password.trim()) throw new Error('Usage: secret-provider | npm run operator:create -- email [admin|operator]');
const context = await bootstrap();
if (context.config.storeDriver !== 'mysql') throw new Error('Use MOCK_OPERATOR_* environment variables for in-memory demo accounts');
try { const result = await context.operators.create(email, password.trim(), role); process.stdout.write(`Created ${result.role}: ${result.email}\n`); }
finally { await context.store.close(); }
