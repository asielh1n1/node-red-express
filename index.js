var path = require("path");
var http = require("http");
var express = require("express");
var RED = require("node-red");

// Load environment variables from the .env file located next to this script.
require("dotenv").config({ path: path.join(__dirname, ".env") });

// Single package for BOTH persistence concerns:
//   - the storage module  (flows, credentials, settings, sessions, library)
//   - the context store   (global / flow / node variables)
//
// One variable drives them together: setting NODE_RED_STORAGE_DIALECT moves
// everything to that database. Without it, flows stay on the filesystem and
// context stays in memory, exactly like a stock Node-RED install.
//
// The package is consumed from npm; the database driver it needs at runtime
// (pg / pg-hstore for PostgreSQL, mysql2 for MySQL) is a direct dependency of
// this project so the dialect can be switched with no extra install step.
var nodeRedStorage = require("node-red-storage-sequelize");

// Absolute path to the project folder (works no matter where the project is deployed)
var projectRoot = __dirname;
var publicDir = path.join(projectRoot, "public");

/**
 * Reads an environment variable, treating empty strings as "not configured".
 * @param {string} name Variable name.
 * @returns {string|undefined} The value, or undefined when unset/blank.
 */
function env(name) {
    var value = process.env[name];
    return value === undefined || value === null || String(value).trim() === ""
        ? undefined
        : String(value).trim();
}

// Directory holding the editor branding: favicon.ico, logo.png and cover.png.
// Overridable so a deployment (e.g. Docker) can mount its own artwork from a
// volume without rebuilding the image.
var assetsDir = env("NODE_RED_ASSETS_DIR")
    ? path.resolve(env("NODE_RED_ASSETS_DIR"))
    : path.join(projectRoot, "assets");

// Logo/favicon/cover artwork are user-supplied and therefore optional: pointing
// Node-RED at a missing file makes the editor render a broken image, so each
// entry falls back to undefined and lets Node-RED use its built-in defaults.
var faviconPath = path.join(assetsDir, "favicon.ico");
var logoPath = path.join(assetsDir, "logo.png");
var coverPath = path.join(assetsDir, "cover.png");

/**
 * Returns the asset path when the file exists, otherwise undefined.
 * @param {string} filePath Candidate file.
 * @returns {string|undefined} A usable path or undefined.
 */
function assetPath(filePath) {
    return require("fs").existsSync(filePath) ? filePath : undefined;
}

// Node-RED user directory. Defaults to a ".node-red" folder inside the project
// so all runtime data stays with the deployment.
var userDir = env("NODE_RED_USER_DIR")
    ? path.resolve(env("NODE_RED_USER_DIR"))
    : path.join(projectRoot, ".node-red");

// Both blocks are produced by the package itself, so the embedding application
// never has to know how the backends are wired. The package also owns the TLS
// negotiation of NODE_RED_STORAGE_URL, including the libpq compatibility that
// managed Postgres providers such as Supabase need.
var storageModule = nodeRedStorage.buildStorageModule();
var contextStorage = nodeRedStorage.buildContextStorage();

// Create an Express app
var app = express();

// Behind a reverse proxy (nginx, Traefik, Fly, Render...) the real client IP and
// protocol arrive in X-Forwarded-* headers. Trusting the first hop makes Express
// report https correctly, which Node-RED needs for secure cookies and for
// building absolute editor URLs.
// Set NODE_RED_TRUST_PROXY=false to serve the app directly.
app.set("trust proxy", process.env.NODE_RED_TRUST_PROXY === "false" ? false : 1);

// Add a simple route for static content served from 'public'
app.use("/", express.static(publicDir));

// Expose the editor assets (favicon, logo, cover) as static files
app.use("/assets", express.static(assetsDir));

// Create a server
var server = http.createServer(app);

