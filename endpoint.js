const express = require('express');
const bodyParser = require('body-parser');
const path = require('path');

const app = express();
app.use(bodyParser.json());

let mcpReady = false;
let mcpModule = null;

// Initialize MCP client once at startup
(async () => {
    try {
        mcpModule = await import('./mcp-client-bedrock/build/index.js');
        
        const serverScriptPath = path.resolve(__dirname, './mcp-dynamo/dist/index.js');
        const inferenceProfileId = process.env.INFERENCE_PROFILE_ID;
        await mcpModule.initMCPClient(serverScriptPath, inferenceProfileId);
        mcpReady = true;
        console.log("MCP client initialized.");
    } catch (err) {
        console.error("Failed to initialize MCP client:", err);
    }
})();
/*
app.post('/query', async (req, res) => {
    if (!mcpReady || !mcpModule) {
        return res.status(503).json({ error: 'MCP client not ready.' });
    }
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }
    try {
        // Capture both the result and any execution details
        const result = await mcpModule.mcpProcessQuery(query, true); // stateless mode
        
        // If the MCP client returns structured data, pass it through
        // Otherwise, wrap the text result
        if (typeof result === 'object' && result.executionLogs) {
            res.json(result);
        } else {
            res.json({ 
                result,
                // You might want to add metadata here
                timestamp: new Date().toISOString()
            });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
*/
// change from normal query (will change name later) to output only important info
app.post('/query-debug', async (req, res) => {
    if (!mcpReady || !mcpModule) {
        return res.status(503).json({ error: 'MCP client not ready.' });
    }
    const { query } = req.body;
    if (!query) {
        return res.status(400).json({ error: 'Query is required.' });
    }
    
    try {
        // Capture console output
        const logs = [];
        const originalLog = console.log;
        const originalError = console.error;
        
        console.log = (...args) => {
            logs.push({ type: 'log', message: args.join(' '), timestamp: new Date().toISOString() });
            originalLog.apply(console, args);
        };
        
        console.error = (...args) => {
            logs.push({ type: 'error', message: args.join(' '), timestamp: new Date().toISOString() });
            originalError.apply(console, args);
        };
        
        const result = await mcpModule.mcpProcessQuery(query, true);
        
        // Restore console
        console.log = originalLog;
        console.error = originalError;
        
        // Parse logs to extract clean data
        let items = [];
        let count = 0;
        
        for (const log of logs) {
            const message = log.message;
            
            // Look for the "Found X items:" pattern
            const countMatch = message.match(/📊 Found (\d+) items?:/);
            if (countMatch) {
                count = parseInt(countMatch[1]);
            }
            
            // Look for JSON arrays in the logs (the actual items)
            try {
                if (message.startsWith('[') && message.endsWith(']')) {
                    const parsed = JSON.parse(message);
                    if (Array.isArray(parsed) && parsed.length > 0) {
                        items = parsed;
                    }
                }
            } catch (e) {
                // Not valid JSON, continue
            }
        }
        
        res.json({ 
            count,
            items,
            query: query,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        // Restore console in case of error
        console.log = originalLog;
        console.error = originalError;
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`MCP Endpoint listening on port ${PORT}`);
});
