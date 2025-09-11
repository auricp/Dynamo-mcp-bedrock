import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import dotenv from "dotenv";

dotenv.config();

// Check for AWS region
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
console.log(`Using AWS region: ${AWS_REGION}`);

// Create Bedrock client
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

// Try different model IDs
const modelIds = [
  "anthropic.claude-3-7-sonnet-20250219-v1:0",
  "anthropic.claude-3-sonnet-20240229-v1:0",
  "anthropic.claude-3-haiku-20240307-v1:0",
  "anthropic.claude-instant-v1"
];

async function testModel(modelId) {
  console.log(`\nTesting model: ${modelId}`);
  
  try {
    // Create the request payload
    const payload = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 200,
      top_k: 250,
      stop_sequences: [],
      temperature: 1,
      top_p: 0.999,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "hello world"
            }
          ]
        }
      ]
    };

    // Invoke the Bedrock model
    const command = new InvokeModelCommand({
      modelId: modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify(payload)
    });

    const response = await bedrockClient.send(command);
    
    // Parse the response
    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    console.log("Success! Response:", JSON.stringify(responseBody, null, 2));
    return true;
  } catch (error) {
    console.error(`Error with model ${modelId}:`, error.message);
    return false;
  }
}

// List available models
async function listModels() {
  try {
    // Import the Bedrock client for listing models
    const { BedrockClient, ListFoundationModelsCommand } = await import("@aws-sdk/client-bedrock");
    
    const bedrockModelClient = new BedrockClient({ region: AWS_REGION });
    const listCommand = new ListFoundationModelsCommand({});
    
    const response = await bedrockModelClient.send(listCommand);
    console.log("\nAvailable models in your account:");
    
    if (response.modelSummaries) {
      response.modelSummaries.forEach(model => {
        console.log(`- ${model.modelId} (${model.providerName})`);
      });
    } else {
      console.log("No models found");
    }
  } catch (error) {
    console.error("Error listing models:", error.message);
  }
}

async function main() {
  console.log("Testing Bedrock model access...");
  
  let anySuccess = false;
  
  // Try each model ID
  for (const modelId of modelIds) {
    const success = await testModel(modelId);
    if (success) {
      anySuccess = true;
      console.log(`✅ Successfully used model: ${modelId}`);
    }
  }
  
  if (!anySuccess) {
    console.log("\n❌ None of the tested models worked.");
    console.log("Let's list the available models in your account:");
    await listModels();
    
    console.log("\nPossible solutions:");
    console.log("1. Make sure you have access to Claude models in Bedrock");
    console.log("2. Check if you need to create an inference profile for the model");
    console.log("3. Verify your AWS credentials and region settings");
    console.log("4. Check if you need to request access to these models in the AWS console");
  }
}

main().catch(error => {
  console.error("Unhandled error:", error);
});
