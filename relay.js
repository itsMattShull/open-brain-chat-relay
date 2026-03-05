import "dotenv/config";
import { Client, GatewayIntentBits, Partials } from "discord.js";

const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const ALLOWED_USER_ID = process.env.ALLOWED_USER_ID;
const CHAT_FUNCTION_URL = process.env.CHAT_FUNCTION_URL;

if (!DISCORD_BOT_TOKEN || !ALLOWED_USER_ID || !CHAT_FUNCTION_URL) {
    console.error("Missing required environment variables.");
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
    ],
    // Required for bots to receive DM events
    partials: [Partials.Channel, Partials.Message],
});

client.once("clientReady", () => {
    console.log(`Relay online as ${client.user.tag}`);
});

client.on("messageCreate", async (message) => {
    // Fetch partial messages so we can read content
    if (message.partial) {
        try { await message.fetch(); }
        catch (err) { console.error("Failed to fetch partial message:", err); return; }
    }

    if (message.author.bot) return;
    if (message.author.id !== ALLOWED_USER_ID) return;
    if (message.channel.type !== 1) return; // 1 = DM channel

    const userMessage = message.content.trim();
    if (!userMessage) return;

    console.log(`Received DM from ${message.author.tag}: ${userMessage}`);

    await message.channel.sendTyping();

    try {
        const res = await fetch(CHAT_FUNCTION_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                user_id: message.author.id,
                discord_user_id: message.author.id,
                message: userMessage,
            }),
        });

        if (!res.ok) {
            const errorText = await res.text();
            console.error("Edge function error:", errorText);
            await message.reply("❌ Something went wrong. Check the edge function logs.");
            return;
        }

        const data = await res.json();
        const reply = data.reply;

        if (!reply) {
            await message.reply("❌ No response returned from edge function.");
            return;
        }

        // Discord has a 2000 char limit — split if needed
        if (reply.length <= 2000) {
            await message.reply(reply);
        } else {
            const chunks = reply.match(/[\s\S]{1,2000}/g) ?? [];
            for (const chunk of chunks) {
                await message.channel.send(chunk);
            }
        }
    } catch (err) {
        console.error("Relay error:", err);
        await message.reply("❌ Failed to reach the edge function.");
    }
});

client.login(DISCORD_BOT_TOKEN);