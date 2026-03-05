# Open Brain Chat Relay

A Node.js Discord bot designed to serve as a personal AI assistant ("Edith"). It interacts via Direct Messages, processes chats through OpenRouter using GPT-4o-mini, stores conversation history in Supabase, and utilizes the Model Context Protocol (MCP) to access your custom edge function tools.

## Overview

Unlike a simple relay, this bot handles the full interaction loop:
1. **Listens** for DMs from your authorized Discord account.
2. **Loads** your conversation history directly from Supabase.
3. **Prompts** an OpenRouter LLM, providing it with your conversation history and a system prompt.
4. **Authenticates & Calls** your custom Open Brain MCP server (hosted on a Supabase Edge Function) so the LLM can use tools (like searching or capturing thoughts).
5. **Summarizes** conversations periodically and prompts you to save key insights to your knowledge base.

## Setup

1. **Clone the repository and install dependencies:**
   ```bash
   npm install
   ```

2. **Configure Environment Variables:**
   Copy `.env.example` to `.env` and populate the required variables:
   ```bash
   cp .env.example .env
   ```
   
   **Required Variables:**
   * `DISCORD_BOT_TOKEN`: The token from your Discord Developer Portal.
   * `ALLOWED_USER_ID`: Your personal Discord User ID to ensure the bot only responds to you.
   * `OPENROUTER_API_KEY`: Your OpenRouter API key to query the LLM.
   * `SUPABASE_URL`: The base URL of your Supabase project (e.g. `https://your-project.supabase.co`).
   * `SUPABASE_ANON_KEY`: The anonymous key for your Supabase project to authenticate REST requests for history and memory.
   * `MCP_SERVER_URL`: The deployed URL for your Supabase MCP Edge Function.
   * `MCP_ACCESS_KEY`: The key (`x-brain-key`) used to authenticate the OpenRouter MCP tool calls to your edge function.

## Running

Start the bot locally:

```bash
npm start
```

## Features

* **Direct Message Support:** Uses `discord.js` (with partials) to reliably listen for and respond to your DMs exclusively.
* **LLM Powered:** Uses OpenRouter APIs.
* **Supabase History:** Saves and loads a sliding window of previous messages from a Supabase database.
* **MCP Tool Integration:** Automatically passes an MCP tool specification to OpenRouter, allowing the LLM to trigger edge function tools on your network.
* **Proactive Memory Capture:** Automatically evaluates the conversation every 20 messages to find insights, decisions, or action items, and prompts you in Discord to save them directly to your knowledge base (`save 1, 2` or `skip`).
* **Long Message Handling:** Automatically splits chunked replies greater than Discord's 2000-character limit.
