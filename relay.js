import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;       // e.g. https://your-project.supabase.co/functions/v1/open-brain
const MCP_ACCESS_KEY = process.env.MCP_ACCESS_KEY;       // your x-brain-key value
const SUPABASE_URL = process.env.SUPABASE_URL;         // e.g. https://your-project.supabase.co
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

// ─── OpenRouter + MCP call ────────────────────────────────────────────────────

async function callOpenRouterWithMCP(messages) {
    const r = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            model: MODEL,
            messages,
            tools: [
                {
                    type: "mcp",
                    server_label: "edith",
                    server_url: MCP_SERVER_URL,
                    headers: { "x-brain-key": MCP_ACCESS_KEY },
                    require_approval: "never",
                },
            ],
        }),
    });
    if (!r.ok) {
        const err = await r.text();
        throw new Error(`OpenRouter error: ${r.status} ${err}`);
    }
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
    const prompt = `🧠 **Memory check** — worth saving to Edith?\n\n${candidateList}\n\nReply \`save 1, 3\` to save specific ones, \`save all\` to save everything, or \`skip\` to dismiss.`;

    await discordChannel.send(prompt);
}

// ─── Save/skip handler ────────────────────────────────────────────────────────

async function handleMemoryReply(userId, message, discordChannel) {
    const pending = await getPendingMemory(userId);
    if (!pending) return null; // not a memory reply

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
        return null; // not a save/skip command
    }

    if (toSave.length === 0) {
        return "Couldn't match those numbers. Try `save 1, 2` or `skip`.";
    }

    // Use the MCP capture tool directly for each item
    const results = await Promise.all(toSave.map(async (c) => {
        const d = await callOpenRouterWithMCP([
            { role: "user", content: `capture_thought: ${c.content}` },
        ]);
        // Just trigger the capture — confirm optimistically
        return `✅ ${c.content.substring(0, 60)}${c.content.length > 60 ? "..." : ""}`;
    }));

    await deletePendingMemory(userId);
    return `Saved ${toSave.length} thought${toSave.length > 1 ? "s" : ""}:\n${results.join("\n")}`;
}

// ─── System prompt ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are Edith, a personal AI assistant and knowledge base.
You have access to the user's captured thoughts, notes, and ideas via MCP tools.
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
        const memoryReply = await handleMemoryReply(userId, userMessage, discordChannel);
        if (memoryReply) return memoryReply;
    }

    // Load history and save new user message
    const history = await loadHistory(userId);
    await saveMessage(userId, "user", userMessage);

    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userMessage },
    ];

    // Call OpenRouter with MCP attached — it handles the tool loop internally
    const d = await callOpenRouterWithMCP(messages);
    const reply = d.choices[0].message.content;

    await saveMessage(userId, "assistant", reply);

    // Check if it's time for a memory review
    const total = await countMessages(userId);
    if (total % SUMMARIZE_EVERY === 0) {
        summarizeAndPrompt(userId, discordChannel).catch(err =>
            console.error("Memory summarization error:", err)
        );
    }

    return reply;
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
    // console.log(`Relay online as ${client.user.tag}`);
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

    // console.log(`DM from ${message.author.tag}: ${userMessage}`);

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