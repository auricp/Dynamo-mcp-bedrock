#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  DynamoDBClient,
  CreateTableCommand,
  ListTablesCommand,
  DescribeTableCommand,
  UpdateTableCommand,
  PutItemCommand,
  GetItemCommand,
  UpdateItemCommand,
  QueryCommand,
  ScanCommand,
  DeleteItemCommand,
  BatchGetItemCommand,
  BatchWriteItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";

// AWS client initialization
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const dynamoClient = new DynamoDBClient({
  region: process.env.AWS_REGION,
  ...(accessKeyId && secretAccessKey
    ? { credentials: { accessKeyId, secretAccessKey } }
    : {}),
});

// Enhanced tool definitions with better descriptions and examples
const DYNAMODB_CREATE_TABLE_TOOL: Tool = {
  name: "dynamodb:create_table",
  description: "Creates a new DynamoDB table with specified configuration",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table to create" },
      partitionKey: { type: "string", description: "Name of the partition key" },
      partitionKeyType: { type: "string", enum: ["S", "N", "B"], description: "Type of partition key (S=String, N=Number, B=Binary)" },
      sortKey: { type: "string", description: "Name of the sort key (optional)" },
      sortKeyType: { type: "string", enum: ["S", "N", "B"], description: "Type of sort key (optional)" },
      readCapacity: { type: "number", description: "Provisioned read capacity units" },
      writeCapacity: { type: "number", description: "Provisioned write capacity units" },
    },
    required: ["tableName", "partitionKey", "partitionKeyType", "readCapacity", "writeCapacity"],
  },
    };


const DYNAMODB_LIST_TABLES_TOOL: Tool = {
  name: "dynamodb:list_tables",
  description: "Lists all DynamoDB tables in the account",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Maximum number of tables to return (optional)" },
      exclusiveStartTableName: { type: "string", description: "Name of the table to start from for pagination (optional)" },
    },
  },
};

const DYNAMODB_DESCRIBE_TABLE_TOOL: Tool = {
  name: "dynamodb:describe_table",
  description: "Gets detailed information about a DynamoDB table including schema, indexes, and capacity",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table to describe" },
    },
    required: ["tableName"],
  },
};

const DYNAMODB_PUT_ITEM_TOOL: Tool = {
  name: "dynamodb:put_item",
  description: "Inserts or replaces an item in a table",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      item: { type: "object", description: "Item to put into the table" },
    },
    required: ["tableName", "item"],
  },
};

const DYNAMODB_GET_ITEM_TOOL: Tool = {
  name: "dynamodb:get_item",
  description: "Retrieves an item from a table by its primary key",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      key: { type: "object", description: "Primary key of the item to retrieve" },
    },
    required: ["tableName", "key"],
  },
};

const DYNAMODB_UPDATE_ITEM_TOOL: Tool = {
  name: "dynamodb:update_item",
  description: "Updates specific attributes of an item in a table",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      key: { type: "object", description: "Primary key of the item to update" },
      updateExpression: { type: "string", description: "Update expression (e.g., 'SET #n = :name')" },
      expressionAttributeNames: { type: "object", description: "Attribute name mappings" },
      expressionAttributeValues: { type: "object", description: "Values for the update expression" },
      conditionExpression: { type: "string", description: "Condition for update (optional)" },
      returnValues: { type: "string", enum: ["NONE", "ALL_OLD", "UPDATED_OLD", "ALL_NEW", "UPDATED_NEW"], description: "What values to return" },
    },
    required: ["tableName", "key", "updateExpression", "expressionAttributeNames", "expressionAttributeValues"],
  },
};

const DYNAMODB_DELETE_ITEM_TOOL: Tool = {
  name: "dynamodb:delete_item",
  description: "Deletes an item from a table by its primary key",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      key: { type: "object", description: "Primary key of the item to delete" },
      conditionExpression: { type: "string", description: "Condition for deletion (optional)" },
      expressionAttributeNames: { type: "object", description: "Attribute name mappings (optional)" },
      expressionAttributeValues: { type: "object", description: "Values for condition expression (optional)" },
      returnValues: { type: "string", enum: ["NONE", "ALL_OLD"], description: "What values to return" },
    },
    required: ["tableName", "key"],
  },
};

