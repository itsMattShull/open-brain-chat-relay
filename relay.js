import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;   // open-brain edge function URL
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;   // x-brain-key value
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const required = { DISCORD_BOT_TOKEN, ALLOWED_USER_ID, OPENROUTER_API_KEY, MCP_SERVER_URL, MCP_ACCESS_KEY, SUPABASE_URL, SUPABASE_ANON_KEY };
for (const [k, v] of Object.entries(required)) {
    if (!v) { console.error(`Missing required env var: ${k}`); process.exit(1); }
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const MODEL = "openai/gpt-4o-mini";
const MAX_HISTORY = 20;
const SUMMARIZE_EVERY = 20;

const MEMORY_TEMPLATES = `Use these templates to draft each candidate. Pick the most fitting one per item:

1. Decision Capture
Decision: [what was decided]. Context: [why]. Owner: [who if mentioned].

2. Person Note
[Name] — [what happened or what you learned about them].

3. Insight Capture
Insight: [the thing realized]. Triggered by: [what caused it].

4. Meeting Debrief
Meeting with [who] about [topic]. Key points: [important stuff]. Action items: [what happens next].

5. AI Save
Saving from [AI tool or source]: [the key takeaway or output worth keeping].

Only use a template if it genuinely fits. If none fit, write a clean plain sentence instead.`;

// ─── Tool definitions (OpenAI function format) ────────────────────────────────
// These mirror the MCP server tools exactly.
// OpenRouter sees these as normal function tools.
// Execution is proxied to the MCP server via HTTP.

const TOOLS = [
    {
        type: "function",
        function: {
            name: "capture_thought",
            description: "Save a new thought to the Edith knowledge base. Use this when the user wants to save something — notes, insights, decisions, or anything worth remembering.",
            parameters: {
                type: "object",
                properties: {
                    content: { type: "string", description: "The thought to capture — a clear, standalone statement that will make sense when retrieved later" },
                },
                required: ["content"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "search_thoughts",
            description: "Search captured thoughts by meaning. Use this when the user asks about a topic, person, or idea they may have previously captured. Run 2-3 searches with different keywords before concluding nothing exists.",
            parameters: {
                type: "object",
                properties: {
                    query: { type: "string", description: "Natural language search query" },
                    limit: { type: "number", description: "Max results to return (default 10)" },
                    threshold: { type: "number", description: "Similarity threshold 0-1 (default 0.3, use different lower similarities, lower = broader)" },
                },
                required: ["query"],
            },
        },
    },
    {
        type: "function",
        function: {
            name: "list_thoughts",
            description: "List recently captured thoughts with optional filters by type, topic, person, or time range.",
            parameters: {
                type: "object",
                properties: {
                    limit: { type: "number", description: "Max results to return (default 10)" },
                    type: { type: "string", description: "Filter by type: observation, task, idea, reference, person_note" },
                    topic: { type: "string", description: "Filter by topic tag" },
                    person: { type: "string", description: "Filter by person mentioned" },
                    days: { type: "number", description: "Only return thoughts from the last N days" },
                },
            },
        },
    },
    {
        type: "function",
        function: {
            name: "thought_stats",
            description: "Get a summary of all captured thoughts: totals, types, top topics, and people mentioned.",
            parameters: { type: "object", properties: {} },
        },
    },
];

// ─── MCP tool execution ───────────────────────────────────────────────────────
// Proxies tool calls to the MCP server using the MCP JSON-RPC protocol.
// The MCP server does all the actual work — embeddings, DB, etc.

async function callMCPTool(toolName, toolArgs) {
    const body = {
        jsonrpc: "2.0",
        id: Date.now(),
        method: "tools/call",
        params: {
            name: toolName,
            arguments: toolArgs,
        },
    };

    const r = await fetch(MCP_SERVER_URL, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "x-brain-key": MCP_ACCESS_KEY,
        },
        body: JSON.stringify(body),
    });

    if (!r.ok) {
        return `MCP error: ${r.status} ${await r.text()}`;
    }

    const d = await r.json();

    if (d.result?.content) {
        return d.result.content
            .filter(c => c.type === "text")
            .map(c => c.text)
            .join("\n");
    }

    if (d.error) return `Tool error: ${d.error.message}`;
    return "No result returned.";
}

// ─── Supabase REST helpers ────────────────────────────────────────────────────

const sbHeaders = () => ({
    "Content-Type": "application/json",
    "Authorization": `Bearer ${SUPABASE_ANON_KEY}`,
    "apikey": SUPABASE_ANON_KEY,
    "Prefer": "return=minimal",
});

async function loadHistory(userId) {
    const url = `${SUPABASE_URL}/rest/v1/conversations?user_id=eq.${userId}&order=created_at.desc&limit=${MAX_HISTORY}&select=role,content`;
    const r = await fetch(url, { headers: sbHeaders() });
    const data = await r.json();
    return (Array.isArray(data) ? data : []).reverse();
}

async function saveMessage(userId, role, content) {
    await fetch(`${SUPABASE_URL}/rest/v1/conversations`, {
        method: "POST",
        headers: sbHeaders(),
        body: JSON.stringify({ user_id: userId, role, content }),
    });
}

async function countMessages(userId) {
    const url = `${SUPABASE_URL}/rest/v1/conversations?user_id=eq.${userId}&select=id`;
    const r = await fetch(url, { headers: { ...sbHeaders(), "Prefer": "count=exact" } });
    const count = r.headers.get("content-range")?.split("/")?.[1];
    return parseInt(count || "0", 10);
}

async function getPendingMemory(userId) {
    const url = `${SUPABASE_URL}/rest/v1/pending_memory?user_id=eq.${userId}&limit=1`;
    const r = await fetch(url, { headers: sbHeaders() });
    const data = await r.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
}

async function upsertPendingMemory(userId, candidates) {
    await fetch(`${SUPABASE_URL}/rest/v1/pending_memory`, {
        method: "POST",
        headers: { ...sbHeaders(), "Prefer": "resolution=merge-duplicates" },
        body: JSON.stringify({ user_id: userId, candidates }),
    });
}

async function deletePendingMemory(userId) {
    await fetch(`${SUPABASE_URL}/rest/v1/pending_memory?user_id=eq.${userId}`, {
        method: "DELETE",
        headers: sbHeaders(),
    });
}

async function getRecentThoughts(limit = 50) {
    const url = `${SUPABASE_URL}/rest/v1/thoughts?order=created_at.desc&limit=${limit}&select=content`;
    const r = await fetch(url, { headers: sbHeaders() });
    const data = await r.json();
    return Array.isArray(data) ? data : [];
}

// ─── OpenRouter call ──────────────────────────────────────────────────────────

async function callOpenRouter(messages) {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: MODEL,
            messages,
            tools: TOOLS,
            tool_choice: "auto",
        }),
    });

    if (!r.ok) throw new Error(`OpenRouter error: ${r.status} ${await r.text()}`);
    return await r.json();
}

