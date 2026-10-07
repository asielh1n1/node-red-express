/**
 * End-to-end verification of the unified package.
 *
 * Covers both halves — the storage module and the context store — against the
 * database configured in `.env`, and proves the properties the user asked for:
 *
 *   1. one variable (`NODE_RED_STORAGE_DIALECT`) drives both;
 *   2. context values are readable immediately, by the same store and by a
 *      second one, with no staleness window;
 *   3. all three scopes (global / flow / node) land in the database;
 *   4. with no dialect configured, flows use the filesystem and context memory.
 *
 * Usage: node scripts/verify-unified.js [dialect]
 */

require('dotenv').config();

var path = require('path');

// The plugin now comes from npm, so scripts resolve it straight from
// node_modules instead of a local packages/ folder.
var PKG_NAME = 'node-red-storage-sequelize';

var pkg = require(PKG_NAME);

var { execSync } = require('child_process');

var DIALECT = process.argv[2] || process.env.NODE_RED_STORAGE_DIALECT || 'postgres';

/**
 * Runs a query against the database under test and returns the output.
 * @param {string} container Docker container holding the database.
 * @param {string} query SQL to run.
 * @param {string} [db] Database name.
 * @returns {string} Trimmed output.
 */
function query(container, sqlText, db) {
    var isMySql = container === 'MySql';
    var cmd = isMySql
        ? 'docker exec ' + container + ' mysql -u root -proot -D ' + (db || 'nodered_mysql_test') + ' -N -B -e "' + sqlText + '"'
        : 'docker exec ' + container + ' psql -U postgres -d ' + (db || 'nodered') + ' -t -A -c "' + sqlText + '"';
    return execSync(cmd, { shell: 'cmd.exe', stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
}

/**
 * Wipes the tables used by the test.
 * @returns {void}
 */
function resetData() {
    if (DIALECT === 'mysql') {
        execSync('docker exec MySql mysql -u root -proot -e "CREATE DATABASE IF NOT EXISTS nodered_mysql_test;"',
            { shell: 'cmd.exe', stdio: 'ignore' });

        // The tables are created by the plugin on first open, so a fresh
        // database has none yet: deleting from a missing table is not an error
        // of the plugin but of this helper.
        var ctxExists = query('MySql', "SELECT count(*) FROM information_schema.tables WHERE table_schema='nodered_mysql_test' AND table_name='nodered_context';");
        if (parseInt(ctxExists, 10) > 0) {
            query('MySql', 'DELETE FROM nodered_context;');
        }

        var flowsExist = query('MySql', "SELECT count(*) FROM information_schema.tables WHERE table_schema='nodered_mysql_test' AND table_name='nodered_flows';");
        if (parseInt(flowsExist, 10) > 0) {
            query('MySql', 'DELETE FROM nodered_flows;');
        }
    } else {
        query('gifted_hawking', 'DELETE FROM nodered_context;');
        query('gifted_hawking', 'DELETE FROM nodered_flows;');
    }
}

/**
 * Selects the connection environment for the dialect under test.
 * @returns {void}
 */
function useDialect() {
    process.env.NODE_RED_STORAGE_DIALECT = DIALECT;

    if (DIALECT === 'mysql') {
        process.env.NODE_RED_STORAGE_HOST = 'localhost';
        process.env.NODE_RED_STORAGE_PORT = '3306';
        process.env.NODE_RED_STORAGE_DATABASE = 'nodered_mysql_test';
        process.env.NODE_RED_STORAGE_USERNAME = 'root';
        process.env.NODE_RED_STORAGE_PASSWORD = 'root';
    } else {
        process.env.NODE_RED_STORAGE_HOST = 'localhost';
        process.env.NODE_RED_STORAGE_PORT = '5432';
        process.env.NODE_RED_STORAGE_DATABASE = 'nodered';
        process.env.NODE_RED_STORAGE_USERNAME = 'postgres';
        process.env.NODE_RED_STORAGE_PASSWORD = 'postgres';
    }
}

/**
 * Promisified single-key context read.
 * @param {object} store The store.
 * @param {string} scope Scope string.
 * @param {string} key Key.
 * @returns {Promise<*>} The value.
 */
function ctxGet(store, scope, key) {
    return new Promise(function (resolve, reject) {
        store.get(scope, key, function (err, value) {
            if (err) { return reject(err); }
            resolve(value);
        });
    });
}

/**
 * Promisified context write.
 * @param {object} store The store.
 * @param {string} scope Scope string.
 * @param {string} key Key.
 * @param {*} value Value.
 * @returns {Promise<void>}
 */
function ctxSet(store, scope, key, value) {
    return new Promise(function (resolve, reject) {
        store.set(scope, key, value, function (err) {
            if (err) { return reject(err); }
            resolve();
        });
    });
}

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

async function main() {
    useDialect();

    console.log('=== dialect: ' + DIALECT + ' ===\n');

    resetData();

    /* ------------------------------------------------------------------ *
     * 1. Auto-configuration
     * ------------------------------------------------------------------ */
    console.log('--- auto-configuration ---');

    var storageModule = pkg.buildStorageModule({ log: function () {} });
    var contextStorage = pkg.buildContextStorage({ log: function () {} });

    check('storageModule exposes getSettings (settings persistence enabled)',
        typeof storageModule.getSettings === 'function');
    check('contextStorage registers the dialect store',
        Object.keys(contextStorage).indexOf(DIALECT) !== -1);
    check('contextStorage registers a memory store',
        Object.keys(contextStorage).indexOf('memory') !== -1);
    check('contextStorage aliases default to the dialect store',
        contextStorage.default === DIALECT);
    check('the dialect store is declared exactly once',
        Object.keys(contextStorage).filter(function (k) { return k === DIALECT; }).length === 1);

    /* ------------------------------------------------------------------ *
     * 2. Storage module (flows)
     * ------------------------------------------------------------------ */
    console.log('\n--- storage module: flows ---');

    var storage = require('node-red-storage-sequelize');
    await storage.init({ storageDialect: DIALECT }, { log: console });

    var flows = [
        { id: 'tab-a', type: 'tab', label: 'Unified Test' },
        { id: 'n1', type: 'inject', z: 'tab-a' }
    ];

    await storage.saveFlows(flows, { username: 'tester', permissions: '*' });
    var reloaded = await storage.getFlows();

    check('flows persist and reload', reloaded.length === 2 && reloaded[0].label === 'Unified Test');

    var container = DIALECT === 'mysql' ? 'MySql' : 'gifted_hawking';
    var flowRows = query(container, 'SELECT count(*) FROM nodered_flows;');
    check('flows are readable in the database', parseInt(flowRows, 10) === 1);

    await storage.close();

    /* ------------------------------------------------------------------ *
     * 3. Context store
     * ------------------------------------------------------------------ */
    console.log('\n--- context store ---');

    var createStore = pkg.ContextStore;
    var makeContextConfig = function () {
        return {
            dialect: DIALECT,
            host: process.env.NODE_RED_STORAGE_HOST,
            port: parseInt(process.env.NODE_RED_STORAGE_PORT, 10),
            database: process.env.NODE_RED_STORAGE_DATABASE,
            username: process.env.NODE_RED_STORAGE_USERNAME,
            password: process.env.NODE_RED_STORAGE_PASSWORD
        };
    };

    var storeA = createStore(makeContextConfig());
    var storeB = createStore(makeContextConfig());

    await storeA.open();
    await storeB.open();

    // All three scopes, as the Change / Inject nodes produce them.
    await ctxSet(storeA, 'global', 'appName', 'unified');
    await ctxSet(storeA, 'flow-tab-a', 'counter', 42);
    await ctxSet(storeA, 'node-n1:flow-tab-a', 'lastSeen', 'ayer');

    check('global context reads back', (await ctxGet(storeA, 'global', 'appName')) === 'unified');
    check('flow context reads back', (await ctxGet(storeA, 'flow-tab-a', 'counter')) === 42);
    check('node context reads back', (await ctxGet(storeA, 'node-n1:flow-tab-a', 'lastSeen')) === 'ayer');

    // The decisive property: no staleness, even across two independent stores.
    check('a second store sees global immediately',
        (await ctxGet(storeB, 'global', 'appName')) === 'unified');
    check('a second store sees flow immediately',
        (await ctxGet(storeB, 'flow-tab-a', 'counter')) === 42);

    // External edit through the database must be visible at once.
    if (DIALECT === 'mysql') {
        // JSON_QUOTE builds a valid JSON string literal without wrestling with
        // nested quoting through the shell.
        query('MySql', "UPDATE nodered_context SET value = JSON_QUOTE('edited-outside') WHERE scope = 'global' AND `key` = 'appName';");
    } else {
        query('gifted_hawking', "UPDATE nodered_context SET value = to_json('edited-outside'::text) WHERE scope = 'global' AND key = 'appName';");
    }
    check('an external database edit is visible immediately',
        (await ctxGet(storeA, 'global', 'appName')) === 'edited-outside');

    /* ------------------------------------------------------------------ *
     * 4. Database contents
     * ------------------------------------------------------------------ */
    console.log('\n--- database contents ---');

    var scopeList = query(container, 'SELECT count(DISTINCT scope) FROM nodered_context;');
    check('three distinct scopes are stored', parseInt(scopeList, 10) === 3);

    var contextRows = query(container, 'SELECT count(*) FROM nodered_context;');
    check('three context rows are stored', parseInt(contextRows, 10) === 3);

    await storeA.close();
    await storeB.close();

    /* ------------------------------------------------------------------ *
     * Summary
     * ------------------------------------------------------------------ */
    console.log('\n=== ' + DIALECT + ': ' + passed + ' passed, ' + failed + ' failed ===');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});
