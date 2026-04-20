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

  // Inject current date/time so bot knows if it's after hours
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' });
  const timeInjection = `\n\nCURRENT DATE AND TIME: ${now} (Eastern Time). Use this to determine if the business is currently open or closed based on the business hours above.`;
  const enrichedPrompt = systemPrompt + timeInjection;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: enrichedPrompt,
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
  const systemPromptRequest = customSystemPrompt || `You are a bot-building expert. Given client business data, generate a complete, production-ready AI chatbot system prompt for a customer-facing FAQ and lead generation bot.

The system prompt you write must:
- Start with the bot name and role
- Include all business details naturally woven in
- Know all the FAQs and answers thoroughly
- Understand the services, pricing, and hours
- Follow the specified tone exactly
- Know what to never say
- Include after-hours behavior: the bot should know the business hours and when someone contacts outside those hours, acknowledge it warmly and let them know the team will follow up first thing when they open — while still capturing the lead
- Include clear lead capture instructions: naturally collect name, phone number, job type, and urgency through conversation. Once name AND phone are collected, output this exact trigger at the very end of the response: LEAD_CAPTURED|[name]|[phone]|[job type or Not specified]|[urgency or Not specified]. The trigger must always use this exact format with pipe separators and no extra spaces. Never show the trigger to the customer. Never ask for contact info again if already collected in the conversation.
- Be written as if speaking directly to the AI model in second person
- Be professional, thorough, and immediately usable with no editing needed
- End with a reminder to keep responses concise and helpful

Only output the system prompt text, nothing else. No preamble, no explanation.`;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
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

