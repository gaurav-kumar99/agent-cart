import "dotenv/config";
import express from "express";
import Anthropic from "@anthropic-ai/sdk";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, searchProducts, getProduct } from "./catalog.js";
import { createOrder, captureOrder, isPayPalDemo } from "./paypal.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-5-5";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const BASE_URL = process.env.PUBLIC_BASE_URL || `http://localhost:${PORT}`;

// Which AI runs the agent: claude (needs ANTHROPIC_API_KEY), gemini (free GEMINI_API_KEY), or demo (no keys).
function pickProvider() {
  const forced = (process.env.AI_PROVIDER || "").toLowerCase();
  if (["claude", "gemini", "demo"].includes(forced)) return forced;
  if (process.env.ANTHROPIC_API_KEY) return "claude";
  if (process.env.GEMINI_API_KEY) return "gemini";
  return "demo";
}
const PROVIDER = pickProvider();

let anthropic;
const getAnthropic = () => (anthropic ??= new Anthropic());

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ---- In-memory sessions (fine for a demo) ----
const sessions = new Map();
function getSession(id) {
  if (!sessions.has(id)) sessions.set(id, { messages: [], gemini: [], cart: [], orders: {} });
  return sessions.get(id);
}
const cartTotal = (cart) => Number(cart.reduce((s, i) => s + i.price * i.qty, 0).toFixed(2));

// ---- Agent tools ----
const TOOLS = [
  {
    name: "search_products",
    description: "Search the store catalog. Returns up to 8 products with id, name, price (USD), category.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Keywords, e.g. 'hiking backpack'" },
        max_price: { type: "number", description: "Maximum unit price in USD" },
        category: { type: "string", description: "Optional: gaming, coffee, outdoor, fitness, tech, office, kitchen, home" }
      },
      required: ["query"]
    }
  },
  {
    name: "add_to_cart",
    description: "Add a product to the shopper's cart by product id.",
    input_schema: {
      type: "object",
      properties: { product_id: { type: "string" }, qty: { type: "integer", description: "Quantity, default 1" } },
      required: ["product_id"]
    }
  },
  {
    name: "remove_from_cart",
    description: "Remove a product from the cart by product id.",
    input_schema: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] }
  },
  {
    name: "view_cart",
    description: "Return current cart contents and total.",
    input_schema: { type: "object", properties: {} }
  },
  {
    name: "checkout",
    description:
      "Create a PayPal order for the current cart and return an approval link for the shopper. " +
      "Only call this after the shopper has clearly said they want to check out. The shopper still approves payment themselves in PayPal.",
    input_schema: { type: "object", properties: {} }
  }
];

const SYSTEM = `You are AgentCart, a friendly shopping agent. You help a shopper find products, build a cart that respects their budget, and check out with PayPal.
Rules:
- Use search_products before recommending anything; only suggest items that exist in the catalog.
- Respect any budget the shopper states. Compute totals with view_cart, never guess. Never exceed the budget.
- Add items to the cart yourself when the shopper's request makes the choice clear; briefly explain why you picked each item.
- Never call checkout until the shopper explicitly confirms they want to pay. Before checkout, summarize the cart and total.
- You never see or handle payment details; the shopper approves payment on PayPal.
Keep replies short and clear.`;

async function runTool(session, name, input = {}) {
  switch (name) {
    case "search_products":
      return searchProducts(input);
    case "add_to_cart": {
      const p = getProduct(input.product_id);
      if (!p) return { error: "Unknown product_id" };
      const qty = Math.max(1, Math.floor(Number(input.qty) || 1));
      const line = session.cart.find((i) => i.id === p.id);
      if (line) line.qty += qty;
      else session.cart.push({ id: p.id, name: p.name, price: p.price, qty });
      return { cart: session.cart, total: cartTotal(session.cart) };
    }
    case "remove_from_cart":
      session.cart = session.cart.filter((i) => i.id !== input.product_id);
      return { cart: session.cart, total: cartTotal(session.cart) };
    case "view_cart":
      return { cart: session.cart, total: cartTotal(session.cart) };
    case "checkout": {
      if (session.cart.length === 0) return { error: "Cart is empty" };
      const order = await createOrder(session.cart, BASE_URL);
      session.orders[order.orderId] = { items: [...session.cart], total: order.total, status: "CREATED" };
      session.pendingCheckout = order;
      return { status: "awaiting_shopper_approval", total: order.total, orderId: order.orderId };
    }
    default:
      return { error: `Unknown tool ${name}` };
  }
}

