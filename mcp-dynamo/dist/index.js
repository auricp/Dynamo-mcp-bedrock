#!/usr/bin/env node
// MCP DynamoDB server using MCP protocol for Bedrock
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DynamoDBClient, CreateTableCommand, ListTablesCommand, PutItemCommand, GetItemCommand, QueryCommand, ScanCommand, DescribeTableCommand, KeyType } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
const region = process.env.AWS_REGION;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
const sessionToken = process.env.AWS_SESSION_TOKEN;
const dynamoClient = new DynamoDBClient({
    region,
    credentials: accessKeyId && secretAccessKey ? {
        accessKeyId,
        secretAccessKey,
        sessionToken
    } : undefined,
});
const server = new McpServer({
    name: "dynamo",
    version: "1.0.0",
    capabilities: {
        resources: {},
        tools: {},
    },
});
server.tool("list-tables", "List all DynamoDB tables", {}, async () => {
    const resp = await dynamoClient.send(new ListTablesCommand({}));
    return {
        content: [{ type: "text", text: JSON.stringify(resp.TableNames) }],
    };
});
server.tool("describe-table", "Describe a DynamoDB table", {
    tableName: z.string().describe("Name of the table"),
}, async ({ tableName }) => {
    const resp = await dynamoClient.send(new DescribeTableCommand({ TableName: tableName }));
    return {
        content: [{ type: "text", text: JSON.stringify(resp.Table) }],
    };
});
server.tool("put-item", "Put an item into a DynamoDB table", {
    tableName: z.string().describe("Name of the table"),
    item: z.record(z.any()).describe("Item to put (as a key-value object)"),
}, async ({ tableName, item }) => {
    await dynamoClient.send(new PutItemCommand({ TableName: tableName, Item: marshall(item) }));
    return {
        content: [{ type: "text", text: `Item put in table ${tableName}` }],
    };
});
server.tool("get-item", "Get an item from a DynamoDB table", {
    tableName: z.string().describe("Name of the table"),
    key: z.record(z.any()).describe("Key object for the item"),
}, async ({ tableName, key }) => {
    const resp = await dynamoClient.send(new GetItemCommand({ TableName: tableName, Key: marshall(key) }));
    return {
        content: [{ type: "text", text: JSON.stringify(resp.Item ? unmarshall(resp.Item) : null) }],
    };
});
server.tool("query-table", "Query a DynamoDB table", {
    tableName: z.string().describe("Name of the table"),
    keyConditionExpression: z.string().describe("Key condition expression"),
    expressionAttributeValues: z.record(z.any()).describe("Values for the key condition expression"),
}, async ({ tableName, keyConditionExpression, expressionAttributeValues }) => {
    const resp = await dynamoClient.send(new QueryCommand({
        TableName: tableName,
        KeyConditionExpression: keyConditionExpression,
        ExpressionAttributeValues: marshall(expressionAttributeValues),
    }));
    return {
        content: [{ type: "text", text: JSON.stringify(resp.Items ? resp.Items.map(item => unmarshall(item)) : []) }],
    };
});
server.tool("scan-table", "Scan a DynamoDB table", {
    tableName: z.string().describe("Name of the table"),
}, async ({ tableName }) => {
    const resp = await dynamoClient.send(new ScanCommand({ TableName: tableName }));
    return {
        content: [{ type: "text", text: JSON.stringify(resp.Items ? resp.Items.map(item => unmarshall(item)) : []) }],
    };
});
server.tool("create-table", "Create a DynamoDB table", {
    tableName: z.string().describe("Name of the table"),
    partitionKey: z.string().describe("Partition key name"),
    partitionKeyType: z.enum(["S", "N", "B"]).describe("Partition key type"),
    sortKey: z.string().optional().describe("Sort key name (optional)"),
    sortKeyType: z.enum(["S", "N", "B"]).optional().describe("Sort key type (optional)"),
    readCapacity: z.number().describe("Read capacity units"),
    writeCapacity: z.number().describe("Write capacity units"),
}, async ({ tableName, partitionKey, partitionKeyType, sortKey, sortKeyType, readCapacity, writeCapacity }) => {
    const attrDefs = [
        { AttributeName: partitionKey, AttributeType: partitionKeyType },
        ...(sortKey ? [{ AttributeName: sortKey, AttributeType: sortKeyType }] : []),
    ];
    const keySchema = [
        { AttributeName: partitionKey, KeyType: KeyType.HASH },
        ...(sortKey ? [{ AttributeName: sortKey, KeyType: KeyType.RANGE }] : []),
    ];
    const resp = await dynamoClient.send(new CreateTableCommand({
        TableName: tableName,
        AttributeDefinitions: attrDefs,
        KeySchema: keySchema,
        ProvisionedThroughput: {
            ReadCapacityUnits: readCapacity,
            WriteCapacityUnits: writeCapacity,
        },
    }));
    return {
        content: [{ type: "text", text: JSON.stringify(resp.TableDescription) }],
    };
});
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("Dynamo MCP Server running on stdio");
}
main().catch((error) => {
    console.error("Fatal error in main():", error);
    process.exit(1);
});