app.post('/signup', async (req, res) => {
  const { ownerName, bizName, email, phone, website, industry, area, hours, services, faqs, tone, package: pkg, differentiators, licensing, emergency, seasonal, botPersonality } = req.body;
  if (!email || !bizName) return res.status(400).json({ error: 'email and bizName are required' });

  const pkgLabel = pkg === 'bundle' ? 'Full Bundle — $350/mo' : 'Website AI Bot — $225/mo';
  const botName = botPersonality && botPersonality !== 'Not provided' ? botPersonality : bizName + ' Assistant';

  const botBuilderData = [
    '===== BOTBUILDER CLIENT DATA =====', '',
    'BUSINESS NAME: ' + (bizName || 'Not provided'),
    'BOT NAME: ' + botName,
    'OWNER NAME: ' + (ownerName || 'Not provided'),
    'OWNER EMAIL: ' + (email || 'Not provided'),
    'OWNER PHONE: ' + (phone || 'Not provided'),
    'WEBSITE: ' + (website || 'Not provided'), '',
    'INDUSTRY: ' + (industry || 'Not provided'),
    'PACKAGE SELECTED: ' + pkgLabel, '',
    'SERVICES OFFERED:', (services || 'Not provided'), '',
    'BUSINESS HOURS: ' + (hours || 'Not provided'),
    'SERVICE AREA: ' + (area || 'Not provided'), '',
    'FREQUENTLY ASKED QUESTIONS:', (faqs || 'Not provided'), '',
    'WHAT SETS THEM APART:', (differentiators && differentiators !== 'Not provided' ? differentiators : 'Not provided'), '',
    'LICENSING / INSURANCE / WARRANTY: ' + (licensing && licensing !== 'Not provided' ? licensing : 'Not provided'),
    'EMERGENCY SERVICES: ' + (emergency && emergency !== 'Not provided' ? emergency : 'Not provided'),
    'SEASONAL NOTES: ' + (seasonal && seasonal !== 'Not provided' ? seasonal : 'Not provided'), '',
    'BOT TONE: ' + (tone || 'Friendly and casual'),
    'BOT PERSONALITY NAME: ' + botName, '',
    '===== END OF CLIENT DATA ====='
  ].join('\n');

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'dolbeereli95@gmail.com',
        subject: '🚀 New Signup: ' + bizName + ' — ' + pkgLabel,
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f9fafb;border-radius:12px;">
          <h2 style="color:#0A2540;margin-bottom:4px;">New Client Signup</h2>
          <p style="color:#64748b;font-size:14px;margin-bottom:24px;">Someone just signed up on your website. Here's everything you need to build their bot.</p>
          <div style="background:white;border-radius:10px;padding:20px;border:1px solid #e5e7eb;margin-bottom:20px;">
            <p style="margin:0 0 8px"><strong>Name:</strong> ${ownerName || 'Not provided'}</p>
            <p style="margin:0 0 8px"><strong>Business:</strong> ${bizName}</p>
            <p style="margin:0 0 8px"><strong>Email:</strong> ${email}</p>
            <p style="margin:0 0 8px"><strong>Phone:</strong> ${phone || 'Not provided'}</p>
            <p style="margin:0 0 8px"><strong>Website:</strong> ${website || 'Not provided'}</p>
            <p style="margin:0"><strong>Package:</strong> ${pkgLabel}</p>
          </div>
          <div style="background:#0A2540;border-radius:10px;padding:20px;">
            <p style="color:#93C5FD;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">BotBuilder Data — paste directly into builder tool</p>
            <pre style="color:#e2e8f0;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin:0;font-family:monospace;">${botBuilderData}</pre>
          </div>
          <p style="color:#999;font-size:12px;margin-top:20px;text-align:center;">Sent by Netify Builds</p>
        </div>`,
      }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Email send failed' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Signup Error]', err.message);
    res.status(500).json({ error: 'Signup email failed' });
  }
});


app.post('/scan', async (req, res) => {
  const { url, botType, leadEmail, tone } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });
  const botTone = tone || 'Friendly and casual';

  try {
    // Fetch the website
    const siteRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BotBuilder/1.0)' },
      signal: AbortSignal.timeout(10000)
    });
    if (!siteRes.ok) return res.status(400).json({ error: 'Could not fetch that URL. Make sure it is publicly accessible.' });

    const html = await siteRes.text();

    // Strip HTML tags down to readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .trim()
      .substring(0, 12000); // cap at 12k chars to stay within token limits

    if (text.length < 100) return res.status(400).json({ error: 'Not enough content found on that page. Try a different URL.' });

    // Use Claude to extract business data and generate system prompt in one step
    const isLeadGen = botType === 'leadgen';
    const scanPrompt = `You are a bot-building expert. A business website has been scraped and the text content is below. 

Your job is to:
1. Extract all useful business information (name, services, hours, location, FAQs, pricing, contact info, what makes them unique, emergency services, licensing)
2. Use that information to generate a complete, production-ready AI chatbot system prompt for a customer-facing ${isLeadGen ? 'Lead Generation' : 'FAQ'} bot

The system prompt you write must:
- Start with the bot name and role (use the business name you find)
- Include all business details naturally woven in
- Know all the services, FAQs, hours, pricing mentioned on the site
- Follow a ${botTone} tone throughout every interaction
- Know what to never say (never quote prices not on the site, never mention competitors)
- Include after-hours behavior based on the hours found
${isLeadGen ? `- Include lead capture: naturally collect name and phone number, then output LEAD_CAPTURED|[name]|[phone]|[job type or Not specified]|[urgency or Not specified] at the very end of the response. Never show this trigger to the customer. Never ask for contact info again once collected.` : '- Know the fallback behavior (direct to phone/email when it cannot answer)'}
- Be written in second person (You are...)
- Be professional, thorough, and immediately usable
- End with a reminder to keep responses concise and helpful

Only output the system prompt text. Nothing else. No preamble, no explanation, no markdown headers.

WEBSITE CONTENT:
${text}`;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      messages: [{ role: 'user', content: scanPrompt }],
    });

    const systemPrompt = response.content.filter(b => b.type === 'text').map(b => b.text).join('');

    if (!systemPrompt) return res.status(500).json({ error: 'Failed to generate prompt from website content.' });

    // Try to extract business name for widget generation
    const bizNameMatch = systemPrompt.match(/You are ([^,\.]+)/i);
    const bizName = bizNameMatch ? bizNameMatch[1].replace(/the |assistant|bot/gi, '').trim() : 'Business';

    res.json({ prompt: systemPrompt, bizName, url });

  } catch (err) {
    console.error('[Scan Error]', err.message);
    if (err.name === 'TimeoutError') return res.status(400).json({ error: 'Website took too long to load. Try again or use the manual form.' });
    res.status(500).json({ error: 'Scan failed: ' + err.message });
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