const DYNAMODB_QUERY_TABLE_TOOL: Tool = {
  name: "dynamodb:query_table",
  description: "Queries a table using key conditions and optional filters. Most efficient for retrieving items with known partition key.",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      keyConditionExpression: { type: "string", description: "Key condition expression (required for query)" },
      expressionAttributeValues: { type: "object", description: "Values for the key condition expression" },
      expressionAttributeNames: { type: "object", description: "Attribute name mappings (optional)" },
      filterExpression: { type: "string", description: "Filter expression for results (optional)" },
      limit: { type: "number", description: "Maximum number of items to return (optional)" },
      indexName: { type: "string", description: "Name of the index to query (optional)" },
      scanIndexForward: { type: "boolean", description: "Sort order for range key (true=ascending, false=descending)" },
    },
    required: ["tableName", "keyConditionExpression", "expressionAttributeValues"],
  },
};

const DYNAMODB_SCAN_TABLE_TOOL: Tool = {
  name: "dynamodb:scan_table",
  description: "Scans an entire table with optional filters. Use for full table scans or when partition key is unknown.",
  inputSchema: {
    type: "object", 
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      filterExpression: { type: "string", description: "Filter expression (optional)" },
      expressionAttributeValues: { type: "object", description: "Values for the filter expression (optional)" },
      expressionAttributeNames: { type: "object", description: "Attribute name mappings (optional)" },
      limit: { type: "number", description: "Maximum number of items to return (optional)" },
      indexName: { type: "string", description: "Name of the index to scan (optional)" },
    },
    required: ["tableName"],
  },
};

const DYNAMODB_UPDATE_CAPACITY_TOOL: Tool = {
  name: "dynamodb:update_capacity",
  description: "Updates the provisioned capacity of a table",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      readCapacity: { type: "number", description: "New read capacity units" },
      writeCapacity: { type: "number", description: "New write capacity units" },
    },
    required: ["tableName", "readCapacity", "writeCapacity"],
  },
};

const DYNAMODB_CREATE_GSI_TOOL: Tool = {
  name: "dynamodb:create_gsi",
  description: "Creates a global secondary index on a table",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      indexName: { type: "string", description: "Name of the new index" },
      partitionKey: { type: "string", description: "Partition key for the index" },
      partitionKeyType: { type: "string", enum: ["S", "N", "B"], description: "Type of partition key" },
      sortKey: { type: "string", description: "Sort key for the index (optional)" },
      sortKeyType: { type: "string", enum: ["S", "N", "B"], description: "Type of sort key (optional)" },
      projectionType: { type: "string", enum: ["ALL", "KEYS_ONLY", "INCLUDE"], description: "Type of projection" },
      nonKeyAttributes: { type: "array", items: { type: "string" }, description: "Non-key attributes to project (optional)" },
      readCapacity: { type: "number", description: "Provisioned read capacity units" },
      writeCapacity: { type: "number", description: "Provisioned write capacity units" },
    },
    required: ["tableName", "indexName", "partitionKey", "partitionKeyType", "projectionType", "readCapacity", "writeCapacity"],
  },
};

const DYNAMODB_UPDATE_GSI_TOOL: Tool = {
  name: "dynamodb:update_gsi",
  description: "Updates the provisioned capacity of a global secondary index",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      indexName: { type: "string", description: "Name of the index to update" },
      readCapacity: { type: "number", description: "New read capacity units" },
      writeCapacity: { type: "number", description: "New write capacity units" },
    },
    required: ["tableName", "indexName", "readCapacity", "writeCapacity"],
  },
};

const DYNAMODB_CREATE_LSI_TOOL: Tool = {
  name: "dynamodb:create_lsi",
  description: "Creates a local secondary index on a table (must be done during table creation)",
  inputSchema: {
    type: "object",
    properties: {
      tableName: { type: "string", description: "Name of the table" },
      indexName: { type: "string", description: "Name of the new index" },
      partitionKey: { type: "string", description: "Partition key for the table" },
      partitionKeyType: { type: "string", enum: ["S", "N", "B"], description: "Type of partition key" },
      sortKey: { type: "string", description: "Sort key for the index" },
      sortKeyType: { type: "string", enum: ["S", "N", "B"], description: "Type of sort key" },
      projectionType: { type: "string", enum: ["ALL", "KEYS_ONLY", "INCLUDE"], description: "Type of projection" },
      nonKeyAttributes: { type: "array", items: { type: "string" }, description: "Non-key attributes to project (optional)" },
      readCapacity: { type: "number", description: "Provisioned read capacity units (optional, default: 5)" },
      writeCapacity: { type: "number", description: "Provisioned write capacity units (optional, default: 5)" },
    },
    required: ["tableName", "indexName", "partitionKey", "partitionKeyType", "sortKey", "sortKeyType", "projectionType"],
  },
};

