FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application (including .env file)
COPY . .

# Build TypeScript components if they exist
RUN if [ -d "mcp-client-bedrock" ]; then cd mcp-client-bedrock && npm install && npm run build; fi
RUN if [ -d "mcp-dynamo" ]; then cd mcp-dynamo && npm install && npm run build; fi

# Debug: Check if .env file exists and show its contents
RUN if [ -f .env ]; then echo ".env file found:" && cat .env; else echo ".env file not found"; fi

# Debug: List the build directory contents
RUN if [ -d "mcp-client-bedrock/build" ]; then ls -la mcp-client-bedrock/build/; fi

# Expose the port
EXPOSE 3000

# Set default environment variables (can be overridden at runtime)
ENV NODE_ENV=production
ENV PORT=3000
ENV AWS_REGION=us-east-1

# Start the application
CMD ["node", "endpoint.js"]
