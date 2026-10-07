# node-red-express

Node-RED embebido en un servidor Express, empaquetado como imagen Docker y
listo para desplegarse en **Render.com**.

La persistencia (flujos, credenciales, settings, sesiones, librería y contexto)
se delega en el paquete [`node-red-storage-sequelize`](https://www.npmjs.com/package/node-red-storage-sequelize),
que guarda todo en **PostgreSQL** o **MySQL** a través de Sequelize. Al no
depender de un disco local, el contenedor puede recrearse sin perder datos, lo
que permite usar el plan gratuito de Render.

## Ventajas frente a la imagen oficial

- Express envuelve el runtime, así que se pueden añadir rutas y middlewares
  propios antes o después del editor.
- Página 404 personalizada (`public/error-404.html`).
- Imágenes de marca (favicon, logo y portada de login) sustituibles **sin
  reconstruir la imagen**, montando una carpeta y apuntando `NODE_RED_ASSETS_DIR`.
- Todo se configura por variables de entorno.

## Estructura

```text
node-red-express/
├── Dockerfile              # Build multi-etapa (deps -> runtime slim)
├── docker-compose.yml      # Pruebas locales con la misma configuración
├── render.yaml             # Blueprint de Render
├── .dockerignore
├── .env.example            # Plantilla de variables de entorno
├── index.js                # Express + Node-RED + settings
├── assets/                 # favicon.ico, logo.png, cover.png
├── public/                 # error-404.html
└── scripts/                # Utilidades de verificación (no van a la imagen)
```

## Ejecución local

```bash
npm install
cp .env.example .env        # rellena las credenciales de la base de datos
npm start
```

Editor en <http://localhost:8000/admin>.

Sin `NODE_RED_STORAGE_DIALECT` definido, Node-RED usa su almacenamiento en
ficheros y el contexto en memoria, igual que una instalación estándar.

## Ejecución con Docker

```bash
cp .env.example .env
docker compose up --build
```

Editor en <http://localhost:8000/admin>. El `docker-compose.yml` reproduce la
configuración de producción: misma imagen, mismas variables y mismo healthcheck.

## Despliegue en Render

### 1. Prepara la base de datos

Cualquier PostgreSQL o MySQL gestionado sirve. Si el proveedor entrega una
cadena de conexión, esa es la vía más simple:

```text
postgresql://usuario:password@host:5432/nodered?sslmode=require
```

> Con Supabase evita la conexión "Directa" (`db.<ref>.supabase.co`): es solo
> IPv6 y falla dentro de Docker con `EAI_AGAIN`. Usa el **Session pooler**, cuyo
> host (`aws-0-<region>.pooler.supabase.com`) sí tiene IPv4.

### 2. Genera el hash de la contraseña

```bash
node -e "console.log(require('bcryptjs').hashSync('tu-password', 8))"
```

### 3. Despliega

`New -> Blueprint` y conecta el repositorio. Render detecta el `render.yaml` y
construye el `Dockerfile`.

Define como **secret** en el panel:

| Variable | Descripción |
|---|---|
| `NODE_RED_STORAGE_URL` | Cadena de conexión a la base de datos |
| `NODE_RED_ADMIN_HASH` | Hash bcrypt de la contraseña del editor |

El resto de variables (`NODE_RED_TITLE`, `NODE_RED_STORAGE_DIALECT`,
`NODE_RED_STORAGE_SSL`...) ya vienen con valores por defecto en `render.yaml`.

El editor queda en `https://TU-APP.onrender.com/admin`.

## Variables de entorno

### Servidor

| Variable | Defecto | Descripción |
|---|---|---|
| `PORT` | `8000` | Puerto de escucha. Render lo inyecta automáticamente. |
| `HOST` | `0.0.0.0` | Interfaz de escucha. |
| `TZ` | — | Zona horaria de los nodos. |

### Editor y apariencia

| Variable | Defecto | Descripción |
|---|---|---|
| `NODE_RED_TITLE` | `Node-RED Cloud` | Título de la pestaña y de la cabecera. |
| `NODE_RED_ADMIN_ROOT` | `/admin` | Ruta del editor. |
| `NODE_RED_NODE_ROOT` | `/` | Ruta de los nodos HTTP. |
| `NODE_RED_HEADER_URL` | `https://nodered.org` | Enlace del logo. |
| `NODE_RED_ASSETS_DIR` | `./assets` | Carpeta con `favicon.ico`, `logo.png` y `cover.png`. Si un archivo falta, se usa el de Node-RED. |
| `NODE_RED_TRUST_PROXY` | `true` | Confía en las cabeceras `X-Forwarded-*` del proxy. |
| `NODE_RED_LOG_LEVEL` | `info` | Nivel de log en consola. |

### Seguridad

| Variable | Descripción |
|---|---|
| `NODE_RED_ADMIN_USER` | Usuario del editor. |
| `NODE_RED_ADMIN_HASH` | Hash bcrypt de la contraseña. |
| `NODE_RED_CREDENTIAL_SECRET` | Semilla de cifrado de credenciales. Con varias réplicas todas deben compartirla. |

### Persistencia

| Variable | Defecto | Descripción |
|---|---|---|
| `NODE_RED_STORAGE_DIALECT` | — | `postgres`, `mysql`, `mariadb`, `mssql` o `sqlite`. Sin definir, no se usa base de datos. |
| `NODE_RED_STORAGE_URL` | — | Cadena de conexión completa. Tiene prioridad sobre las variables sueltas. |
| `NODE_RED_STORAGE_HOST` | `localhost` | Host de la base de datos. |
| `NODE_RED_STORAGE_PORT` | — | Puerto. |
| `NODE_RED_STORAGE_DATABASE` | — | Nombre de la base de datos. |
| `NODE_RED_STORAGE_USERNAME` | — | Usuario. |
| `NODE_RED_STORAGE_PASSWORD` | — | Contraseña. |
| `NODE_RED_STORAGE_SCHEMA` | `public` | Esquema (solo Postgres). |
| `NODE_RED_STORAGE_SSL` | `false` | Activa TLS. Necesario en bases de datos gestionadas. |
| `NODE_RED_STORAGE_SSL_REJECT_UNAUTHORIZED` | `true` | Ponlo a `false` con certificados autofirmados. |
| `NODE_RED_STORAGE_POOL_MAX` | `5` | Conexiones máximas del pool. |
| `NODE_RED_STORAGE_LOGGING` | `false` | Muestra el SQL ejecutado. |
| `NODE_RED_STORAGE_FLUSH_INTERVAL` | `0` | Segundos de batching del contexto. `0` escribe al instante. |
| `NODE_RED_STORAGE_CACHE_TTL` | `0` | Segundos de caché de lectura. `0` lee siempre de la base de datos. |

## Tablas creadas

El esquema se aplica solo al arrancar (es idempotente):

| Capa de Node-RED | Tabla |
|---|---|
| Flujos | `nodered_flows` |
| Credenciales cifradas | `nodered_credentials` |
| Settings / semilla de credenciales | `nodered_settings` |
| Sesiones del editor | `nodered_sessions` |
| Librería | `nodered_library_entries` |
| Contexto, en sus tres ámbitos | `nodered_context` |

## Personalizar las imágenes

Coloca tus archivos en `assets/` con estos nombres exactos:

| Archivo | Uso |
|---|---|
| `favicon.ico` | Icono de la pestaña. |
| `logo.png` | Logo de la cabecera del editor. |
| `cover.png` | Imagen de la pantalla de login. |

Se copian en la imagen en tiempo de build. Para cambiarlas sin reconstruir,
monta un volumen y apunta `NODE_RED_ASSETS_DIR` a esa carpeta.

## Healthcheck

`GET /admin/` devuelve **200** (pantalla de login) o **401** (con `adminAuth`
activo). Ambos códigos confirman que el editor está vivo, así que el
`HEALTHCHECK` del `Dockerfile` y el `healthCheckPath` de `render.yaml` aceptan
los dos.

## Contexto de Node-RED

Con un dialecto configurado, el contexto se guarda en la misma base de datos que
los flujos. `global`, `flow` y `node` quedan en la tabla `nodered_context`, por
lo que sobreviven a reinicios y son visibles desde fuera del proceso.

## Verificación

```bash
npm start                                   # arranque básico
node scripts/verify-defaults.js             # comportamiento sin dialecto
node scripts/verify-unified.js postgres     # storage + contexto end-to-end
```

> Los scripts leen `.env`, así que al probar un dialecto distinto al configurado
> hay que sobrescribir host, puerto, base de datos y credenciales, o apuntarán
> al puerto equivocado.
