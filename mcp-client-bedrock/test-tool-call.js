import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";

dotenv.config();

// Check for AWS region
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
console.log(`Using AWS region: ${AWS_REGION}`);

// Create Bedrock client
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

// Define a simple tool
const weatherTool = {
  name: "get_weather",
  description: "Get the current weather in a location",
  input_schema: {
    type: "object",
    properties: {
      location: {
        type: "string",
        description: "The city and state, e.g. San Francisco, CA"
      }
    },
    required: ["location"]
  }
};

async function testToolCall() {
  console.log("Testing tool call with Bedrock...");
  
  try {
    // Initial query
    const initialPayload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 1000,
      temperature: 0.7,
      top_p: 0.999,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What's the weather in Tampa?"
            }
          ]
        }
      ],
      tools: [weatherTool]
    };

    // Invoke the Bedrock model
    const initialCommand = new InvokeModelCommand({
      modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(initialPayload)
    });

    console.log("Sending initial request...");
    const initialResponse = await bedrockClient.send(initialCommand);
    const initialResponseBody = JSON.parse(new TextDecoder().decode(initialResponse.body));
    
    console.log("Initial response:", JSON.stringify(initialResponseBody, null, 2));
    
    // Check if there's a tool call
    const toolUse = initialResponseBody.content.find(item => item.type === "tool_use");
    
    if (toolUse) {
      console.log(`\nTool call detected: ${toolUse.name}`);
      console.log("Tool arguments:", JSON.stringify(toolUse.input, null, 2));
      
      // Simulate tool response
      const toolResponse = {
        temperature: "82°F",
        condition: "Partly Cloudy",
        humidity: "65%",
        wind: "10 mph"
      };
      
      // Create follow-up message with tool response
      const messages = [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "What's the weather in Tampa?"
            }
          ]
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUse.id, // Include the tool use ID
              name: toolUse.name,
              input: toolUse.input
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUse.id,
              content: JSON.stringify(toolResponse)
            }
          ]
        }
      ];
      
      // Create follow-up request
      const followUpPayload = {
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1000,
        temperature: 0.7,
        top_p: 0.999,
        messages: messages,
        tools: [weatherTool] // Include tools in the follow-up request
      };
      
      const followUpCommand = new InvokeModelCommand({
        modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
        contentType: "application/json",
        accept: "application/json",
        body: JSON.stringify(followUpPayload)
      });
      
      console.log("\nSending follow-up request with tool response...");
      const followUpResponse = await bedrockClient.send(followUpCommand);
      const followUpBody = JSON.parse(new TextDecoder().decode(followUpResponse.body));
      
      console.log("Follow-up response:", JSON.stringify(followUpBody, null, 2));
    } else {
      console.log("No tool call was made in the response.");
    }
    
  } catch (error) {
    console.error("Error:", error.message);
  }
}

testToolCall().catch(error => {
  console.error("Unhandled error:", error);
});