// Enhanced utility functions
function normalizeAttributeValues(exprAttrVals: any): any {
  if (!exprAttrVals) return undefined;
  
  if (typeof exprAttrVals === "string") {
    try {
      exprAttrVals = JSON.parse(exprAttrVals);
    } catch (err) {
      console.error("Error parsing expressionAttributeValues:", err);
      return undefined;
    }
  }

  const normalized: any = {};
  Object.keys(exprAttrVals).forEach(key => {
    const val = exprAttrVals[key];
    if (val && typeof val === "object" && (val.N || val.S || val.B)) {
      if (val.N !== undefined) normalized[key] = Number(val.N);
      else if (val.S !== undefined) normalized[key] = val.S;
      else if (val.B !== undefined) normalized[key] = val.B;
    } else {
      normalized[key] = val;
    }
  });
  
  return normalized;
}

function cleanExpressionAttributeNames(expressionAttributeNames: any, expressions: string[]): any {
  if (!expressionAttributeNames) return undefined;
  
  const combinedExpression = expressions.filter(e => typeof e === "string").join(" ");
  const cleanedNames: any = {};
  
  Object.keys(expressionAttributeNames).forEach(key => {
    if (key === "#") {
      throw new Error('Invalid ExpressionAttributeNames key: "#" is not allowed. Use descriptive names like "#age", "#name".');
    }
    if (combinedExpression.includes(key)) {
      cleanedNames[key] = expressionAttributeNames[key];
    }
  });
  
  return Object.keys(cleanedNames).length > 0 ? cleanedNames : undefined;
}

async function getTableSchema(tableName: string) {
  try {
    const descCmd = new DescribeTableCommand({ TableName: tableName });
    const descResp = await dynamoClient.send(descCmd);
    return descResp.Table;
  } catch (error) {
    console.error(`Error getting table schema for ${tableName}:`, error);
    return null;
  }
}

function fixItemKeyTypes(item: any, tableSchema: any): any {
  if (!tableSchema?.KeySchema || !tableSchema?.AttributeDefinitions || !item) {
    return item;
  }

  const keyAttrs = tableSchema.KeySchema
    .map((k: any) => k.AttributeName)
    .filter((attr: any): attr is string => typeof attr === "string");
    
  const attrTypes: Record<string, string> = {};
  tableSchema.AttributeDefinitions.forEach((def: any) => {
    if (typeof def.AttributeName === "string" && typeof def.AttributeType === "string") {
      attrTypes[def.AttributeName] = def.AttributeType;
    }
  });

  const fixedItem = { ...item };
  keyAttrs.forEach((attr: string | number) => {
    if (fixedItem[attr] !== undefined) {
      const expectedType = attrTypes[attr];
      if (expectedType === "S" && typeof fixedItem[attr] !== "string") {
        fixedItem[attr] = typeof fixedItem[attr] === "object" 
          ? JSON.stringify(fixedItem[attr])
          : String(fixedItem[attr]);
      }
      if (expectedType === "N" && typeof fixedItem[attr] !== "number") {
        const num = Number(fixedItem[attr]);
        if (!isNaN(num)) fixedItem[attr] = num;
      }
    }
  });

  return fixedItem;
}

