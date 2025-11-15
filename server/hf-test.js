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
    const url = "https://www.nike.com";
    console.log(`✅ Getting analysis JSON for: ${url}`);
    const analysisJSON = await analyzeWebsite(url);
    const safeJSON = safeStringify(analysisJSON);

    // Prompt to LLM
   
const systemMessage = `
You are a senior digital strategy, marketing, and web audit analyst.
Produce a professional, executive-friendly report based ONLY on the provided JSON.
Purpose: Convert raw website scan data into a clear, persuasive, and actionable digital business snapshot that shows what the business does, its website performance, technologies used, SEO, content, competitors, and overall online presence. The report should help with instant lead generation.

Hard rules:
- Use the exact section headings and order below. Do not add, remove, rename, or reorder headings.
- Each heading must appear on its own line followed by a plain-text paragraph (no bullets, tables, markdown).
- Use only the JSON. Never claim to have visited or crawled the live site or used external sources.
- If you infer any insight not directly present, mark it inline as: INFERRED (confidence: XX%) with a brief explanation if needed.
- Numeric estimates must include value and confidence inline, e.g., (~31, confidence 78%).
- Do not exaggerate performance, traffic, or impact. Be optimistic but accurate within the data and inferences.
- If data completeness < 20% start with: "Partial scan — high uncertainty."
- Keep tone professional, factual, and actionable, suitable for leads.

Sections (exact, in order):
Executive Summary
SEO Analysis
Accessibility Review
Performance Review
Social Media and Brand Presence
Visual and Design Assessment
Reputation and Trust Signals
Keyword Strategy (infer only)
Critical Issues
Actionable Recommendations
`;



const userMessage = `
Generate a digital impact and business insight report from the JSON below.
Use only the provided JSON. Do not output raw JSON, bullets, lists, tables, or markdown.
Keep the headings exactly as listed in the system message, each followed by a plain-text paragraph only.
Do not claim external knowledge; base all statements solely on JSON.
If you make inferences, label them inline as INFERRED (confidence: XX%) and provide numeric estimates with confidence inline.
Focus on revealing the business model, products/services, website effectiveness, technology stack, SEO, content, online presence, competitors, and overall digital health. Provide actionable insights for client acquisition and online presence improvement.
Do not exaggerate or make claims beyond what the data and logical inference support.
If data completeness < 20%, start with "Partial scan — high uncertainty."

JSON:
${safeJSON}
`;





    console.log("✅ Sending JSON to HuggingFace LLM...");

    const chatCompletion = await client.chat.completions.create({
      model: "meta-llama/Llama-3.1-8B-Instruct:novita",
      messages: [
        { role: "system", content: systemMessage },
        { role: "user", content: userMessage }
      ],
      max_tokens: 4000,
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
