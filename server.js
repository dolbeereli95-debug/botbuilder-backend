const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic();

app.use(cors());
app.use(express.json({ limit: '50kb' }));

// ── RATE LIMITER — max 30 /chat requests per IP per hour ──
const rateLimitMap = {};
function rateLimit(req, res, next) {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  if (!rateLimitMap[ip]) rateLimitMap[ip] = [];
  rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60 * 60 * 1000);
  if (rateLimitMap[ip].length >= 30) {
    return res.status(429).json({ reply: "You've sent a lot of messages — please wait a bit before trying again." });
  }
  rateLimitMap[ip].push(now);
  next();
}
// Clean up old entries every hour
setInterval(function() {
  const now = Date.now();
  Object.keys(rateLimitMap).forEach(ip => {
    rateLimitMap[ip] = rateLimitMap[ip].filter(t => now - t < 60 * 60 * 1000);
    if (rateLimitMap[ip].length === 0) delete rateLimitMap[ip];
  });
}, 60 * 60 * 1000);

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'BotBuilder API', version: '1.0.0' });
});

app.post('/chat', rateLimit, async (req, res) => {
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
- Include a strict instruction that the bot must NEVER use markdown formatting, bullet points, bold text, headers, or emojis in any response. Plain conversational sentences only — no asterisks, no dashes as bullets, no pound signs, nothing. Just natural human-sounding text.
- Include after-hours behavior: the bot should know the business hours and when someone contacts outside those hours, acknowledge it warmly and let them know the team will follow up first thing when they open — while still capturing the lead
- Include clear lead capture instructions: naturally collect name, phone number, job type, and urgency through conversation. Once name AND phone are collected, output this exact trigger at the very end of the response: LEAD_CAPTURED|[name]|[phone]|[job type or Not specified]|[urgency or Not specified]. The trigger must always use this exact format with pipe separators and no extra spaces. Never show the trigger to the customer. Never ask for contact info again if already collected in the conversation.
- Include emergency escalation behavior: if the customer's message signals a true emergency (e.g. no heat, burst pipe, flooding, gas smell, complete power outage, or any urgent safety issue), the bot should immediately tell them to call the business directly at the emergency phone number provided in the client data. Do not just capture the lead for emergencies — push them to call now. If no emergency number is listed, still flag it as urgent and say someone will call them back as soon as possible. For non-urgent inquiries, always capture the lead normally.
- Include appointment handling: if a customer asks to book, schedule, or make an appointment, the bot should NOT confirm or schedule it directly. Instead collect their name and phone number and let them know someone will call them shortly to get them booked.
- Include competitor handling: if a customer asks how the business compares to a competitor or mentions a competitor by name, the bot should stay neutral, never speak negatively about competitors, and redirect the conversation to the business's own strengths and what makes them a great choice.
- Include multi-language support: if a customer writes in any language other than English, the bot must respond in that same language naturally and fluently. Never force the customer to communicate in English.
- Include off-topic and inappropriate question handling: if someone asks anything unrelated to the business — personal questions, political opinions, inappropriate or offensive questions — redirect naturally and briefly without making a big deal of it. Vary the redirect phrasing each time — never repeat the same phrase. Keep it light, one sentence, then offer to help with something real. Never lecture or refuse rudely.
- Include handling for questions about future plans or unknown information: if someone asks about future products or anything not covered in the business data, say honestly that you are not sure but offer to have the owner follow up directly. Never speculate or make things up.
- Include personality variation: vary responses naturally — never repeat the same phrases or sentence structures. Sound like a real person having a conversation, not a bot running through scripts.
- Be written as if speaking directly to the AI model in second person
- Be professional, thorough, and immediately usable with no editing needed
- Include a strict instruction that the bot must keep every response to 2-3 sentences maximum unless the question genuinely requires more detail. The bot should never send walls of text — short, clear, conversational replies only.

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
        bcc: 'dolbeereli95@gmail.com',
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
  const { ownerName, bizName, email, phone, website, industry, area, hours, services, faqs, tone, package: pkg, differentiators, licensing, emergency, seasonal, botPersonality, billing, hearAbout, googleReviewLink } = req.body;
  if (!email || !bizName) return res.status(400).json({ error: 'email and bizName are required' });

  const pkgLabel = pkg === 'bundle' ? 'Full Bundle — $350/mo' : pkg === 'review' ? 'Review Manager — $150/mo' : 'Website AI Bot — $225/mo';
  const billingLabel = billing === 'annual' ? 'Annual (1 month free)' : 'Monthly';
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
    'PACKAGE SELECTED: ' + pkgLabel,
    'BILLING: ' + billingLabel,
    'HEARD ABOUT US: ' + (hearAbout || 'Not provided'), '',
    'SERVICES OFFERED:', (services || 'Not provided'), '',
    'BUSINESS HOURS: ' + (hours || 'Not provided'),
    'SERVICE AREA: ' + (area || 'Not provided'), '',
    'FREQUENTLY ASKED QUESTIONS:', (faqs || 'Not provided'), '',
    'WHAT SETS THEM APART:', (differentiators && differentiators !== 'Not provided' ? differentiators : 'Not provided'), '',
    'LICENSING / INSURANCE / WARRANTY: ' + (licensing && licensing !== 'Not provided' ? licensing : 'Not provided'),
    'EMERGENCY SERVICES: ' + (emergency && emergency !== 'Not provided' ? emergency : 'Not provided'),
    'SEASONAL NOTES: ' + (seasonal && seasonal !== 'Not provided' ? seasonal : 'Not provided'), '',
    'GOOGLE REVIEW LINK: ' + (googleReviewLink || 'Not provided'),
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
            <p style="margin:0 0 8px"><strong>Package:</strong> ${pkgLabel}</p>
            <p style="margin:0 0 8px"><strong>Billing:</strong> ${billingLabel}</p>
            <p style="margin:0"><strong>Heard about us:</strong> ${hearAbout || 'Not provided'}</p>
          </div>
          <div style="background:#0A2540;border-radius:10px;padding:20px;">
            <p style="color:#93C5FD;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">BotBuilder Data — paste directly into builder tool</p>
            <pre style="color:#e2e8f0;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin:0;font-family:monospace;">${botBuilderData}</pre>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-top:16px;">
            <p style="color:#15803d;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 10px;">Your next steps</p>
            <ol style="color:#374151;font-size:13px;line-height:2;margin:0;padding-left:18px;">
              <li>Reply to confirm the order and send the Stripe payment link</li>
              ${pkg !== 'review' ? '<li>Open builder-FINAL.html and paste the BotBuilder data above to generate their bot</li>' : ''}
              ${pkg !== 'review' ? '<li>Install the widget on their website (or send install instructions)</li>' : ''}
              ${pkg === 'review' || pkg === 'bundle' ? '<li>Customize review-page.html with their business name, Google link, alert email, and brand color — then deploy to Cloudflare Pages at netifybuilds.pages.dev/review/clientname</li>' : ''}
              <li>Send them a confirmation that everything is live</li>
              <li>Set a reminder to check in after 7 days</li>
            </ol>
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
  const { name, contact, feedback, transcript, urgent, businessEmail, businessName } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail is required' });

  const subjectPrefix = urgent ? '🚨 URGENT — ' : '⚠️ ';
  const transcriptHtml = transcript
    ? transcript.map(function(m) {
        const isBot = m.role === 'bot';
        return '<div style="margin-bottom:8px;display:flex;flex-direction:column;align-items:' + (isBot ? 'flex-start' : 'flex-end') + '"><div style="max-width:85%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;background:' + (isBot ? '#f1f5f9;color:#0f172a' : '#2563eb;color:white') + '">' + m.text + '</div><div style="font-size:10px;color:#94a3b8;margin-top:3px;">' + (isBot ? 'Bot' : 'Customer') + '</div></div>';
      }).join('')
    : '<p style="color:#94a3b8;font-size:13px;">No transcript available</p>';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: businessEmail,
        subject: subjectPrefix + 'Private Feedback — ' + (businessName || 'your business'),
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff7ed;border-radius:12px;border:1px solid #fed7aa;">
          ${urgent ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;font-weight:600;color:#dc2626;">⚠️ This feedback contains urgent language — respond as soon as possible.</div>' : ''}
          <h2 style="color:#c2410c;margin-bottom:4px;">Private Feedback Received</h2>
          <p style="color:#555;font-size:14px;margin-bottom:20px;">A customer left private feedback. This has not been posted publicly.</p>
          <div style="background:white;border-radius:10px;padding:16px 20px;border:1px solid #e5e7eb;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name || 'Not provided'}</p>
            <p style="margin:0 0 8px;font-size:14px;"><strong>Contact:</strong> ${contact || 'Not provided'}</p>
            <p style="margin:0;font-size:14px;"><strong>Issue:</strong> ${feedback || 'Not provided'}</p>
          </div>
          <div style="margin-bottom:20px;">
            <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:10px;">Full Conversation</p>
            <div style="background:white;border-radius:10px;padding:16px;border:1px solid #e5e7eb;">${transcriptHtml}</div>
          </div>
          <p style="color:#c2410c;font-size:13px;font-weight:600;">A quick follow-up call can often prevent a bad Google review.</p>
          <p style="color:#999;font-size:12px;margin-top:16px;text-align:center;">Sent by Netify Builds</p>
        </div>`
      }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Email send failed' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Review-Lead Error]', err.message);
    res.status(500).json({ error: 'Review lead capture failed' });
  }
});

// Simple in-memory store for review logs (persists until server restarts)
// For production you'd use a database, but this works fine for low volume
const reviewLogs = {};

app.post('/log-review', (req, res) => {
  const { businessName, type, feedback, contact, date } = req.body;
  if (!businessName) return res.status(400).json({ error: 'businessName required' });
  const key = businessName.toLowerCase().replace(/\s+/g, '_');
  if (!reviewLogs[key]) reviewLogs[key] = [];
  reviewLogs[key].push({ type, feedback, contact, date: date || new Date().toISOString() });
  console.log('[Review Log]', businessName, type);
  res.json({ success: true });
});

app.get('/review-report/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase();
  const logs = reviewLogs[key] || [];
  const positive = logs.filter(r => r.type === 'positive').length;
  const negative = logs.filter(r => r.type === 'negative').length;
  const feedback = logs.filter(r => r.type === 'negative' && r.feedback).map(r => ({
    feedback: r.feedback,
    contact: r.contact,
    date: r.date
  }));
  res.json({ businessKey: key, total: logs.length, positive, negative, negativeFeedback: feedback });
});


app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

app.listen(PORT, () => {
  console.log('BotBuilder backend running on port ' + PORT);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  if (!process.env.RESEND_API_KEY) console.warn('WARNING: RESEND_API_KEY not set!');
});
