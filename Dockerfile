# Use official Node.js LTS version
FROM node:20-alpine

# Set working directory
WORKDIR /app

# Create a non-root user and group
RUN addgroup -S app && adduser -S app -G app

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --only=production

# Copy application files
COPY *.js ./

# Ensure app owns the working directory
RUN chown -R app:app /app

# Drop privileges
USER app

# Expose ports for REST API and MCP HTTP server
EXPOSE 3000 3001

# Default command (start the REST API server)
# To run MCP HTTP server instead: docker run <image> node mcp-server-http.js
CMD ["node", "index.js"]
