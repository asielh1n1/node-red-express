# ==========================================================================
# Node-RED embebido en Express — imagen lista para Render.com
#
# Enfoque multi-etapa:
#   1. "deps"  -> instala las dependencias de produccion con npm ci.
#                 Incluye node-red-storage-sequelize (desde npm), pg,
#                 pg-hstore y mysql2. Todo es JavaScript puro, sin addons
#                 nativos, asi que la etapa builder puede ser "slim".
#   2. runtime -> copia SOLO node_modules + el codigo de la app sobre una
#                 imagen "slim". Sin toolchain de compilacion en la imagen
#                 final (menos tamaño y menos superficie de ataque).
#
# En tiempo de ejecucion solo hay que pasar variables de entorno:
#   NODE_RED_STORAGE_DIALECT + NODE_RED_STORAGE_*  (o NODE_RED_STORAGE_URL)
#   NODE_RED_ADMIN_USER / NODE_RED_ADMIN_HASH
#   NODE_RED_TITLE, PORT, NODE_RED_HEADER_URL, ...
#
# Render detecta el Dockerfile y hace `docker build` automaticamente.
# ==========================================================================

# --------------------------------------------------------------------------
# Etapa 1: dependencias
# --------------------------------------------------------------------------
FROM node:22-slim AS deps

WORKDIR /app

# Se copian solo los manifiestos para aprovechar la cache de capas de Docker:
# si el codigo cambia pero las dependencias no, npm ci no se vuelve a ejecutar.
COPY package.json package-lock.json ./

# `npm ci` es reproducible y falla si el lockfile no concuerda con el
# package.json. Se omiten las dependencias de desarrollo porque la imagen solo
# ejecuta el runtime.
RUN npm ci --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# --------------------------------------------------------------------------
# Etapa 2: imagen final
# --------------------------------------------------------------------------
FROM node:22-slim AS runtime

ENV NODE_ENV=production
ENV NODE_OPTIONS=--max-old-space-size=384

# Los nodos que se instalan desde el gestor de paleta aterrizan en
# ${NODE_RED_USER_DIR}/node_modules, que es un arbol distinto de
# /app/node_modules. Cuando una dependencia de esos nodos hace
# require("pg") (Sequelize lo hace desde node-red-contrib-orm-db), Node sube
# por ese arbol (/data/node_modules -> /data -> /) y nunca llega a
# /app/node_modules, asi que falla con:
#   "Error creating sequelize instance. Please install pg package manually"
# aunque pg este instalado en la imagen. NODE_PATH pone los drivers de la
# aplicacion (pg, pg-hstore, mysql2) como ultimo recurso de resolucion.
ENV NODE_PATH=/app/node_modules

# wget se usa unicamente para el HEALTHCHECK de mas abajo.
RUN apt-get update \
    && apt-get install -y --no-install-recommends wget \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencias ya resueltas, sin toolchain.
COPY --from=deps /app/node_modules ./node_modules

# Codigo de la aplicacion.
COPY package.json ./
COPY index.js ./
COPY assets ./assets
COPY public ./public

# --------------------------------------------------------------------------
# Datos de runtime
#
# NODE_RED_USER_DIR es el userDir de Node-RED. Cuando hay un dialecto
# configurado, los flujos/credenciales/settings/contexto viven en la base de
# datos y esta carpeta solo guarda scratch de runtime (node_modules de nodos
# de paleta que se instalen en caliente, etc.).
#
# Se crea aqui y se le da la propiedad al usuario `node` (uid 1000), el mismo
# con el que corre la imagen oficial, para que los volumenes montados encima
# hereden permisos correctos.
# --------------------------------------------------------------------------
ENV NODE_RED_USER_DIR=/data
RUN mkdir -p /data && chown -R node:node /data

# Node-RED reads <userDir>/package.json on startup to know which palette nodes
# to load. The official image ships one in /data; since this image uses its own
# userDir, a minimal manifest is created here so startup does not log
# "ENOENT: no such file or directory, open '/data/package.json'".
# Nodes installed later from the palette editor are appended to this file.
RUN printf '{\n  "name": "node-red-userdir",\n  "version": "1.0.0",\n  "private": true,\n  "description": "Node-RED user directory for node-red-express",\n  "dependencies": {}\n}\n' > /data/package.json \
    && chown node:node /data/package.json

USER node

# El puerto real lo inyecta Render via la variable PORT. 8000 es el valor por
# defecto que usa index.js, asi que documentamos ese.
EXPOSE 8000

# `/admin/` responde 200 (pagina de login) o 401 cuando hay adminAuth.
# Ambos codigos confirman que el editor esta vivo, por eso se aceptan los dos.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
    CMD wget -q -S --spider "http://127.0.0.1:${PORT:-8000}/admin/" 2>&1 \
        | grep -qE "HTTP/1\.[01] (200|302|401)" || exit 1

# `node index.js` arranca Express + Node-RED en un solo proceso.
CMD ["node", "index.js"]
