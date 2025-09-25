import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import readline from "readline/promises";
import dotenv from "dotenv";
import express from "express";
import bodyParser from "body-parser";
// Load environment variables with explicit path
const envResult = dotenv.config({ path: '.env' });
console.log('dotenv config result:', envResult);
// Check for AWS region with better debugging
const AWS_REGION = process.env.AWS_REGION;
console.log('All environment variables:', {
    AWS_REGION: process.env.AWS_REGION,
    NODE_ENV: process.env.NODE_ENV,
    PORT: process.env.PORT
});
if (!AWS_REGION) {
    console.error("Environment variables check failed:");
    console.error("AWS_REGION:", process.env.AWS_REGION);
    console.error("All env keys:", Object.keys(process.env).filter(key => key.startsWith('AWS')));
    throw new Error("AWS_REGION is not set in environment variables");
}
console.log(`Using AWS Region: ${AWS_REGION}`);
class EnhancedMCPClient {
    mcp;
    bedrockClient;
    transport = null;
    tools = [];
    modelId = "anthropic.claude-3-sonnet-20240229-v1:0";
    inferenceProfileId = null;
    conversationHistory = [];
    sanitizedToOriginalToolName = {};
    constructor(inferenceProfileId) {
        this.bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });
        this.mcp = new Client({ name: "enhanced-mcp-client", version: "1.0.0" });
        this.inferenceProfileId = inferenceProfileId || null;
    }
    async connectToServer(serverScriptPath) {
        try {
            const isJs = serverScriptPath.endsWith(".js");
            const isPy = serverScriptPath.endsWith(".py");
            if (!isJs && !isPy) {
                throw new Error("Server script must be a .js or .py file");
            }
            const command = isPy
                ? process.platform === "win32" ? "python" : "python3"
                : process.execPath;
            this.transport = new StdioClientTransport({
                command,
                args: [serverScriptPath],
            });
            await this.mcp.connect(this.transport);
            const toolsResult = await this.mcp.listTools();
            this.tools = toolsResult.tools.map((tool) => ({
                name: tool.name,
                description: tool.description || "",
                input_schema: tool.inputSchema,
            }));
            // Build mapping from sanitized to original tool names
            this.sanitizedToOriginalToolName = {};
            for (const tool of this.tools) {
                this.sanitizedToOriginalToolName[this.sanitizeToolName(tool.name)] = tool.name;
            }
            console.log("\n🔗 Connected to DynamoDB MCP Server");
            console.log(`📊 Available tools: ${this.tools.length}`);
            console.log("🛠️  Tools:", this.tools.map(({ name }) => `\n   - ${name}`).join(''));
            console.log("");
        }
        catch (e) {
            console.error("❌ Failed to connect to MCP server:", e);
            throw e;
        }
    }
    // Enhanced query optimization - smarter tool selection
    optimizeQuery(toolName, toolArgs) {
        // If querying without a proper partition key condition, prefer scan
        if (toolName === "dynamodb:query_table") {
            const keyCondition = toolArgs.keyConditionExpression || "";
            // Check if the key condition seems to be missing partition key
            // This is a heuristic - in practice, you'd want more sophisticated parsing
            if (keyCondition.includes("Age") && !keyCondition.includes("Name") && !keyCondition.includes("#name")) {
                console.log("🔄 Optimizing: Converting query to scan (missing partition key condition)");
                return {
                    name: "dynamodb:scan_table",
                    args: {
                        tableName: toolArgs.tableName,
                        filterExpression: toolArgs.keyConditionExpression,
                        expressionAttributeNames: toolArgs.expressionAttributeNames,
                        expressionAttributeValues: toolArgs.expressionAttributeValues,
                        limit: toolArgs.limit,
                    }
                };
            }
        }
        return { name: toolName, args: toolArgs };
    }
    // Utility to sanitize tool names for Bedrock
    sanitizeToolName(name) {
        return name.replace(/[^a-zA-Z0-9_-]/g, '_');
    }
    async processQuery(query, stateless = false) {
        const userMessage = {
            role: "user",
            content: [{ type: "text", text: query }]
        };
        // For stateless requests, do NOT use or push to conversationHistory
        const messages = stateless ? [userMessage] : (() => {
            this.conversationHistory.push(userMessage);
            return [...this.conversationHistory];
        })();
        // Prepare tools for Bedrock format
        const toolsForBedrock = this.tools.length > 0 ? {
            tools: this.tools.map(tool => ({
                name: this.sanitizeToolName(tool.name),
                description: tool.description || "",
                input_schema: tool.input_schema
            }))
        } : {};
        // Create the request payload with conversation history
        const payload = {
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 2000,
            top_k: 250,
            stop_sequences: [],
            temperature: 0.1,
            top_p: 0.999,
            messages,
            ...toolsForBedrock
        };
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
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            // For stateless requests, handle tool calls with a follow-up request
            if (stateless) {
                let finalText = [];
                let toolUseContent = null;
                let toolResultContent = null;
                let toolUseId;
                for (const content of responseBody.content) {
                    if (content.type === "text") {
                        finalText.push(content.text);
                    }
                    else if (content.type === "tool_use") {
                        toolUseContent = content;
                        toolUseId = content.id;
                        // Execute the tool
                        const optimized = this.optimizeQuery(content.name, content.input);
                        const sanitizedToolName = this.sanitizeToolName(optimized.name);
                        const mcpToolName = this.sanitizedToOriginalToolName[sanitizedToolName] || optimized.name;
                        let result;
                        try {
                            result = await this.mcp.callTool({
                                name: mcpToolName,
                                arguments: optimized.args,
                            });
                        }
                        catch (err) {
                            return `❌ Tool ${sanitizedToolName} failed: ${err}`;
                        }
                        // Parse tool result
                        let parsedResult = null;
                        let resultText = "";
                        try {
                            if (typeof result.content === "string") {
                                parsedResult = JSON.parse(result.content);
                            }
                            else if (Array.isArray(result.content) && result.content.length > 0 && typeof result.content[0]?.text === "string") {
                                parsedResult = JSON.parse(result.content[0].text);
                            }
                        }
                        catch (parseError) { }
                        if (parsedResult) {
                            resultText = JSON.stringify(parsedResult, null, 2);
                        }
                        toolResultContent = {
                            type: "tool_result",
                            tool_use_id: toolUseId,
                            content: resultText
                        };
                        // Now, send a follow-up request with the correct alternation:
                        const followUpMessages = [
                            userMessage,
                            { role: "assistant", content: [toolUseContent] },
                            { role: "user", content: [toolResultContent] }
                        ];
                        const followUpPayload = {
                            anthropic_version: "bedrock-2023-05-31",
                            max_tokens: 1000,
                            top_k: 250,
                            stop_sequences: [],
                            temperature: 0.1,
                            top_p: 0.999,
                            messages: followUpMessages,
                            tools: this.tools.map(tool => ({
                                name: this.sanitizeToolName(tool.name),
                                description: tool.description || "",
                                input_schema: tool.input_schema
                            }))
                        };
                        const followUpCommandParams = {
                            modelId: this.modelId,
                            contentType: "application/json",
                            accept: "application/json",
                            body: JSON.stringify(followUpPayload)
                        };
                        if (this.inferenceProfileId) {
                            followUpCommandParams.inferenceProfileArn = this.inferenceProfileId;
                        }
                        const followUpCommand = new InvokeModelCommand(followUpCommandParams);
                        const followUpResponse = await this.bedrockClient.send(followUpCommand);
                        const followUpBody = JSON.parse(new TextDecoder().decode(followUpResponse.body));
                        // Return only the assistant's final text
                        for (const followContent of followUpBody.content) {
                            if (followContent.type === "text") {
                                finalText.push(followContent.text);
                            }
                        }
                    }
                }
                return finalText.join("\n");
            }
            // ...existing code for non-stateless (chat) usage
            const finalText = [];
            const assistantContent = [];
            for (const content of responseBody.content) {
                if (content.type === "text") {
                    finalText.push(content.text);
                    assistantContent.push(content);
                }
                else if (content.type === "tool_use") {
                    // Optimize the tool call
                    const optimized = this.optimizeQuery(content.name, content.input);
                    const sanitizedToolName = this.sanitizeToolName(optimized.name);
                    // Map sanitized name back to original for MCP call
                    const mcpToolName = this.sanitizedToOriginalToolName[sanitizedToolName] || optimized.name;
                    console.log(`\n🔧 Executing: ${optimized.name}`);
                    console.log(`📝 Args: ${JSON.stringify(optimized.args, null, 2)}`);
                    // Execute the tool
                    let result;
                    try {
                        result = await this.mcp.callTool({
                            name: mcpToolName,
                            arguments: optimized.args,
                        });
                    }
                    catch (err) {
                        const errorMsg = `❌ Tool ${sanitizedToolName} failed: ${err}`;
                        console.error(errorMsg);
                        finalText.push(errorMsg);
                        continue;
                    }
                    // Add tool use to assistant content (sanitize name)
                    assistantContent.push({
                        type: "tool_use",
                        id: content.id,
                        name: sanitizedToolName,
                        input: optimized.args
                    });
                    // Parse and display results
                    let parsedResult = null;
                    let resultText = "";
                    try {
                        if (typeof result.content === "string") {
                            parsedResult = JSON.parse(result.content);
                        }
                        else if (Array.isArray(result.content) && result.content.length > 0 && typeof result.content[0]?.text === "string") {
                            parsedResult = JSON.parse(result.content[0].text);
                        }
                    }
                    catch (parseError) {
                        console.error("Error parsing tool result:", parseError);
                    }
                    if (parsedResult) {
                        resultText = JSON.stringify(parsedResult, null, 2);
                        // Display results in a user-friendly way (console)
                        if (parsedResult.success) {
                            console.log(`✅ ${parsedResult.message}`);
                            if (parsedResult.items && Array.isArray(parsedResult.items)) {
                                console.log(`📊 Found ${parsedResult.items.length} items:`);
                                if (parsedResult.items.length > 0) {
                                    console.log(JSON.stringify(parsedResult.items, null, 2));
                                }
                            }
                            if (parsedResult.item) {
                                console.log("📄 Item:", JSON.stringify(parsedResult.item, null, 2));
                            }
                            if (parsedResult.tables) {
                                console.log(`📋 Tables (${parsedResult.tableCount}):`, parsedResult.tables);
                            }
                        }
                        else {
                            console.log(`❌ ${parsedResult.message}`);
                            if (parsedResult.errorType) {
                                console.log(`🔍 Error Type: ${parsedResult.errorType}`);
                            }
                        }
                        // Always add resultText to finalText for endpoint response
                        finalText.push(resultText);
                    }
                }
            }
            // For stateless requests, do not update conversationHistory
            return finalText.join("\n");
        }
        catch (error) {
            console.error("❌ Error invoking Bedrock model:", error);
            return `Error: ${error.message || error}`;
        }
    }
    async chatLoop() {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });
        try {
            console.log("\n" + "=".repeat(60));
            console.log("🚀 Enhanced DynamoDB MCP Client with Bedrock");
            console.log("=".repeat(60));
            console.log("Commands:");
            console.log("  📝 Type your queries about DynamoDB");
            console.log("  🛠️  'tools' - list available tools");
            console.log("  🧹 'clear' - clear conversation history");
            console.log("  ❌ 'quit' - exit the application");
            console.log("=".repeat(60));
            while (true) {
                const message = await rl.question("\n💬 Query: ");
                if (message.toLowerCase() === "quit") {
                    console.log("👋 Goodbye!");
                    break;
                }
                if (message.toLowerCase() === "clear") {
                    this.conversationHistory = [];
                    console.log("🧹 Conversation history cleared!");
                    continue;
                }
                if (message.toLowerCase() === "tools") {
                    console.log("\n🛠️  Available tools:");
                    this.tools.forEach(tool => {
                        console.log(`   📌 ${tool.name}`);
                        console.log(`      ${tool.description}`);
                    });
                    continue;
                }
                if (message.trim() === "") {
                    continue;
                }
                console.log("\n" + "-".repeat(50));
                const response = await this.processQuery(message);
                console.log("\n🤖 Assistant:", response);
                console.log("-".repeat(50));
            }
        }
        finally {
            rl.close();
        }
    }
    async cleanup() {
        try {
            await this.mcp.close();
            console.log("🧹 MCP connection closed successfully");
        }
        catch (error) {
            console.error("❌ Error closing MCP connection:", error);
        }
    }
    // Add this method
    resetConversationHistory() {
        this.conversationHistory = [];
    }
}
let mcpClientInstance = null;
export async function initMCPClient(serverScriptPath, inferenceProfileId) {
    if (!mcpClientInstance) {
        mcpClientInstance = new EnhancedMCPClient(inferenceProfileId);
        await mcpClientInstance.connectToServer(serverScriptPath);
    }
    return mcpClientInstance;
}
export async function mcpProcessQuery(query, stateless = false) {
    if (!mcpClientInstance) {
        throw new Error("MCP client not initialized. Call initMCPClient first.");
    }
    return await mcpClientInstance.processQuery(query, stateless);
}
async function startEndpoint(serverScriptPath, inferenceProfileId) {
    const mcpClient = new EnhancedMCPClient(inferenceProfileId);
    await mcpClient.connectToServer(serverScriptPath);
    const app = express();
    app.use(bodyParser.json());
    app.post("/query", async (req, res) => {
        // Reset conversation history for every request to ensure statelessness
        mcpClient.resetConversationHistory();
        const { query } = req.body;
        if (!query || typeof query !== "string") {
            return res.status(400).json({ error: "Missing or invalid 'query' field in request body." });
        }
        try {
            const response = await mcpClient.processQuery(query);
            res.json({ result: response });
        }
        catch (err) {
            res.status(500).json({ error: err.message || err });
        }
    });
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    app.listen(port, () => {
        console.log(`🚀 MCP HTTP endpoint listening on port ${port}`);
    });
}
async function main() {
    if (process.argv.length < 3) {
        console.log("Usage:");
        console.log("  node index.js <path_to_server_script> [inference_profile_id]");
        console.log("  node index.js <path_to_server_script> [inference_profile_id] endpoint");
        return;
    }
    const serverScriptPath = process.argv[2];
    const inferenceProfileId = process.argv[3] || "us.anthropic.claude-opus-4-1-20250805-v1:0";
    const mode = process.argv[4];
    if (mode === "endpoint") {
        await startEndpoint(serverScriptPath, inferenceProfileId);
        return;
    }
    const mcpClient = new EnhancedMCPClient(inferenceProfileId);
    console.log("🚀 Starting Enhanced DynamoDB MCP Client...");
    if (inferenceProfileId) {
        console.log(`🧠 Using inference profile: ${inferenceProfileId}`);
    }
    else {
        console.log("🧠 Using direct model ID (no inference profile)");
    }
    try {
        await mcpClient.connectToServer(serverScriptPath);
        await mcpClient.chatLoop();
    }
    catch (error) {
        console.error("❌ Fatal error:", error);
    }
    finally {
        await mcpClient.cleanup();
        process.exit(0);
    }
}
// Enhanced error handling
process.on('SIGINT', async () => {
    console.log('\n🛑 Received SIGINT, shutting down gracefully...');
    process.exit(0);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled Rejection:', reason);
});
main().catch(error => {
    console.error("❌ Fatal error in main:", error);
    process.exit(1);
});
