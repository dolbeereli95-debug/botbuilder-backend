const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic();

app.use(cors());
app.use(express.json({ limit: '50kb' }));

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'BotBuilder API', version: '1.0.0' });
});

app.post('/chat', async (req, res) => {
  const { messages, systemPrompt } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  if (!systemPrompt || typeof systemPrompt !== 'string') {
    return res.status(400).json({ error: 'systemPrompt is required' });
  }
  const cleanMessages = messages
    .filter(m => m && typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
    .slice(-20);
  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages found' });
  }
  if (cleanMessages[0].role !== 'user') {
    return res.status(400).json({ error: 'First message must be from user' });
  }
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemPrompt,
      messages: cleanMessages,
    });
    const reply = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');
    res.json({ reply });
  } catch (err) {
    console.error('[Chat Error]', err.message);
    if (err.status === 401) return res.status(500).json({ error: 'API authentication failed' });
    if (err.status === 429) return res.status(429).json({ reply: "I'm a little busy right now — please try again in a moment!" });
    res.status(500).json({ reply: "Sorry, I'm having trouble connecting right now. Please try again or contact us directly." });
  }
});

app.post('/generate', async (req, res) => {
  const { clientData, systemPromptRequest: customSystemPrompt } = req.body;
  if (!clientData || typeof clientData !== 'string' || clientData.length < 50) {
    return res.status(400).json({ error: 'clientData is required' });
  }
  const systemPromptRequest = customSystemPrompt || 'You are a bot-building expert. Given client business data, generate a complete, production-ready AI chatbot system prompt for a customer-facing FAQ bot. The system prompt you write must: Start with the bot name and role, include all business details naturally woven in, know all the FAQs and answers, understand the services pricing and hours, follow the specified tone exactly, know what to never say, know the fallback behavior, be written as if speaking directly to the AI model in second person, be professional thorough and immediately usable with no editing needed, and end with a reminder to keep responses concise and helpful. Only output the system prompt text, nothing else. No preamble, no explanation.';
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

app.post('/lead', async (req, res) => {
  const { name, phone, jobType, urgency, businessEmail, businessName } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail is required' });
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: businessEmail,
        subject: 'New Lead from ' + (businessName || 'your website'),
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px;"><h2>New Lead Captured</h2><p style="color:#555;font-size:14px;">Someone just reached out through your website chat.</p><div style="background:white;border-radius:10px;padding:20px;border:1px solid #e5e7eb;"><p><strong>Name:</strong> ' + (name || 'Not provided') + '</p><p><strong>Phone:</strong> ' + (phone || 'Not provided') + '</p><p><strong>Job Type:</strong> ' + (jobType || 'Not specified') + '</p><p><strong>Urgency:</strong> ' + (urgency || 'Not specified') + '</p></div><p style="color:#999;font-size:12px;margin-top:20px;text-align:center;">Sent by Netify Builds</p></div>',
      }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Email send failed' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Lead Error]', err.message);
    res.status(500).json({ error: 'Lead capture failed' });
  }
});

app.post('/review-lead', async (req, res) => {
  const { name, contact, feedback, businessEmail, businessName } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail is required' });
  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: businessEmail,
        subject: 'Private Feedback Received - ' + (businessName || 'your business'),
        html: '<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fff7ed;border-radius:12px;border:1px solid #fed7aa;"><h2 style="color:#c2410c;">Private Feedback Alert</h2><p style="color:#555;font-size:14px;">A customer left private feedback after their job. Reach out before this becomes a public review.</p><div style="background:white;border-radius:10px;padding:20px;border:1px solid #e5e7eb;"><p><strong>Name:</strong> ' + (name || 'Not provided') + '</p><p><strong>Contact:</strong> ' + (contact || 'Not provided') + '</p><p><strong>Feedback:</strong> ' + (feedback || 'Not provided') + '</p></div><p style="color:#c2410c;font-size:13px;margin-top:16px;">A quick follow-up call can often prevent a bad Google review.</p><p style="color:#999;font-size:12px;margin-top:20px;text-align:center;">Sent by Netify Builds</p></div>',
      }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Email send failed' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Review-Lead Error]', err.message);
    res.status(500).json({ error: 'Review lead capture failed' });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log('BotBuilder backend running on port ' + PORT);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  if (!process.env.RESEND_API_KEY) console.warn('WARNING: RESEND_API_KEY not set!');
});
