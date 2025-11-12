// hf-test.js
import dotenv from "dotenv";
dotenv.config({ path: "./.env" }); // make sure .env is in the same folder

import OpenAI from "openai";
import { analyzeWebsite } from "../lib/analyze.mjs";

// ---------- UTIL ----------
function safeStringify(obj) {
  try { return JSON.stringify(obj, null, 2); }
  catch {
    const seen = new WeakSet();
    return JSON.stringify(obj, (k, v) => {
      if (typeof v === "object" && v !== null) {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      if (typeof v === "function") return undefined;
      return v;
    }, 2);
  }
}

// ---------- MAIN ----------
async function testHF() {
  try {
    // check that OPENAI_API_KEY is loaded
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY not found in environment!");
    }
    console.log("✅ OPENAI_API_KEY loaded");

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      baseURL: process.env.HF_ROUTER_BASEURL || "https://router.huggingface.co/v1",
    });

    // Get website analysis JSON
    const url = "https://www.gymshark.com/";
    console.log(`✅ Getting analysis JSON for: ${url}`);
    const analysisJSON = await analyzeWebsite(url);

    // Prompt to LLM
    const systemMessage = `
You are a senior-level website audit engine with expertise in SEO, social media, accessibility, and web design.
Your task is to generate a professional, data-driven audit report.

- Use ONLY the data provided in the JSON.
- Do NOT invent, speculate, or comment on missing data.
- Include all arrays, metrics, links, and values exactly as they appear.
- Present each section clearly, using headings, subheadings, tables, lists, and enumerations where appropriate.
- Focus on actionable insights, but only from the provided data.
- Maintain credibility and professionalism; avoid subjective opinions without data support.
- Return sections in EXACT order:

1. Executive Summary
2. SEO Analysis
3. Accessibility Review
4. Performance Review
5. Social Media & Brand Presence
6. Visual & Design Assessment
7. Reputation & Trust Signals
8. Keyword Strategy
9. Critical Issues
10. Actionable Recommendations
`;

const userMessage = `
Convert the following JSON into a fully detailed, structured website audit report.
Include every field and array from the JSON.
Use tables and lists for readability.
Do not omit any data, and do not add information not present in the JSON.
JSON:
${safeStringify(analysisJSON)}
`;


    console.log("✅ Sending JSON to HuggingFace LLM...");

    const chatCompletion = await client.chat.completions.create({
      model: "meta-llama/Llama-3.1-8B-Instruct:novita",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      max_tokens: 12000,
      temperature: 0.1
    });

    const llmOutput = chatCompletion.choices?.[0]?.message?.content?.trim() || "";
    console.log("\n--- LLM OUTPUT ---\n");
    console.log(llmOutput);

  } catch (err) {
    console.error("Error calling HuggingFace LLM:", err);
  }
}

testHF();
