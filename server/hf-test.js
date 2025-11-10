// hf-test.js
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config({ path: "./.env" }); // Make sure .env is in the same folder

async function testHF() {
  try {
    const client = new OpenAI({
      baseURL: "https://router.huggingface.co/v1",
      apiKey: process.env.HUGGINGFACE_API_KEY,
    });

    const chatCompletion = await client.chat.completions.create({
      model: "meta-llama/Llama-3.1-8B-Instruct:novita",
      messages: [
        {
          role: "user",
          content: "Write a short website audit report for a website called example.com.",
        },
      ],
    });

    console.log("--- Generated Text ---");
    console.log(chatCompletion.choices[0].message.content);
  } catch (err) {
    console.error("Error calling HuggingFace:", err);
  }
}

testHF();