// ─── Memory summarization ─────────────────────────────────────────────────────

async function summarizeAndPrompt(userId, discordChannel) {
    const history = await loadHistory(userId);
    if (history.length < 5) return;

    const existingThoughts = await getRecentThoughts(50);
    const existingSummary = existingThoughts.length > 0
        ? `\n\nThoughts ALREADY saved (do NOT suggest these again):\n${existingThoughts.map(t => `- ${t.content}`).join("\n")}`
        : "";

    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: MODEL,
            response_format: { type: "json_object" },
            messages: [
                {
                    role: "system",
                    content: `You are reviewing a conversation to find things worth saving to a personal knowledge base.
Extract only high-signal items: decisions made, insights reached, important facts about people, action items with owners, or valuable AI outputs.
Do NOT capture small talk, clarifying questions, or anything transient.
Do NOT suggest anything already in the knowledge base.

${MEMORY_TEMPLATES}

Return JSON: { "candidates": [ { "index": 1, "content": "..." }, ... ] }
Return an empty candidates array if nothing new is worth saving.
Maximum 5 candidates. Be selective.${existingSummary}`,
                },
                {
                    role: "user",
                    content: history.map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n"),
                },
            ],
        }),
    });

    const d = await r.json();
    let candidates = [];
    try {
        candidates = JSON.parse(d.choices[0].message.content).candidates ?? [];
    } catch { return; }

    if (candidates.length === 0) return;

    await upsertPendingMemory(userId, candidates);

    const candidateList = candidates.map(c => `**${c.index}.** ${c.content}`).join("\n");
    await discordChannel.send(
        `🧠 **Memory check** — worth saving to Edith?\n\n${candidateList}\n\nReply \`save 1, 3\` to save specific ones, \`save all\` to save everything, or \`skip\` to dismiss.`
    );
}

// ─── Save/skip handler ────────────────────────────────────────────────────────

