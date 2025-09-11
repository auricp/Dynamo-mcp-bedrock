# MCP Client with AWS Bedrock

This is a Model Context Protocol (MCP) client that uses AWS Bedrock to interact with Claude models.

## Setup

1. Install dependencies:
```
npm install
```

2. Configure AWS credentials:
   - Either set up your AWS credentials in `~/.aws/credentials` 
   - Or add your AWS credentials to the `.env` file

3. Build the TypeScript code:
```
npm run build
```

## Usage

Run the client with a path to an MCP server script:

```
node build/index.js /path/to/mcp/server.js
```

Or with a Python server:

```
node build/index.js /path/to/mcp/server.py
```

## Testing Bedrock Access

To test your access to Bedrock models:

```
npm run test
```

This will try several Claude models to find which ones work with your AWS account.

## Supported Models

The following models have been tested and work with this client:
- anthropic.claude-3-sonnet-20240229-v1:0
- anthropic.claude-3-haiku-20240307-v1:0
- anthropic.claude-instant-v1

## Environment Variables

Configure these in the `.env` file:

- `AWS_REGION`: AWS region where Bedrock is available (required)
- `AWS_ACCESS_KEY_ID`: Your AWS access key (optional if using default profile)
- `AWS_SECRET_ACCESS_KEY`: Your AWS secret key (optional if using default profile)

## Features

- Connects to MCP servers to access their tools
- Uses AWS Bedrock to interact with Claude models
- Supports tool use for enhanced capabilities
