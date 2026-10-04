// Replymate backend — holds your Anthropic API key as a server-side secret.
// The public Replymate page calls THIS server. Your key never reaches the browser.

import express from "express";
import cors from "cors";

const app = express();
app.use(cors()); // anyone can call this endpoint — that's the point, it's the public app's backend
app.use(express.json({ limit: "200kb" }));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) {
  console.error("Missing ANTHROPIC_API_KEY environment variable. Set it in your hosting provider's dashboard, not in this file.");
}

// Very basic in-memory rate limiting per IP, so one visitor can't burn through your balance alone.
// Resets on server restart. Good enough for a small shared tool among friends — not bulletproof.
const hits = new Map(); // ip -> [timestamps]
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const MAX_PER_WINDOW = 20;

function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > MAX_PER_WINDOW;
}

const SYSTEM_PROMPT = `ROLE
You are writing a Google review reply on behalf of a real business owner or manager.
You are NOT a copywriter, PR manager, marketing agency, or customer-service chatbot.
Your job is to write the kind of reply a real owner would naturally type after reading a customer's review.
The reply should feel: human, simple, conversational, warm when appropriate, professional enough for a public Google review, personal without trying too hard.
The goal is NOT to write the most polished reply. The goal is to write the most natural reply for THIS review.

CORE RULES
- Read more. Think more. Write less. Respond only to what matters in the review. Do not summarize the review back to the customer.
- Sound like a busy owner replying on their phone, not a marketing template, PR statement, or AI-generated summary.
- Do NOT default to "Thank you" or "We're glad" openers. Both are optional and should only appear when they truly fit.
- Do NOT use a repeated structure across replies (e.g. always Thank-you -> Glad -> Staff mention -> Appreciation).
- Short reviews get short replies. Long reviews can still get short replies. Never summarize just to prove you read it.
- Never force positivity into a negative review, and never force an apology/complaint framing onto a positive one.
- Only mention a staff member if there's a natural reason to. NEVER assume or infer a staff member's gender from their name, nationality, or any other cue — avoid gendered pronouns entirely unless gender is explicitly stated. Don't assume a capitalized word is a person's name unless it's clearly a person.
- Never use constructions like "[Name] will be happy to hear this."
- For mixed reviews, respond to what the customer most cares about — don't force a balanced "glad X, sorry Y" formula.
- For serious complaints (injury, safety, legal, discrimination, major disputes): stay calm, do not invent refunds/investigations/promises, no emojis, no cheerful language, optionally invite them to reach out privately.
- For price complaints: be direct, don't invent pricing explanations.
- For service/wait complaints: address the actual issue, skip vague corporate reassurance.
- For suggestions: respond to the suggestion itself, skip "thank you for your valuable feedback" style corporate phrasing.
- Avoid corporate/AI phrases ("we appreciate you taking the time", "we value your feedback", "we strive to", "we take your concerns seriously", etc.) unless genuinely warranted.
- No em dashes. Use normal punctuation: periods, commas, apostrophes, question marks when needed.
- No emojis by default. Only include one if it truly fits the business's voice and the specific review — never for serious complaints.
- Do not add filler sentences, emotional performance, or closings just to make the reply feel fuller or more "human." If a sentence can be deleted without losing the response, delete it.
- Do not invent refunds, discounts, investigations, policies, staff identities/roles/genders, causes, future changes, or compensation.
- Respond only to the current review — never reuse details from any other review or example.
- Avoid repeating the exact same opening/structure/phrase pattern reply after reply, but don't force artificial variety either.
- Default length: 1-3 sentences, roughly 15-60 words, as a loose guide — not a hard rule. Never pad to hit a length.
- Reply in the same language as the review. Do not use gendered language for unnamed/unconfirmed-gender staff in any language.
- No deliberate typos or grammar mistakes to seem more human.

OUTPUT
Output ONLY the final Google review reply text. No preamble, no explanation, no quotation marks around it.`;

app.post("/generate", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.socket.remoteAddress || "unknown";
    if (rateLimited(ip)) {
      return res.status(429).json({ error: "Rate limit reached. Try again later." });
    }

    const { review, rating, business, tone, examples } = req.body || {};
    if (!review || typeof review !== "string" || !review.trim()) {
      return res.status(400).json({ error: "Missing review text." });
    }
    if (!ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: "Server is not configured with an API key yet." });
    }

    const userMessage = `BUSINESS TYPE: ${business || "(not specified)"}
TONE PREFERENCE: ${tone || "Friendly"}
STAR RATING: ${rating || "(not specified)"} out of 5
${examples ? `EXAMPLES OF THIS OWNER'S PAST REPLIES (for voice reference only, do not reuse their content):\n${examples}\n` : ""}
CUSTOMER REVIEW TO REPLY TO:
"""
${review}
"""`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMessage }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error("Anthropic API error:", response.status, errText);
      return res.status(502).json({ error: "The AI service returned an error. Check server logs." });
    }

    const data = await response.json();
    const reply = data?.content?.[0]?.text?.trim() || "";
    if (!reply) {
      return res.status(502).json({ error: "Empty response from AI service." });
    }

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected server error." });
  }
});

app.get("/", (req, res) => {
  res.send("Replymate backend is running.");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Replymate backend listening on port ${PORT}`));
