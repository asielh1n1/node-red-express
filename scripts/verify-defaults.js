/**
 * Verifies the default (no-dialect) behaviour.
 *
 * With `NODE_RED_STORAGE_DIALECT` unset, the package must fall back to Node-RED's
 * own backends: filesystem storage and an in-memory context store. This is what
 * makes an unconfigured checkout behave exactly like a stock Node-RED install.
 *
 * Usage: node scripts/verify-defaults.js
 */

var path = require('path');

// Clear the dialect before the package reads it.
delete process.env.NODE_RED_STORAGE_DIALECT;

var pkg = require('node-red-storage-sequelize');

var passed = 0;
var failed = 0;

/**
 * Records a check.
 * @param {string} label Description.
 * @param {boolean} ok Whether it passed.
 * @returns {void}
 */
function check(label, ok) {
    if (ok) { passed++; } else { failed++; }
    console.log('  ' + (ok ? 'OK  ' : 'FAIL') + '  ' + label);
}

console.log('=== no dialect configured (defaults) ===\n');

var logs = [];
var log = function (message) { logs.push(message); };

console.log('--- buildStorageModule() ---');
var storageModule = pkg.buildStorageModule({ log: log });

check('returns an object usable as settings.storageModule',
    storageModule && typeof storageModule === 'object');
check('exposes the required storage methods',
    ['init', 'getFlows', 'saveFlows', 'getCredentials', 'saveCredentials'].every(function (m) {
        return typeof storageModule[m] === 'function';
    }));
check('exposes getSettings so settings persistence is enabled',
    typeof storageModule.getSettings === 'function');
check('falls back to the filesystem backend',
    storageModule.activeBackend() === storageModule.filesystemBackend());
check('reports the fallback in its banner',
    logs.join('\n').indexOf('filesystem') !== -1);
console.log('    banner: ' + logs[logs.length - 1]);

console.log('\n--- buildContextStorage() ---');
logs.length = 0;
var contextStorage = pkg.buildContextStorage({ log: log });

var names = Object.keys(contextStorage);
check('registers a single memory store', names.length === 1 && names[0] === 'default');
check('the memory store uses the built-in module',
    contextStorage.default.module === 'memory');
check('reports the fallback in its banner',
    logs.join('\n').indexOf('memory') !== -1);
console.log('    banner: ' + logs[logs.length - 1]);

console.log('\n--- configuredDialect() ---');
check('reports no dialect when unset', pkg.configuredDialect() === undefined);

console.log('\n--- availableDialects() ---');
var available = pkg.availableDialects();
console.log('    installed drivers: ' + (available.length ? available.join(', ') : '(none)'));
check('returns an array', Array.isArray(available));

console.log('\n=== defaults: ' + passed + ' passed, ' + failed + ' failed ===');
process.exit(failed === 0 ? 0 : 1);
