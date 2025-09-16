import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
dotenv.config();
// Check for AWS region
const AWS_REGION = process.env.AWS_REGION;
if (!AWS_REGION) {
    throw new Error("AWS_REGION is not set in .env file");
}
class MCPClient {
    mcp;
    bedrockClient;
    transport = null;
    tools = [];
    modelId = "anthropic.claude-3-sonnet-20240229-v1:0"; // Updated model ID
    inferenceProfileId = null;
    constructor(inferenceProfileId) {
        this.bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
        this.mcp = new Client({ name: "mcp-client-bedrock", version: "1.0.0" });
    }
    async connectToServer(serverScriptPath) {
        try {
            const isJs = serverScriptPath.endsWith(".js");
            const isPy = serverScriptPath.endsWith(".py");
            if (!isJs && !isPy) {
                throw new Error("Server script must be a .js or .py file");
            }
            const command = isPy
                ? process.platform === "win32"
                    ? "python"
                    : "python3"
                : process.execPath;
            this.transport = new StdioClientTransport({
                command,
                args: [serverScriptPath],
            });
            this.mcp.connect(this.transport);
            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map((tool) => {
                return {
                    name: tool.name,
                    description: tool.description || "",
                    input_schema: tool.inputSchema,
                };
            });
            console.log("Connected to server with tools:", this.tools.map(({ name }) => name));
        }
        catch (e) {
            console.log("Failed to connect to MCP server: ", e);
            throw e;
        }
    }
    async processQuery(query) {
        // Create the initial message
        const messages = [
            {
                role: "user",
                content: [
                    {
                        type: "text",
                        text: query
                    }
                ]
            }
        ];
        // Prepare tools for Bedrock format if available
        const toolsForBedrock = this.tools.length > 0 ? {
            tools: this.tools.map(tool => ({
                name: tool.name,
                description: tool.description || "", // Ensure description is never undefined
                input_schema: tool.input_schema
            }))
        } : {};
        // Create the request payload
        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 1000,
            top_k: 250,
            stop_sequences: [],
            temperature: 0.7,
            top_p: 0.999,
            messages: messages,
            ...toolsForBedrock
        };
        // Invoke the Bedrock model
        const commandParams = {
            modelId: this.modelId,
            contentType: "application/json",
            accept: "application/json",
            body: JSON.stringify(payload)
        };
        if (this.inferenceProfileId) {
            commandParams.inferenceProfileArn = this.inferenceProfileId;
        }
        const command = new InvokeModelCommand(commandParams);
        try {
            const response = await this.bedrockClient.send(command);
            // Parse the response
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const finalText = [];
            const toolResults = [];
            // Process the response content
            for (const content of responseBody.content) {
                if (content.type === "text") {
                    finalText.push(content.text);
                }
                else if (content.type === "tool_use") {
                    const toolName = content.name;
                    const toolArgs = content.input;
                    // Detect partition key for the table (default: "id")
                    const partitionKey = "id"; // Change this if your table uses a different partition key
                    // Check if partition key is present in keyConditionExpression
                    const missingPartitionKey = !toolArgs.keyConditionExpression ||
                        !toolArgs.expressionAttributeValues ||
                        Object.keys(toolArgs.expressionAttributeValues).length === 0 ||
                        !new RegExp(`\\b${partitionKey}\\b|#${partitionKey}\\b`).test(toolArgs.keyConditionExpression);
                    const isInvalidKeyCondition = missingPartitionKey ||
                        /[<>!=]/.test(toolArgs.keyConditionExpression);
                    let result;
                    if (toolName === "query_table" && isInvalidKeyCondition) {
                        // Fallback to scan_table if partition key is missing or invalid
                        const scanArgs = {
                            tableName: toolArgs.tableName,
                            filterExpression: toolArgs.filterExpression || toolArgs.keyConditionExpression,
                            expressionAttributeNames: toolArgs.expressionAttributeNames,
                            expressionAttributeValues: toolArgs.expressionAttributeValues,
                            limit: toolArgs.limit,
                        };
                        result = await this.mcp.callTool({
                            name: "scan_table",
                            arguments: scanArgs,
                        });
                        toolResults.push(result);
                        finalText.push(`[Calling tool scan_table with args ${JSON.stringify(scanArgs)}]`);
                    }
                    else {
                        result = await this.mcp.callTool({
                            name: toolName,
                            arguments: toolArgs,
                        });
                        toolResults.push(result);
                        finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);
                    }
                    // --- Print actual items to terminal if present ---
                    try {
                        let parsed = null;
                        if (typeof result.content === "string") {
                            parsed = JSON.parse(result.content);
                        }
                        else if (Array.isArray(result.content) && result.content.length > 0 && typeof result.content[0]?.text === "string") {
                            parsed = JSON.parse(result.content[0].text);
                        }
                        if (parsed && parsed.items && Array.isArray(parsed.items)) {
                            console.log("\n--- Actual items from tool ---");
                            console.log(JSON.stringify(parsed.items, null, 2));
                            console.log("--- End items ---\n");
                        }
                    }
                    catch { }
                    // -------------------------------------------------
                    toolResults.push(result);
                    finalText.push(`[Calling tool ${toolName} with args ${JSON.stringify(toolArgs)}]`);
                    // Add the tool result to messages for follow-up
                    messages.push({
                        role: "assistant",
                        content: [
                            {
                                type: "tool_use",
                                id: content.id,
                                name: toolName,
                                input: toolArgs
                            }
                        ]
                    });
                    // Add the tool result as a tool_result type
                    const toolResultContent = typeof result.content === 'string' ? result.content : JSON.stringify(result.content);
                    // --- FIX: Add the actual items to the user message for follow-up ---
                    let itemsText = "";
                    try {
                        let parsed = null;
                        if (typeof result.content === "string") {
                            parsed = JSON.parse(result.content);
                        }
                        else if (Array.isArray(result.content) && result.content.length > 0 && typeof result.content[0]?.text === "string") {
                            parsed = JSON.parse(result.content[0].text);
                        }
                        if (parsed && parsed.items) {
                            itemsText = "\nActual items:\n" + JSON.stringify(parsed.items, null, 2);
                        }
                    }
                    catch { }
                    // ---------------------------------------------------------------
                    messages.push({
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                tool_use_id: content.id,
                                content: toolResultContent + itemsText // <-- append actual items
                            }
                        ]
                    });
                    // Create a follow-up request with the tool result
                    const followUpPayload = {
                        anthropic_version: "bedrock-2023-05-31",
                        max_tokens: 1000,
                        top_k: 250,
                        stop_sequences: [],
                        temperature: 0.7,
                        top_p: 0.999,
                        messages: messages,
                        tools: this.tools.length > 0 ? toolsForBedrock.tools : undefined
                    };
                    const followUpCommandParams = {
                        modelId: this.modelId,
                        contentType: "application/json",
                        accept: "application/json",
                        body: JSON.stringify(followUpPayload)
                    };
                    const followUpCommand = new InvokeModelCommand(followUpCommandParams);
                    const followUpResponse = await this.bedrockClient.send(followUpCommand);
                    const followUpBody = JSON.parse(new TextDecoder().decode(followUpResponse.body));
                    if (followUpBody.content && followUpBody.content[0] && followUpBody.content[0].type === "text") {
                        finalText.push(followUpBody.content[0].text);
                    }
                }
            }
            return finalText.join("\n");
        }
        catch (error) {
            console.error("Error invoking Bedrock model:", error);
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        try {
            console.log("\nMCP Client with Bedrock Started with Bedrock!");
            console.log("Type your queries, 'tools' to list tools, or 'quit' to exit.");
            while (true) {
                const message = await rl.question("\nQuery: ");
                if (message.toLowerCase() === "quit") {
                    break;
                }
                if (message.toLowerCase() === "tools") {
                    continue;
                }
                const response = await this.processQuery(message);
                console.log("\n" + response);
            }
        }
        finally {
            rl.close();
        }
    }
    async cleanup() {
        await this.mcp.close();
    }
}
async function main() {
    if (process.argv.length < 3) {
        console.log("Usage: node index.ts <path_to_server_script> [inference_profile_id]");
        return;
    }
    // Get the inference profile ID from command line arguments if provided
    const inferenceProfileId = "us.anthropic.claude-opus-4-1-20250805-v1:0";
    const mcpClient = new MCPClient(inferenceProfileId || undefined);
    if (inferenceProfileId) {
        console.log(`Using inference profile ID: ${inferenceProfileId}`);
    }
    else {
        console.log("No inference profile ID provided. Using model ID directly.");
    }
    try {
        await mcpClient.connectToServer(process.argv[2]);
        await mcpClient.chatLoop();
    }
    finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}
main();
