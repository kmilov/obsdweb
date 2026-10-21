// Usage: node hash-password.mjs [--] <password>
// Prints an APP_PASSWORD_HASH line for your .env file.
import crypto from 'node:crypto';

const password = process.argv.slice(2).filter((a) => a !== '--').join(' ');
if (!password) {
  console.error('Usage: node hash-password.mjs <password>');
  process.exit(1);
}

const saltHex = crypto.randomBytes(16).toString('hex');
const hash = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), 64).toString('hex');
console.log('Add this to your .env file:');
console.log(`APP_PASSWORD_HASH=${saltHex}:${hash}`);