async function handleMemoryReply(userId, message) {
    const pending = await getPendingMemory(userId);
    if (!pending) return null;

    const candidates = pending.candidates;
    const lower = message.toLowerCase().trim();

    if (lower === "skip") {
        await deletePendingMemory(userId);
        return "👍 Skipped — nothing saved.";
    }

    let toSave = [];
    if (lower === "save all") {
        toSave = candidates;
    } else if (lower.startsWith("save")) {
        const numbers = lower.replace("save", "").match(/\d+/g)?.map(Number) ?? [];
        toSave = candidates.filter(c => numbers.includes(c.index));
    } else {
        return null; // not a memory reply
    }

    if (toSave.length === 0) {
        return "Couldn't match those numbers. Try `save 1, 2` or `skip`.";
    }

    // Proxy each capture through the MCP server
    await Promise.all(toSave.map(c => callMCPTool("capture_thought", { content: c.content })));

    await deletePendingMemory(userId);
    return `Saved ${toSave.length} thought${toSave.length > 1 ? "s" : ""}:\n${toSave.map(c => `✅ ${c.content.substring(0, 80)}${c.content.length > 80 ? "..." : ""}`).join("\n")}`;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Edith, a personal AI assistant and knowledge base.
You have access to the user's captured thoughts, notes, and ideas via tools.
You are talking to the user via Discord DM. Be warm, direct, and conversational — like a smart friend who happens to remember everything they've told you.

SEARCHING RULES — follow these exactly:
- Always search before saying you don't know something
- For any question about a person, company, topic, or event — run at least 2-3 searches with different keywords and angles before concluding you have nothing
- Example: "Everway org chart" should trigger searches for "Everway org chart", "Everway CEO", "Everway team structure", "Everway leadership"
- Use threshold 0.3 for all searches to cast a wider net
- Only tell the user you don't have information after genuinely trying multiple search angles

CRITICAL FORMATTING RULE: Never respond with numbered or bulleted lists unless the user explicitly asks. Always write in natural prose sentences. Weave multiple results together into flowing sentences. Do not label or enumerate results. Do not say "Result 1" or "1." or "-". Just talk naturally.

Good example response to "what do you know about Jeff Fuller?":
"Jeff Fuller is your EM partner — you've described him as a cool guy. He's connected to Iman Davis-Young on the Polaris team, who reports to him, and he comes up in the context of the broader IEP org with Ryan Fast and Carina Merkel."

Use your tools proactively:
- Search thoughts when the user asks about something they may have captured before
- Capture thoughts when the user says something worth remembering
- List thoughts only when the user explicitly asks to see a list or browse
- Use thought_stats when the user wants a high-level overview`;

// ─── Main chat handler ────────────────────────────────────────────────────────

async function handleMessage(userId, userMessage, discordChannel) {
    // Check for pending memory reply first
    const lower = userMessage.toLowerCase().trim();
    if (lower.startsWith("save") || lower === "skip") {
        const memoryReply = await handleMemoryReply(userId, userMessage);
        if (memoryReply) return memoryReply;
    }

    // Load history and save the new user message
    const history = await loadHistory(userId);
    await saveMessage(userId, "user", userMessage);

    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userMessage },
    ];

    // ── Tool calling loop ────────────────────────────────────────────────────
    // Keep looping until the AI produces a final reply with no tool calls
    let finalReply = "";

    while (true) {
        const d = await callOpenRouter(messages);
        const responseMessage = d.choices[0].message;

        if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
            finalReply = responseMessage.content;
            break;
        }

        // Push assistant's tool call message into the conversation
        messages.push(responseMessage);

        // Execute each tool call by proxying to the MCP server
        for (const toolCall of responseMessage.tool_calls) {
            const args = JSON.parse(toolCall.function.arguments || "{}");
            console.log(`Tool call: ${toolCall.function.name}`, args);
            const result = await callMCPTool(toolCall.function.name, args);
            messages.push({
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            });
        }
        // Loop so the AI can reason over the tool results
    }

    await saveMessage(userId, "assistant", finalReply);

    // Trigger memory review every SUMMARIZE_EVERY messages
    const total = await countMessages(userId);
    if (total % SUMMARIZE_EVERY === 0) {
        summarizeAndPrompt(userId, discordChannel).catch(err =>
            console.error("Memory summarization error:", err)
        );
    }

    return finalReply;
}

// ─── Discord client ───────────────────────────────────────────────────────────

const client = new Client({
    intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
});

client.once("clientReady", () => {
    console.log(`Relay online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
    if (message.partial) {
        try { await message.fetch(); }
        catch (err) { console.error("Failed to fetch partial message:", err); return; }
    }

    if (message.author.bot) return;
    if (message.author.id !== ALLOWED_USER_ID) return;
    if (message.channel.type !== 1) return; // DMs only

    const userMessage = message.content.trim();
    if (!userMessage) return;

    console.log(`DM from ${message.author.tag}: ${userMessage}`);
    await message.channel.sendTyping();

    try {
        const reply = await handleMessage(message.author.id, userMessage, message.channel);

        if (!reply) {
            await message.reply("❌ No response returned.");
            return;
        }

        // Split if over Discord's 2000 char limit
        if (reply.length <= 2000) {
            await message.reply(reply);
        } else {
            const chunks = reply.match(/[\s\S]{1,2000}/g) ?? [];
            for (const chunk of chunks) {
                await message.channel.send(chunk);
            }
        }
    } catch (err) {
        console.error("Handler error:", err);
        await message.reply("❌ Something went wrong. Check the logs.");
    }
});

client.login(DISCORD_BOT_TOKEN);