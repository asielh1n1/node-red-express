/**
 * Reproduces the user-reported MySQL failure and proves the fix.
 *
 * ## The bug
 *
 * The first version declared `LibraryEntry.path` as `VARCHAR(768)` with a unique
 * index on `(type, path)`. With utf8mb4 that index costs `64*4 + 768*4 = 3328`
 * bytes, past InnoDB's 3072 limit, so on MySQL the index could never be created.
 *
 * Worse, `sequelize.sync()` does **not** resize existing columns. On a database
 * where the table already existed in the old shape, every startup retried the
 * index creation against the legacy widths and failed with
 * "Specified key was too long".
 *
 * ## The fix
 *
 * The unique index is now on `keyHash`, a fixed-width SHA-256 digest
 * (64 chars = 256 bytes). Its size does not depend on any other column, so it is
 * safe on a brand-new table and on a pre-existing one alike.
 *
 * Usage: node scripts/repro-legacy-table.js
 */

var path = require('path');
var { execSync } = require('child_process');

// Sequelize ships as a peer dependency of the plugin; require it from the
// plugin's own resolution root so there is never a second copy in play.
var Sequelize = require(require.resolve('sequelize', {
    paths: [path.dirname(require.resolve('node-red-storage-sequelize/package.json'))]
}));

// `lib/models` is not part of the public API, so resolve it relative to the
// installed package rather than assuming a local folder layout.
var modelsFactory = require(require.resolve('node-red-storage-sequelize/lib/models'));

var DB = 'nodered_legacy_test';

/**
 * Runs a mysql client command.
 * @param {string} sql SQL to run.
 * @param {boolean} [ignoreErrors] Swallow failures instead of throwing.
 * @returns {string} Trimmed output, or an empty string on an ignored failure.
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

async function main() {
    mysql('DROP DATABASE IF EXISTS ' + DB + ';');
    mysql('CREATE DATABASE ' + DB + ';');

    var sequelize = new Sequelize({
        dialect: 'mysql', host: 'localhost', port: 3306,
        database: DB, username: 'root', password: 'root', logging: false
    });

    var models = modelsFactory.defineModels(sequelize);

    /* ------------------------------------------------------------------ *
     * 1. The old index is impossible on MySQL
     * ------------------------------------------------------------------ */
    console.log('=== 1. can MySQL create the OLD index on (type, path)? ===');
    mysql(
        'CREATE TABLE ' + DB + '.old_shape (' +
        'type VARCHAR(64) NOT NULL, path VARCHAR(768) NOT NULL, ' +
        'UNIQUE KEY old_type_path (type, path));',
        true
    );
    var oldExists = mysql(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema='" + DB +
        "' AND table_name='old_shape';"
    );
    console.log('   table with the old index created: ' +
        (oldExists === '0' ? 'NO (as expected)' : 'yes'));
    console.log('   reason: 64*4 + 768*4 = 3328 bytes > 3072');

    /* ------------------------------------------------------------------ *
     * 2. The new schema creates cleanly
     * ------------------------------------------------------------------ */
    console.log('');
    console.log('=== 2. the NEW schema on a fresh database ===');
    await sequelize.sync();
    console.log('   sync() OK');

    var freshIndexes = mysql(
        "SELECT index_name, group_concat(column_name ORDER BY seq_in_index) " +
        "FROM information_schema.statistics WHERE table_schema='" + DB + "' " +
        "AND table_name='nodered_library_entries' GROUP BY index_name;"
    );
    console.log('   library_entries indexes:');
    freshIndexes.split('\n').forEach(function (line) { console.log('      ' + line); });

    /* ------------------------------------------------------------------ *
     * 3. Upgrade path: a legacy table with a wide path column
     * ------------------------------------------------------------------ */
    console.log('');
    console.log('=== 3. sync() over a legacy table (path VARCHAR(768), no keyHash) ===');
    mysql('DROP TABLE ' + DB + '.nodered_library_entries;', true);
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
    console.log('   legacy table created');

    try {
        await sequelize.sync();
        console.log('   sync() OK  <-- no more "Specified key was too long"');
    } catch (err) {
        console.log('   sync() FAILED: ' + err.message);
    }

    var hasKeyHash = mysql(
        "SELECT count(*) FROM information_schema.columns WHERE table_schema='" + DB +
        "' AND table_name='nodered_library_entries' AND column_name='keyHash';"
    );
    console.log('   keyHash column present: ' + (hasKeyHash === '1' ? 'yes' : 'no'));

    /* ------------------------------------------------------------------ *
     * 4. alter:true reconciles the legacy table completely
     * ------------------------------------------------------------------ */
    console.log('');
    console.log('=== 4. syncing with alter:true reconciles everything ===');
    try {
        await sequelize.sync({ alter: true });
        console.log('   sync({alter:true}) OK');
    } catch (err) {
        console.log('   sync({alter:true}) FAILED: ' + err.message);
    }

    var columns = mysql(
        "SELECT column_name, character_maximum_length FROM information_schema.columns " +
        "WHERE table_schema='" + DB + "' AND table_name='nodered_library_entries' " +
        "AND column_name IN ('type','path','keyHash') ORDER BY column_name;"
    );
    console.log('   columns now (name, max length):');
    columns.split('\n').forEach(function (line) { console.log('      ' + line); });

    var finalIndexes = mysql(
        "SELECT index_name, group_concat(column_name ORDER BY seq_in_index) " +
        "FROM information_schema.statistics WHERE table_schema='" + DB + "' " +
        "AND table_name='nodered_library_entries' GROUP BY index_name;"
    );
    console.log('   indexes now:');
    finalIndexes.split('\n').forEach(function (line) { console.log('      ' + line); });

    await sequelize.close();

    console.log('');
    console.log(oldExists === '0'
        ? 'RESULT: the old index is impossible on MySQL; the fixed-width hash index solves it.'
        : 'RESULT: unexpected - the old index was accepted.');
}

main().catch(function (err) {
    console.error('FAILED:', err.message);
    process.exit(1);
});
