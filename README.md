# Open Brain Chat Relay

A small Node.js chat relay (Discord Bot) designed to serve up and interact with the Open Brain Supabase MCP edge functions.

## Overview

This project acts as an intermediary, receiving messages from Discord via Direct Messages, and forwarding them to a specific Supabase Edge Function that powers an interactive chat interface. It then streams or paginates the response back into the Discord channel.

## Setup

1. Clone the repository and install dependencies:
   ```bash
   npm install
   ```

2. Configure Environment Variables:
   Copy `.env.example` to `.env` and populate the required variables:
   ```bash
   cp .env.example .env
   ```
   
   **Required Variables:**
   * `DISCORD_BOT_TOKEN`: The token from your Discord Developer Portal.
   * `ALLOWED_USER_ID`: Your personal Discord User ID (to ensure the bot only responds to you).
   * `CHAT_FUNCTION_URL`: The deployed URL for your Supabase Edge Function.
   * `SUPABASE_ANON_KEY`: The legacy anonymous key for your Supabase project (used to authenticate requests to the Edge Function).

## Running

Start the relay locally:

```bash
npm start
```

## Features

* **Direct Message Support:** Uses `discord.js` (with partials) to reliably listen for and respond to DMs.
* **Supabase Integration:** Securely forwards messages and the `discord_user_id` to your edge function using Bearer Token authentication.
* **Security:** Strict validation of the sender against an `ALLOWED_USER_ID` environment variable.
* **Long Message Handling:** Automatically splits chunked replies greater than Discord's 2000-character limit.
