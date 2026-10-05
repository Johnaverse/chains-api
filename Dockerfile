# Official Node.js LTS, pinned by digest so the same source commit always
# builds against the same base-image contents (a mutable tag can be repointed
# upstream). The digest is the multi-arch OCI index for the tag in the
# comment; refresh it deliberately — resolve the tag's current index digest
# (e.g. `docker buildx imagetools inspect node:20-alpine`), update, rescan.
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293

# Set working directory
WORKDIR /app

# Create a non-root user and group
RUN addgroup -S app && adduser -S app -G app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# The release gate fails on HIGH/CRITICAL findings, and the base image ships both: stale
# OpenSSL in Alpine and npm's own bundled dependencies. Nothing runs npm after `npm ci`, so
# removing it (and patching Alpine) clears the findings instead of ignoring them.
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
           /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Copy application files
COPY *.js ./
COPY src/ ./src/
COPY data/ ./data/
COPY public/ ./public/

# Ensure app owns the working directory
RUN chown -R app:app /app

# Drop privileges
USER app

# Expose ports for REST API and MCP HTTP server
EXPOSE 3000 3001

# Default command: combined server — REST API (3000) + MCP HTTP (3001) in one
# process sharing a single in-memory store and a single refresh loop, so the
# same public RPC endpoints aren't pinged twice.
# To run only the REST API: docker run <image> node index.js
# To run only the MCP HTTP server: docker run <image> node mcp-server-http.js
CMD ["node", "server.js"]
