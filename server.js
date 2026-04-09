// BotBuilder Backend Server v2
// Deploy this ONCE on Railway.app (or Render.com) — it handles ALL your clients.
// 
// Setup:
//   npm install
//   Set env var: ANTHROPIC_API_KEY=your_key_here
//   node server.js
//
// Railway deploy:
//   1. Push this folder to a GitHub repo
//   2. Connect repo to railway.app
//   3. Add env var ANTHROPIC_API_KEY in Railway dashboard
//   4. Deploy — Railway auto-detects Node and runs npm start

const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Anthropic client (uses ANTHROPIC_API_KEY env var automatically)
const anthropic = new Anthropic();

// Middleware
app.use(cors()); // Allows any website to use this backend
app.use(express.json({ limit: '50kb' }));

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'BotBuilder API', version: '1.0.0' });
});

// Main chat endpoint — called by every widget on every client site
app.post('/chat', async (req, res) => {
  const { messages, systemPrompt } = req.body;

  // Basic validation
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'systemPrompt is required' });
  }

  // Sanitize messages — only allow valid roles
  const cleanMessages = messages
    .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
    .slice(-20); // Keep last 20 messages max to control token costs

  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages found' });
  }

  // Make sure conversation starts with user message (Claude API requirement)
  if (cleanMessages[0].role !== 'user') {
    return res.status(400).json({ error: 'First message must be from user' });
  }

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', // Haiku = fast + cheap for FAQ bots
      max_tokens: 500, // Keep responses concise for chat widgets
      system: systemPrompt,
      messages: cleanMessages,
    });

    const reply = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    res.json({ reply });

  } catch (err) {
    console.error('[Claude API Error]', err.message);

    // Don't leak internal errors to clients
    if (err.status === 401) {
      return res.status(500).json({ error: 'API authentication failed — check your API key' });
    }
    if (err.status === 429) {
      return res.status(429).json({ reply: "I'm a little busy right now — please try again in a moment!" });
    }

    res.status(500).json({ reply: "Sorry, I'm having trouble connecting right now. Please try again or contact us directly." });
  }
});

// Generate endpoint — called by the builder tool to create system prompts
app.post('/generate', async (req, res) => {
  const { clientData } = req.body;

  if (!clientData || typeof clientData !== 'string' || clientData.length < 50) {
    return res.status(400).json({ error: 'clientData is required' });
  }

  const systemPromptRequest = `You are a bot-building expert. Given client business data, generate a complete, production-ready AI chatbot system prompt for a customer-facing FAQ bot.

The system prompt you write must:
- Start with the bot's name and role
- Include all business details naturally woven in
- Know all the FAQs and answers
- Understand the services, pricing, and hours
- Follow the specified tone exactly
- Know what to never say
- Know the fallback behavior (what to do when it can't answer)
- Be written as if speaking directly to the AI model (second person: "You are...")
- Be professional, thorough, and immediately usable with no editing needed
- End with a reminder to keep responses concise and helpful

Only output the system prompt text, nothing else. No preamble, no explanation.`;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPromptRequest,
      messages: [{ role: 'user', content: clientData }],
    });

    const generatedPrompt = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    res.json({ prompt: generatedPrompt });

  } catch (err) {
    console.error('[Generate Error]', err.message);
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});
app.post('/generate', async (req, res) => {
  const { clientData } = req.body;
  if (!clientData || typeof clientData !== 'string' || clientData.length < 50) {
    return res.status(400).json({ error: 'clientData is required' });
  }
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: 'You are a bot-building expert. Generate a complete system prompt for a customer FAQ bot. Output only the system prompt, nothing else.',
      messages: [{ role: 'user', content: clientData }],
    });
    const generatedPrompt = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    res.json({ prompt: generatedPrompt });
  } catch (err) {
    res.status(500).json({ error: 'Generation failed: ' + err.message });
  }
});
// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log(`✅ BotBuilder backend running on port ${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('⚠️  WARNING: ANTHROPIC_API_KEY not set! Requests will fail.');
  }
});