// Enhanced implementation functions with better error handling and intelligence
async function createTable(params: any) {
  try {
    // Validate table name
    if (!params.tableName || params.tableName.length < 3 || params.tableName.length > 255) {
      return {
        success: false,
        message: "Table name must be between 3 and 255 characters",
      };
    }

    const command = new CreateTableCommand({
      TableName: params.tableName,
      AttributeDefinitions: [
        { AttributeName: params.partitionKey, AttributeType: params.partitionKeyType },
        ...(params.sortKey ? [{ AttributeName: params.sortKey, AttributeType: params.sortKeyType }] : []),
      ],
      KeySchema: [
        { AttributeName: params.partitionKey, KeyType: "HASH" as const },
        ...(params.sortKey ? [{ AttributeName: params.sortKey, KeyType: "RANGE" as const }] : []),
      ],
      ProvisionedThroughput: {
        ReadCapacityUnits: Math.max(1, params.readCapacity),
        WriteCapacityUnits: Math.max(1, params.writeCapacity),
      },
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `Table ${params.tableName} created successfully. Status: ${response.TableDescription?.TableStatus}`,
      details: response.TableDescription,
    };
  } catch (error: any) {
    console.error("Error creating GSI:", error);
    return {
      success: false,
      message: `Failed to create GSI: ${error.message || error}`,
    };
  }
}

async function updateGSI(params: any) {
  try {
    const command = new UpdateTableCommand({
      TableName: params.tableName,
      GlobalSecondaryIndexUpdates: [
        {
          Update: {
            IndexName: params.indexName,
            ProvisionedThroughput: {
              ReadCapacityUnits: Math.max(1, params.readCapacity),
              WriteCapacityUnits: Math.max(1, params.writeCapacity),
            },
          },
        },
      ],
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `GSI ${params.indexName} capacity updated on table ${params.tableName}`,
      details: response.TableDescription,
    };
  } catch (error: any) {
    console.error("Error updating GSI:", error);
    return {
      success: false,
      message: `Failed to update GSI: ${error.message || error}`,
    };
  }
}

async function createLSI(params: any) {
  try {
    // Note: LSIs must be created during table creation
    const command = new CreateTableCommand({
      TableName: params.tableName,
      AttributeDefinitions: [
        { AttributeName: params.partitionKey, AttributeType: params.partitionKeyType },
        { AttributeName: params.sortKey, AttributeType: params.sortKeyType },
      ],
      KeySchema: [
        { AttributeName: params.partitionKey, KeyType: "HASH" as const },
      ],
      LocalSecondaryIndexes: [
        {
          IndexName: params.indexName,
          KeySchema: [
            { AttributeName: params.partitionKey, KeyType: "HASH" as const },
            { AttributeName: params.sortKey, KeyType: "RANGE" as const },
          ],
          Projection: {
            ProjectionType: params.projectionType,
            ...(params.projectionType === "INCLUDE" ? { NonKeyAttributes: params.nonKeyAttributes } : {}),
          },
        },
      ],
      ProvisionedThroughput: {
        ReadCapacityUnits: Math.max(1, params.readCapacity || 5),
        WriteCapacityUnits: Math.max(1, params.writeCapacity || 5),
      },
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `LSI ${params.indexName} created on table ${params.tableName}`,
      details: response.TableDescription,
    };
  } catch (error: any) {
    console.error("Error creating LSI:", error);
    return {
      success: false,
      message: `Failed to create LSI: ${error.message || error}`,
    };
  }
}

// Enhanced server setup with better organization
const server = new Server(
  {
    name: "dynamodb-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

// Complete list of tools in logical order
const ALL_TOOLS = [
  DYNAMODB_LIST_TABLES_TOOL,
  DYNAMODB_DESCRIBE_TABLE_TOOL,
  DYNAMODB_CREATE_TABLE_TOOL,
  DYNAMODB_UPDATE_CAPACITY_TOOL,
  DYNAMODB_PUT_ITEM_TOOL,
  DYNAMODB_GET_ITEM_TOOL,
  DYNAMODB_UPDATE_ITEM_TOOL,
  DYNAMODB_DELETE_ITEM_TOOL,
  DYNAMODB_QUERY_TABLE_TOOL,
  DYNAMODB_SCAN_TABLE_TOOL,
  DYNAMODB_CREATE_GSI_TOOL,
  DYNAMODB_UPDATE_GSI_TOOL,
  DYNAMODB_CREATE_LSI_TOOL,
];

// Request handlers
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS,
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    let result;
    
    // Enhanced switch with consistent naming and error handling
    switch (name) {
      case "dynamodb:list_tables":
        result = await listTables(args);
        break;
      case "dynamodb:describe_table":
        result = await describeTable(args);
        break;
      case "dynamodb:create_table":
        result = await createTable(args);
        break;
      case "dynamodb:update_capacity":
        result = await updateCapacity(args);
        break;
      case "dynamodb:put_item":
        result = await putItem(args);
        break;
      case "dynamodb:get_item":
        result = await getItem(args);
        break;
      case "dynamodb:update_item":
        result = await updateItem(args);
        break;
      case "dynamodb:delete_item":
        result = await deleteItem(args);
        break;
      case "dynamodb:query_table":
        result = await queryTable(args);
        break;
      case "dynamodb:scan_table":
        result = await scanTable(args);
        break;
      case "dynamodb:create_gsi":
        result = await createGSI(args);
        break;
      case "dynamodb:update_gsi":
        result = await updateGSI(args);
        break;
      case "dynamodb:create_lsi":
        result = await createLSI(args);
        break;
      default:
        return {
          content: [{ 
            type: "text", 
            text: JSON.stringify({
              success: false,
              message: `Unknown tool: ${name}`,
              availableTools: ALL_TOOLS.map(t => t.name)
            }, null, 2)
          }],
          isError: true,
        };
    }

    // Enhanced response formatting with consistent structure
    const responseText = JSON.stringify(result, null, 2);
    
    return {
      content: [{ type: "text", text: responseText }],
      isError: !result?.success,
    };
    
  } catch (error: any) {
    console.error(`Error executing tool ${name}:`, error);
    
    const errorResponse = {
      success: false,
      message: `Unexpected error occurred while executing ${name}: ${error.message || error}`,
      errorType: error.name || "UnknownError",
      tool: name,
      arguments: args,
    };
    
    return {
      content: [{ type: "text", text: JSON.stringify(errorResponse, null, 2) }],
      isError: true,
    };
  }
});

// Enhanced server startup with better error handling
async function runServer() {
  try {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    
    // Log startup info to stderr so it doesn't interfere with MCP communication
    console.error("=".repeat(50));
    console.error("DynamoDB MCP Server v1.0.0");
    console.error("=".repeat(50));
    console.error("Server running on stdio transport");
    console.error(`AWS Region: ${process.env.AWS_REGION || 'not set'}`);
    console.error(`Available tools: ${ALL_TOOLS.length}`);
    console.error("Tools:", ALL_TOOLS.map(t => `  - ${t.name}`).join('\n'));
    console.error("=".repeat(50));
    
  } catch (error) {
    console.error("Fatal error starting server:", error);
    process.exit(1);
  }
}

// Enhanced error handling and graceful shutdown
process.on('SIGINT', () => {
  console.error("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});

// Start the server
runServer().catch((error) => {
  console.error("Fatal error running server:", error);
  process.exit(1);
});

async function listTables(params: any = {}) {
  try {
    const command = new ListTablesCommand({
      Limit: params.limit,
      ExclusiveStartTableName: params.exclusiveStartTableName,
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: "Tables listed successfully",
      tables: response.TableNames || [],
      lastEvaluatedTable: response.LastEvaluatedTableName,
      tableCount: response.TableNames?.length || 0,
    };
  } catch (error: any) {
    console.error("Error listing tables:", error);
    return {
      success: false,
      message: `Failed to list tables: ${error.message || error}`,
    };
  }
}

async function describeTable(params: any) {
  try {
    const command = new DescribeTableCommand({
      TableName: params.tableName,
    });
    
    const response = await dynamoClient.send(command);
    const table = response.Table;
    
    return {
      success: true,
      message: `Table ${params.tableName} described successfully`,
      table: table,
      summary: {
        tableName: table?.TableName,
        status: table?.TableStatus,
        itemCount: table?.ItemCount,
        tableSize: table?.TableSizeBytes,
        partitionKey: table?.KeySchema?.find(k => k.KeyType === "HASH")?.AttributeName,
        sortKey: table?.KeySchema?.find(k => k.KeyType === "RANGE")?.AttributeName,
        gsiCount: table?.GlobalSecondaryIndexes?.length || 0,
        lsiCount: table?.LocalSecondaryIndexes?.length || 0,
      }
    };
  } catch (error: any) {
    console.error("Error describing table:", error);
    return {
      success: false,
      message: `Failed to describe table: ${error.message || error}`,
    };
  }
}

async function putItem(params: any) {
  try {
    const tableSchema = await getTableSchema(params.tableName);
    const fixedItem = fixItemKeyTypes(params.item, tableSchema);

    const command = new PutItemCommand({
      TableName: params.tableName,
      Item: marshall(fixedItem),
    });
    
    await dynamoClient.send(command);
    return {
      success: true,
      message: `Item added successfully to table ${params.tableName}`,
      item: fixedItem,
    };
  } catch (error: any) {
    console.error("Error putting item:", error);
    return {
      success: false,
      message: `Failed to put item: ${error.message || error}`,
      errorType: error.name,
    };
  }
}

async function getItem(params: any) {
  try {
    const tableSchema = await getTableSchema(params.tableName);
    const fixedKey = fixItemKeyTypes(params.key, tableSchema);

    const command = new GetItemCommand({
      TableName: params.tableName,
      Key: marshall(fixedKey),
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: response.Item 
        ? `Item retrieved successfully from table ${params.tableName}`
        : `No item found with the specified key in table ${params.tableName}`,
      item: response.Item ? unmarshall(response.Item) : null,
      found: !!response.Item,
    };
  } catch (error: any) {
    console.error("Error getting item:", error);
    return {
      success: false,
      message: `Failed to get item: ${error.message || error}`,
    };
  }
}

async function updateItem(params: any) {
  try {
    const tableSchema = await getTableSchema(params.tableName);
    const fixedKey = fixItemKeyTypes(params.key, tableSchema);
    const normalizedValues = normalizeAttributeValues(params.expressionAttributeValues);

    const command = new UpdateItemCommand({
      TableName: params.tableName,
      Key: marshall(fixedKey),
      UpdateExpression: params.updateExpression,
      ExpressionAttributeNames: params.expressionAttributeNames,
      ExpressionAttributeValues: normalizedValues ? marshall(normalizedValues) : undefined,
      ConditionExpression: params.conditionExpression,
      ReturnValues: params.returnValues || "NONE",
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `Item updated successfully in table ${params.tableName}`,
      attributes: response.Attributes ? unmarshall(response.Attributes) : null,
    };
  } catch (error: any) {
    console.error("Error updating item:", error);
    return {
      success: false,
      message: `Failed to update item: ${error.message || error}`,
      errorType: error.name,
    };
  }
}

async function deleteItem(params: any) {
  try {
    const tableSchema = await getTableSchema(params.tableName);
    const fixedKey = fixItemKeyTypes(params.key, tableSchema);
    const normalizedValues = normalizeAttributeValues(params.expressionAttributeValues);

    const command = new DeleteItemCommand({
      TableName: params.tableName,
      Key: marshall(fixedKey),
      ConditionExpression: params.conditionExpression,
      ExpressionAttributeNames: params.expressionAttributeNames,
      ExpressionAttributeValues: normalizedValues ? marshall(normalizedValues) : undefined,
      ReturnValues: params.returnValues || "NONE",
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `Item deleted successfully from table ${params.tableName}`,
      attributes: response.Attributes ? unmarshall(response.Attributes) : null,
    };
  } catch (error: any) {
    console.error("Error deleting item:", error);
    return {
      success: false,
      message: `Failed to delete item: ${error.message || error}`,
      errorType: error.name,
    };
  }
}

async function queryTable(params: any) {
  try {
    const normalizedValues = normalizeAttributeValues(params.expressionAttributeValues);
    const cleanedNames = cleanExpressionAttributeNames(
      params.expressionAttributeNames,
      [params.keyConditionExpression, params.filterExpression].filter(Boolean)
    );

    const command = new QueryCommand({
      TableName: params.tableName,
      IndexName: params.indexName,
      KeyConditionExpression: params.keyConditionExpression,
      ExpressionAttributeValues: normalizedValues ? marshall(normalizedValues) : undefined,
      ExpressionAttributeNames: cleanedNames,
      FilterExpression: params.filterExpression,
      Limit: params.limit,
      ScanIndexForward: params.scanIndexForward,
    });
    
    const response = await dynamoClient.send(command);
    const items = response.Items ? response.Items.map(item => unmarshall(item)) : [];
    
    return {
      success: true,
      message: `Query executed successfully on table ${params.tableName}${params.indexName ? ` (index: ${params.indexName})` : ''}`,
      items: items,
      count: response.Count,
      scannedCount: response.ScannedCount,
      lastEvaluatedKey: response.LastEvaluatedKey ? unmarshall(response.LastEvaluatedKey) : null,
      consumedCapacity: response.ConsumedCapacity,
    };
  } catch (error: any) {
    // Enhanced fallback logic - try scan if query fails due to missing key conditions
    if (
      error?.name === 'ValidationException' &&
      typeof error.message === 'string' &&
      (
        error.message.includes('Query condition missed key schema element') ||
        error.message.includes('Invalid KeyConditionExpression') ||
        error.message.includes('Syntax error')
      )
    ) {
      console.warn(`Query failed, falling back to scan: ${error.message}`);
      try {
        const scanParams: any = {
          tableName: params.tableName,
          indexName: params.indexName,
          filterExpression: params.keyConditionExpression,
          expressionAttributeNames: params.expressionAttributeNames,
          expressionAttributeValues: params.expressionAttributeValues,
          limit: params.limit,
        };
        const scanResult = await scanTable(scanParams);
        scanResult.message = `Query converted to scan: ${scanResult.message}`;
        return scanResult;
      } catch (scanError) {
        console.error("Scan fallback also failed:", scanError);
        return {
          success: false,
          message: `Query failed and scan fallback also failed: ${scanError}`,
          items: [],
        };
      }
    }
    
    console.error("Error querying table:", error);
    return {
      success: false,
      message: `Failed to query table: ${error.message || error}`,
      items: [],
      errorType: error.name,
    };
  }
}

async function scanTable(params: any) {
  try {
    const normalizedValues = normalizeAttributeValues(params.expressionAttributeValues);
    const cleanedNames = cleanExpressionAttributeNames(
      params.expressionAttributeNames,
      [params.filterExpression].filter(Boolean)
    );

    const command = new ScanCommand({
      TableName: params.tableName,
      IndexName: params.indexName,
      FilterExpression: params.filterExpression,
      ExpressionAttributeValues: normalizedValues ? marshall(normalizedValues) : undefined,
      ExpressionAttributeNames: cleanedNames,
      Limit: params.limit,
    });
    
    const response = await dynamoClient.send(command);
    const items = response.Items ? response.Items.map(item => unmarshall(item)) : [];
    
    return {
      success: true,
      message: `Scan executed successfully on table ${params.tableName}${params.indexName ? ` (index: ${params.indexName})` : ''}`,
      items: items,
      count: response.Count,
      scannedCount: response.ScannedCount,
      lastEvaluatedKey: response.LastEvaluatedKey ? unmarshall(response.LastEvaluatedKey) : null,
      consumedCapacity: response.ConsumedCapacity,
    };
  } catch (error: any) {
    console.error("Error scanning table:", error);
    return {
      success: false,
      message: `Failed to scan table: ${error.message || error}`,
      items: [],
      errorType: error.name,
    };
  }
}

async function updateCapacity(params: any) {
  try {
    const command = new UpdateTableCommand({
      TableName: params.tableName,
      ProvisionedThroughput: {
        ReadCapacityUnits: Math.max(1, params.readCapacity),
        WriteCapacityUnits: Math.max(1, params.writeCapacity),
      },
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `Capacity updated successfully for table ${params.tableName}`,
      details: response.TableDescription,
    };
  } catch (error: any) {
    console.error("Error updating capacity:", error);
    return {
      success: false,
      message: `Failed to update capacity: ${error.message || error}`,
    };
  }
}

async function createGSI(params: any) {
  try {
    const command = new UpdateTableCommand({
      TableName: params.tableName,
      AttributeDefinitions: [
        { AttributeName: params.partitionKey, AttributeType: params.partitionKeyType },
        ...(params.sortKey ? [{ AttributeName: params.sortKey, AttributeType: params.sortKeyType }] : []),
      ],
      GlobalSecondaryIndexUpdates: [
        {
          Create: {
            IndexName: params.indexName,
            KeySchema: [
              { AttributeName: params.partitionKey, KeyType: "HASH" as const },
              ...(params.sortKey ? [{ AttributeName: params.sortKey, KeyType: "RANGE" as const }] : []),
            ],
            Projection: {
              ProjectionType: params.projectionType,
              ...(params.projectionType === "INCLUDE" ? { NonKeyAttributes: params.nonKeyAttributes } : {}),
            },
            ProvisionedThroughput: {
              ReadCapacityUnits: Math.max(1, params.readCapacity),
              WriteCapacityUnits: Math.max(1, params.writeCapacity),
            },
          },
        },
      ],
    });
    
    const response = await dynamoClient.send(command);
    return {
      success: true,
      message: `GSI ${params.indexName} creation initiated on table ${params.tableName}`,
      details: response.TableDescription,
    };
  } catch (error: any) {
    console.error("Error creating GSI:", error);
    return {
      success: false,
      message: `Failed to create GSI: ${error.message || error}`,
    };
  }
}