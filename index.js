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
var assetsDir = path.join(projectRoot, "assets");
var publicDir = path.join(projectRoot, "public");

// Node-RED user directory. Defaults to a ".node-red" folder inside the project
// so all runtime data stays with the deployment.
var userDir = process.env.NODE_RED_USER_DIR
    ? path.resolve(process.env.NODE_RED_USER_DIR)
    : path.join(projectRoot, ".node-red");

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

// Both blocks are produced by the package itself, so the embedding application
// never has to know how the backends are wired.
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
    editorTheme: {
        page: {
            title: process.env.NODE_RED_TITLE || "Node-RED Cloud",
            favicon: path.join(assetsDir, "favicon.ico"),
        },
        header: {
            title: process.env.NODE_RED_TITLE || "Node-RED Cloud",
            image: path.join(assetsDir, "logo.png"),
            url: process.env.NODE_RED_HEADER_URL || "https://nodered.org",
        },
        login: {
            image: path.join(assetsDir, "cover.png"),
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

server.listen(port, function () {
    console.log("[node-red-express] Listening on http://localhost:" + port + settings.httpAdminRoot);
});

// Start the runtime
RED.start();