// ---- Provider 1: Claude (tool use loop) ----
async function turnClaude(session, message) {
  session.messages.push({ role: "user", content: message });
  for (let step = 0; step < 8; step++) {
    const response = await getAnthropic().messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS,
      messages: session.messages
    });
    session.messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason !== "tool_use") {
      return response.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
    }
    const results = [];
    for (const block of response.content.filter((b) => b.type === "tool_use")) {
      let out;
      try { out = await runTool(session, block.name, block.input); } catch (e) { out = { error: e.message }; }
      results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(out) });
    }
    session.messages.push({ role: "user", content: results });
  }
  return "";
}

// ---- Provider 2: Gemini (free key, plain REST, function calling loop) ----
const toGeminiSchema = (s) => {
  if (!s || typeof s !== "object") return s;
  const out = { type: String(s.type).toUpperCase() };
  if (s.description) out.description = s.description;
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  if (s.required) out.required = s.required;
  return out;
};
const GEMINI_TOOLS = [{
  functionDeclarations: TOOLS.map((t) => {
    const schema = toGeminiSchema(t.input_schema);
    const decl = { name: t.name, description: t.description };
    if (schema.properties && Object.keys(schema.properties).length) decl.parameters = schema; // no-arg tools omit parameters
    return decl;
  })
}];

async function turnGemini(session, message) {
  session.gemini.push({ role: "user", parts: [{ text: message }] });
  for (let step = 0; step < 8; step++) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: SYSTEM }] },
          tools: GEMINI_TOOLS,
          contents: session.gemini
        })
      }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(`Gemini error ${res.status}: ${data?.error?.message || JSON.stringify(data)}`);
    const content = data.candidates?.[0]?.content;
    if (!content) return "";
    session.gemini.push(content);
    const parts = content.parts || [];
    const calls = parts.filter((p) => p.functionCall);
    if (!calls.length) return parts.map((p) => p.text || "").join("").trim();
    const responses = [];
    for (const { functionCall } of calls) {
      let out;
      try { out = await runTool(session, functionCall.name, functionCall.args || {}); } catch (e) { out = { error: e.message }; }
      const wrapped = Array.isArray(out) ? { results: out } : out;
      responses.push({ functionResponse: { name: functionCall.name, response: wrapped } });
    }
    session.gemini.push({ role: "user", parts: responses });
  }
  return "";
}

// ---- Provider 3: Demo (no keys; simple rules, same tools, same cart + checkout) ----
const STOP = new Set(("i need want a an the for under max maximum budget and kit starter essentials with to my me of some get buy " +
  "dollars dollar usd please can you gear stuff things items set upto up below less than total about around").split(" "));
const SYNONYMS = { workout: "fitness", gym: "fitness", hike: "outdoor", hiking: "outdoor", camp: "outdoor", camping: "outdoor", trek: "outdoor", computer: "tech", game: "gaming", games: "gaming" };

async function turnDemo(session, message) {
  const text = message.toLowerCase();
  const wantsPay = /\b(yes|yep|yeah|checkout|check out|pay|confirm|proceed|buy it|place order)\b/.test(text);
  if (wantsPay && session.cart.length) {
    const cart = await runTool(session, "view_cart");
    await runTool(session, "checkout");
    return `Great! Your cart comes to $${cart.total.toFixed(2)}. Click the PayPal button below to approve the payment. (Demo mode: AI replies are scripted.)`;
  }
  if (/\b(clear|empty|remove all|start over)\b/.test(text)) {
    session.cart = [];
    return "Cart cleared. What would you like to shop for?";
  }
  const budgetMatch = text.match(/\$\s?(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:dollars|usd|bucks)/) || text.match(/\b(?:under|max|below|budget(?: of)?)\s*(\d+(?:\.\d+)?)/);
  const budget = budgetMatch ? Number(budgetMatch[1] || budgetMatch[2]) : null;
  const words = [...new Set(text.replace(/[^a-z\s]/g, " ").split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w)).map((w) => SYNONYMS[w] || w.replace(/s$/, "")))];
  if (!words.length) {
    return "Tell me what you're shopping for and your budget, for example: \"hiking starter kit under $150\".";
  }
  const found = searchProducts({ query: words.join(" ") });
  if (!found.length) return "I couldn't find matching items. Try words like hiking, gym, travel, running or yoga.";

  session.cart = [];
  const picked = [];
  let total = 0;
  for (const p of found) {
    if (picked.length >= 4) break;
    if (budget != null && total + p.price > budget) continue;
    await runTool(session, "add_to_cart", { product_id: p.id });
    picked.push(p);
    total += p.price;
  }
  if (!picked.length) return `Nothing in that search fits under $${budget}. Try a higher budget.`;
  const lines = picked.map((p) => `- ${p.name} ($${p.price.toFixed(2)})`).join("\n");
  const budgetNote = budget != null ? ` Budget: $${budget}, so you have $${(budget - total).toFixed(2)} left.` : "";
  return `Here's what I picked for you:\n${lines}\nTotal: $${total.toFixed(2)}.${budgetNote}\nSay "yes" when you're ready to check out with PayPal.`;
}

