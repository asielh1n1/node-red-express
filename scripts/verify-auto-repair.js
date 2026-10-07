/**
 * Proves the plugin repairs a legacy schema on startup, without operator action.
 *
 * Sets up a database containing the OLD `nodered_library_entries` shape
 * (`path VARCHAR(768)`, no `keyHash`), then runs the real `init()` path and
 * checks that the schema ends up correct and the data survives.
 *
 * Usage: node scripts/verify-auto-repair.js
 */

var path = require('path');
var { execSync } = require('child_process');

var DB = 'nodered_repair_test';

/**
 * Runs a mysql client command.
 * @param {string} sql SQL to run.
 * @param {boolean} [ignoreErrors] Swallow failures.
 * @returns {string} Trimmed output.
 */
function mysql(sql, ignoreErrors) {
    try {
        return execSync(
            'docker exec MySql mysql -u root -proot -N -B -e "' + sql.replace(/"/g, '\\"') + '"',
            { shell: 'cmd.exe', stdio: ['ignore', 'pipe', 'pipe'] }
        ).toString().trim();
    } catch (err) {
        if (ignoreErrors) { return ''; }
        throw err;
    }
}

/**
 * Seeds a database with the legacy table shape plus a row of data.
 * @returns {void}
 */
function seedLegacySchema() {
    mysql('DROP DATABASE IF EXISTS ' + DB + ';');
    mysql('CREATE DATABASE ' + DB + ';');

    mysql(
        'CREATE TABLE ' + DB + '.nodered_library_entries (' +
        'id INT AUTO_INCREMENT PRIMARY KEY, ' +
        'type VARCHAR(64) NOT NULL, ' +
        'path VARCHAR(768) NOT NULL, ' +
        'meta JSON NULL, ' +
        'body LONGTEXT NULL, ' +
        'createdAt DATETIME NOT NULL, ' +
        'updatedAt DATETIME NOT NULL);'
    );

    // Real data that must survive the repair.
    mysql(
        "INSERT INTO " + DB + ".nodered_library_entries " +
        "(type, path, body, createdAt, updatedAt) VALUES " +
        "('functions', 'legacy/template.js', 'return 1;', NOW(), NOW());"
    );

    // A flows row too, to make sure the rest of the schema is created.
    mysql(
        'CREATE TABLE ' + DB + '.nodered_flows (' +
        'id INT PRIMARY KEY, flows JSON NOT NULL, rev VARCHAR(64), ' +
        'deployedBy VARCHAR(255), createdAt DATETIME NOT NULL, updatedAt DATETIME NOT NULL);'
    );
    mysql(
        "INSERT INTO " + DB + ".nodered_flows (id, flows, createdAt, updatedAt) " +
        "VALUES (1, '[]', NOW(), NOW());"
    );
}

async function main() {
    process.env.NODE_RED_STORAGE_DIALECT = 'mysql';
    process.env.NODE_RED_STORAGE_HOST = 'localhost';
    process.env.NODE_RED_STORAGE_PORT = '3306';
    process.env.NODE_RED_STORAGE_DATABASE = DB;
    process.env.NODE_RED_STORAGE_USERNAME = 'root';
    process.env.NODE_RED_STORAGE_PASSWORD = 'root';

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

    console.log('=== setting up a legacy database ===');
    seedLegacySchema();

    console.log('   path column width : ' +
        mysql("SELECT character_maximum_length FROM information_schema.columns WHERE table_schema='" +
            DB + "' AND table_name='nodered_library_entries' AND column_name='path';"));
    console.log('   keyHash present   : ' +
        mysql("SELECT count(*) FROM information_schema.columns WHERE table_schema='" + DB +
            "' AND table_name='nodered_library_entries' AND column_name='keyHash';"));
    console.log('   legacy rows       : ' +
        mysql('SELECT count(*) FROM ' + DB + '.nodered_library_entries;'));

    console.log('');
    console.log('=== running the plugin init() over that database ===');

    var storage = require('node-red-storage-sequelize');

    var started = Date.now();
    try {
        await storage.init({}, { log: console });
        console.log('   init() completed in ' + (Date.now() - started) + 'ms');
        check('init() did not throw on a legacy schema', true);
    } catch (err) {
        check('init() did not throw on a legacy schema', false);
        console.log('   error: ' + err.message);
        process.exit(1);
    }

    console.log('');
    console.log('=== verifying the repaired schema ===');

    var pathWidth = mysql(
        "SELECT character_maximum_length FROM information_schema.columns WHERE table_schema='" +
        DB + "' AND table_name='nodered_library_entries' AND column_name='path';"
    );
    console.log('   path column width : ' + pathWidth);
    check('path column was resized', parseInt(pathWidth, 10) === 512);

    var hasKeyHash = mysql(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='" + DB +
        "' AND table_name='nodered_library_entries' AND column_name='keyHash';"
    );
    check('keyHash column was added', hasKeyHash === '1');

    var indexes = mysql(
        "SELECT group_concat(index_name) FROM information_schema.statistics " +
        "WHERE table_schema='" + DB + "' AND table_name='nodered_library_entries';"
    );
    console.log('   indexes           : ' + indexes);
    check('the fixed-width unique index exists',
        indexes.indexOf('library_entries_key_hash') !== -1);

    var rowCount = mysql('SELECT count(*) FROM ' + DB + '.nodered_library_entries;');
    check('legacy data was preserved', rowCount === '1');

    var body = mysql('SELECT body FROM ' + DB + '.nodered_library_entries LIMIT 1;');
    check('legacy data is intact', body === 'return 1;');

    console.log('');
    console.log('=== verifying the plugin works after the repair ===');

    // Reads and writes through the real API.
    var entry = await storage.getLibraryEntry('functions', 'legacy/template.js');
    check('the legacy entry is readable through the API', entry === 'return 1;');

    await storage.saveLibraryEntry('functions', 'new/template.js', { name: 'new' }, 'return 2;');
    var fresh = await storage.getLibraryEntry('functions', 'new/template.js');
    check('a new entry can be written', fresh === 'return 2;');

    // The upsert path uses the hash, so re-saving must update in place.
    await storage.saveLibraryEntry('functions', 'new/template.js', { name: 'new' }, 'return 3;');
    var updated = await storage.getLibraryEntry('functions', 'new/template.js');
    check('re-saving updates instead of duplicating', updated === 'return 3;');

    var total = mysql('SELECT count(*) FROM ' + DB + '.nodered_library_entries;');
    check('no duplicate rows were created', total === '2');

    var listing = await storage.getLibraryEntry('functions', '');
    check('directory listing works after the repair',
        Array.isArray(listing) && listing.length === 2);

    await storage.close();

    console.log('');
    console.log('=== auto-repair: ' + passed + ' passed, ' + failed + ' failed ===');
    process.exit(failed === 0 ? 0 : 1);
}

main().catch(function (err) {
    console.error('\nFAILED:', err.message);
    process.exit(1);
});