// Create the settings object - see default settings.js file for other options
var settings = {
    httpAdminRoot: process.env.NODE_RED_ADMIN_ROOT || "/admin",
    httpNodeRoot: process.env.NODE_RED_NODE_ROOT || "/",
    userDir: userDir,

    // Flows, credentials, settings, sessions and library. Defaults to Node-RED's
    // own filesystem storage; switches to the database when a dialect is set.
    storageModule: storageModule,

    // Global/flow/node variables. Defaults to memory; switches to the database
    // when a dialect is set.
    contextStorage: contextStorage,

    functionGlobalContext: { },

    // Seed used by Node-RED to encrypt flow credentials. When it is not set the
    // runtime generates one and stores it in the settings row of the database,
    // which is fine for a single instance. With several replicas, or when
    // migrating between databases, all of them must share the same secret or
    // the stored credentials cannot be decrypted.
    credentialSecret: env("NODE_RED_CREDENTIAL_SECRET") || undefined,

    // Behind Render's proxy the client protocol arrives in X-Forwarded-Proto.
    // Without this Node-RED believes it is serving plain HTTP and builds the
    // editor/WebSocket URLs with the wrong scheme.
    httpAdminTrustProxy: process.env.NODE_RED_TRUST_PROXY !== "false",

    editorTheme: {
        page: {
            title: process.env.NODE_RED_TITLE || "Node-RED Cloud",
            // Undefined keeps Node-RED's bundled favicon.
            favicon: assetPath(faviconPath),
        },
        header: {
            title: process.env.NODE_RED_TITLE || "Node-RED Cloud",
            // Undefined keeps Node-RED's bundled logo.
            image: assetPath(logoPath),
            url: process.env.NODE_RED_HEADER_URL || "https://nodered.org",
        },
        login: {
            // Undefined renders the default login cover.
            image: assetPath(coverPath),
        },
    },
    adminAuth: {
        type: "credentials",
        users: [
            {
                username: process.env.NODE_RED_ADMIN_USER || "admin",
                password: process.env.NODE_RED_ADMIN_HASH,
                permissions: "*",
            },
        ],
    }
};

// Initialise the runtime with a server and settings
RED.init(server,settings);

// Serve the editor UI from /admin
app.use(settings.httpAdminRoot, RED.httpAdmin);

// Serve the http nodes UI from /
app.use(settings.httpNodeRoot, RED.httpNode);

app.use((req, res) => {
  res.status(404).sendFile(path.join(__dirname, 'public', 'error-404.html'));
});

var port = Number(process.env.PORT) || 8000;

// Binding to 0.0.0.0 is required inside a container: binding to localhost would
// make the port unreachable from outside it, so Render's health check and the
// proxy would both fail.
var host = process.env.HOST || "0.0.0.0";

server.listen(port, host, function () {
    console.log("[node-red-express] Listening on http://" + host + ":" + port + settings.httpAdminRoot);
});

server.on("error", function (err) {
    console.error("[node-red-express] Failed to bind port " + port + ": " + err.message);
    process.exit(1);
});

// Start the runtime
RED.start().catch(function (err) {
    console.error("[node-red-express] Node-RED failed to start: " + (err && err.stack ? err.stack : err));
    process.exit(1);
});

/**
 * Drains in-flight work on shutdown so pending context writes reach the
 * database before the process dies. Render sends SIGTERM on every deploy or
 * restart, which without this handler would drop the last batch of writes.
 * @param {string} signal Received signal name.
 * @returns {void}
 */
function shutdown(signal) {
    console.log("[node-red-express] Received " + signal + ", shutting down");
    server.close(function () {
        // The storage module exposes close() and flushes what is buffered.
        var close = nodeRedStorage.close;
        if (typeof close !== "function") {
            process.exit(0);
            return;
        }
        Promise.resolve(close.call(nodeRedStorage)).then(
            function () { process.exit(0); },
            function (err) {
                console.error("[node-red-express] Error during shutdown: " + err);
                process.exit(1);
            }
        );
    });
}

["SIGTERM", "SIGINT"].forEach(function (signal) {
    process.on(signal, function () { shutdown(signal); });
});