// ---- Chat endpoint ----
app.post("/api/chat", async (req, res) => {
  try {
    const { sessionId, message } = req.body || {};
    if (!sessionId || !message) return res.status(400).json({ error: "sessionId and message required" });
    const session = getSession(sessionId);
    session.pendingCheckout = null;

    const turn = PROVIDER === "claude" ? turnClaude : PROVIDER === "gemini" ? turnGemini : turnDemo;
    const reply = await turn(session, message);

    res.json({
      reply: reply || "Sorry, I got stuck. Could you rephrase that?",
      cart: session.cart,
      total: cartTotal(session.cart),
      checkout: session.pendingCheckout || null
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ---- Store + cart endpoints used by the web page ----
app.get("/api/products", (_req, res) => res.json(CATALOG));

app.post("/api/cart/add", (req, res) => {
  const { sessionId, product_id } = req.body || {};
  if (!sessionId || !product_id) return res.status(400).json({ error: "sessionId and product_id required" });
  const session = getSession(sessionId);
  const p = getProduct(product_id);
  if (!p) return res.status(404).json({ error: "Unknown product" });
  const line = session.cart.find((i) => i.id === p.id);
  if (line) line.qty += 1;
  else session.cart.push({ id: p.id, name: p.name, price: p.price, qty: 1 });
  res.json({ cart: session.cart, total: cartTotal(session.cart) });
});

app.post("/api/cart/remove", (req, res) => {
  const { sessionId, product_id } = req.body || {};
  const session = getSession(sessionId || "");
  session.cart = session.cart.filter((i) => i.id !== product_id);
  res.json({ cart: session.cart, total: cartTotal(session.cart) });
});

app.post("/api/checkout", async (req, res) => {
  try {
    const session = getSession((req.body || {}).sessionId || "");
    const out = await runTool(session, "checkout");
    if (out.error) return res.status(400).json(out);
    res.json({ checkout: session.pendingCheckout });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get("/api/status", (_req, res) => res.json({ ai: PROVIDER, paypal: isPayPalDemo() ? "demo" : "sandbox" }));

// ---- PayPal redirect handlers ----
function findOrder(orderId) {
  for (const s of sessions.values()) if (s.orders[orderId]) return { s, o: s.orders[orderId] };
  return null;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const page = (title, body, payload) => `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
<body style="font-family:system-ui;text-align:center;padding:3rem"><h2>${esc(title)}</h2><p>${esc(body)}</p>
<script>try{window.opener&&window.opener.postMessage(${JSON.stringify(payload).replace(/</g, "\\u003c")},"*")}catch(e){}
setTimeout(()=>window.close(),2500)</script></body>`;

// Fake PayPal approval screen, used only in demo mode.
app.get("/paypal/demo", (req, res) => {
  const token = esc(encodeURIComponent(String(req.query.token || "")));
  res.send(`<!doctype html><meta charset="utf-8"><title>PayPal (demo)</title>
<body style="font-family:system-ui;text-align:center;padding:3rem;background:#f5f7fa">
<h2>PayPal checkout (DEMO)</h2><p>This is a simulated PayPal page. No real payment happens.</p>
<p style="font-size:22px"><b>Pay $${esc(req.query.total || "")}</b></p>
<a href="/paypal/return?token=${token}" style="display:inline-block;background:#ffc439;color:#111;font-weight:700;padding:12px 28px;border-radius:24px;text-decoration:none">Pay Now</a>
<p><a href="/paypal/cancel">Cancel</a></p></body>`);
});

app.get("/paypal/return", async (req, res) => {
  const orderId = String(req.query.token || "");
  const found = findOrder(orderId);
  if (!found) return res.status(404).send(page("Order not found", "Unknown order.", { type: "paypal", ok: false }));
  try {
    const cap = await captureOrder(orderId);
    found.o.status = cap.status;
    found.s.cart = [];
    res.send(page("Payment complete", `PayPal status: ${cap.status}. You can close this window.`,
      { type: "paypal", ok: cap.status === "COMPLETED", orderId, total: found.o.total }));
  } catch (e) {
    res.status(500).send(page("Payment failed", e.message, { type: "paypal", ok: false }));
  }
});

app.get("/paypal/cancel", (_req, res) =>
  res.send(page("Checkout cancelled", "No payment was taken.", { type: "paypal", ok: false, cancelled: true })));

app.listen(PORT, () => {
  console.log(`AgentCart running at ${BASE_URL}`);
  console.log(`AI: ${PROVIDER}${PROVIDER === "demo" ? " (no keys, scripted replies)" : ""} | PayPal: ${isPayPalDemo() ? "demo (fake)" : "sandbox"}`);
});
