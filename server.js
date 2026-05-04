const express = require('express');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const anthropic = new Anthropic();

// ── PERSISTENT FILE STORAGE ──
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
console.log('[Storage] Data directory:', DATA_DIR, process.env.RAILWAY_VOLUME_MOUNT_PATH ? '(Railway volume ✓)' : '(local fallback — data resets on redeploy)');

function loadData(filename, defaultValue) {
  const filepath = path.join(DATA_DIR, filename);
  try {
    if (fs.existsSync(filepath)) return JSON.parse(fs.readFileSync(filepath, 'utf8'));
  } catch(e) { console.error('[Data load error]', filename, e.message); }
  return defaultValue;
}

function saveData(filename, data) {
  const filepath = path.join(DATA_DIR, filename);
  try { fs.writeFileSync(filepath, JSON.stringify(data, null, 2)); }
  catch(e) { console.error('[Data save error]', filename, e.message); }
}

// Debounced save — batches rapid writes into one disk write per second
const saveTimers = {};
function debouncedSave(filename, data) {
  clearTimeout(saveTimers[filename]);
  saveTimers[filename] = setTimeout(function() { saveData(filename, data); }, 1000);
}

app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      'https://netifybuilds.pages.dev',
      'http://localhost',
      'http://127.0.0.1',
      null // allow requests with no origin (mobile apps, curl, local files)
    ];
    if (!origin || allowed.some(function(a) { return !origin || origin === a || origin.startsWith('http://localhost') || origin.startsWith('http://127.0.0.1') || origin.includes('netifybuilds'); })) {
      callback(null, true);
    } else {
      callback(null, true); // keep open for now — lock down after first client
    }
  }
}));
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
    .slice(-10);
  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages found' });
  }
  // Ensure conversation starts with a user message
  const firstUserIdx = cleanMessages.findIndex(m => m.role === 'user');
  const trimmedMessages = firstUserIdx > 0 ? cleanMessages.slice(firstUserIdx) : cleanMessages;
  if (trimmedMessages.length === 0 || trimmedMessages[0].role !== 'user') {
    return res.status(400).json({ error: 'No valid user message found' });
  }

  // Inject current date/time so bot knows if it's after hours
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'full', timeStyle: 'short' });
  const timeInjection = `\n\nCURRENT DATE AND TIME: ${now} (Eastern Time). Use this to determine if the business is currently open or closed based on the business hours above.\n\nREMINDER: Keep your response to 2-3 short sentences maximum. If a customer asks about multiple things, answer the most important one and ask a follow-up. Never write more than 4 sentences under any circumstances. Short, conversational, human.`;
  const enrichedPrompt = systemPrompt + timeInjection;

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: enrichedPrompt,
      messages: trimmedMessages,
    });
    const reply = response.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('');

    // ── MISSED LEAD DETECTION ──
    // If the reply doesn't have LEAD_CAPTURED but contains what looks like
    // a phone number and name together, flag it as a potential missed capture
    if (!reply.includes('LEAD_CAPTURED|')) {
      const hasPhone = /(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/.test(reply);
      const hasName = /(?:my name is|i'm|i am|this is)\s+[A-Z][a-z]+/i.test(reply);
      const lastUserMsg = trimmedMessages[trimmedMessages.length - 1]?.content || '';
      const userHasPhone = /(\(?\d{3}\)?[\s\-.]?\d{3}[\s\-.]?\d{4})/.test(lastUserMsg);
      const userHasName = /(?:my name is|i'm|i am|this is|name's)\s+[A-Z][a-z]+/i.test(lastUserMsg);

      if (userHasPhone && userHasName) {
        // Customer provided both — bot should have triggered LEAD_CAPTURED but didn't
        const bizName = systemPrompt.match(/for ([^,\.]+)/)?.[1] || 'Unknown Business';
        console.warn('[MISSED LEAD DETECTED]', bizName, '| User message:', lastUserMsg.substring(0, 100));
        // Fire alert to owner email if we can extract it from system prompt
        const emailMatch = systemPrompt.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
        if (emailMatch) {
          fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'onboarding@resend.dev',
              to: emailMatch[0],
              bcc: 'dolbeereli95@gmail.com',
              subject: '⚠️ Possible missed lead — ' + bizName,
              html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#fffbeb;border-radius:12px;border:1px solid #fde68a;">
                <h2 style="color:#b45309;margin-bottom:8px;">Possible Missed Lead</h2>
                <p style="color:#555;font-size:14px;margin-bottom:16px;">A customer may have provided their contact info but the lead wasn't captured automatically. Review the conversation below.</p>
                <div style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;font-size:13px;color:#374151;line-height:1.7;">
                  <strong>Customer message:</strong><br>${lastUserMsg}
                </div>
                <p style="color:#b45309;font-size:13px;margin-top:16px;font-weight:600;">Follow up with this customer directly if possible.</p>
                <p style="color:#999;font-size:12px;margin-top:16px;text-align:center;">Sent by Netify Builds</p>
              </div>`
            })
          }).catch(() => {});
        }
      }
    }

    res.json({ reply });
  } catch (err) {
    console.error('[Chat Error]', err.message);
    if (err.status === 401) return res.status(500).json({ error: 'API authentication failed' });
    if (err.status === 429) return res.status(429).json({ reply: "I'm a little busy right now — please try again in a moment!" });
    res.status(500).json({ reply: "Sorry, I'm having trouble connecting right now. Please try again or contact us directly." });
  }
});

app.post('/generate', async (req, res) => {
  const { clientData, systemPromptRequest: customSystemPrompt, features } = req.body;
  if (!clientData || typeof clientData !== 'string' || clientData.length < 50) {
    return res.status(400).json({ error: 'clientData is required' });
  }

  // Build feature-specific additions based on what client selected
  const featureList = (features || '').toLowerCase();
  const hasAppointment = featureList.includes('appointment');
  const hasEmergency = featureList.includes('emergency');
  const hasMultilang = featureList.includes('multilanguage') || featureList.includes('multilang');
  const hasPricing = featureList.includes('pricing');
  const hasWorkout = featureList.includes('workout');
  const hasGroomer = featureList.includes('groomer') || featureList.includes('pet intake');
  const hasAutoSymptom = featureList.includes('symptom') || featureList.includes('autosymptom');
  const hasMoving = featureList.includes('moving') || featureList.includes('move estimator');
  const hasCleaning = featureList.includes('cleaning') || featureList.includes('quote estimator');

  const featureInstructions = [
    hasEmergency ? '- EMERGENCY ESCALATION: If the customer signals a true emergency (no heat, burst pipe, gas smell, flooding, power outage, urgent safety issue), immediately tell them to call the emergency number directly. Do not just capture the lead — push them to call now.' : '- Do not treat after-hours inquiries as emergencies unless explicitly stated. Capture leads normally.',
    hasAppointment ? '- APPOINTMENT FLOW: When a customer asks to book or schedule, collect their preferred day, time, and reason. Do NOT confirm the appointment — tell them someone will call to confirm. Email this as a formatted appointment request.' : '',
    hasMultilang ? '- MULTILANGUAGE: Detect and respond in whatever language the customer writes in. Never force English.' : '',
    hasPricing ? '- PRICING GUIDE: When asked about cost, don\'t just say "it depends." Walk the customer through the key factors that affect price for their specific situation and give a realistic ballpark range based on the business\'s pricing data.' : '',
    hasWorkout ? '- WORKOUT SPLIT BUILDER: When someone asks about training, programs, or getting started, guide them through a short conversation: ask their main goal (lose weight / build muscle / improve endurance), experience level (beginner / intermediate / advanced), days per week available, and equipment access. Then provide a clear personalized weekly workout split — e.g. "Push/Pull/Legs" or "Full Body 3x" — described in plain sentences, no markdown. After delivering the split, naturally suggest they speak with a trainer at the gym to refine it and capture their name and number.' : '',
    hasGroomer ? '- PET INTAKE QUALIFIER: When a customer asks about grooming, ask about their pet\'s breed, size (small/medium/large), coat type (short/medium/long/double coat), and whether the pet is anxious or has any sensitivities. Based on their answers, tell them what service level they likely need, approximate time, and what to expect. Then capture their name and number to book.' : '',
    hasAutoSymptom ? '- SYMPTOM CHECKER: When a customer describes a car problem — noise, warning light, vibration, smell, or handling issue — ask 1-2 clarifying questions (when it happens, which part of the car, how long it\'s been going on). Then give a plain-English explanation of the most likely cause and a realistic cost range. Always suggest they bring it in for a free inspection and capture their name and number.' : '',
    hasMoving ? '- MOVE ESTIMATOR: When someone asks about moving services or a quote, walk them through: number of rooms or bedrooms, moving distance (local/long distance), what floor they\'re on, any large or specialty items (piano, safe, etc.), and preferred timing. Give a realistic cost range based on typical rates and note factors that affect price. Then capture their name and number for a formal quote.' : '',
    hasCleaning ? '- QUOTE ESTIMATOR: When someone asks about cleaning services or pricing, ask about: square footage or number of bedrooms/bathrooms, type of cleaning (standard/deep/move-in/move-out), frequency they want (one-time/weekly/biweekly/monthly), and any pets or special requests. Give a realistic price range and mention available time slots. Then capture their name and number to book.' : '',
  ].filter(Boolean).join('\n');

  const systemPromptRequest = customSystemPrompt || `You are a bot-building expert. Given client business data, generate a complete, production-ready 24/7 chat assistant system prompt for a customer-facing FAQ and lead generation bot.

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
- Include competitor handling: stay neutral, never speak negatively about competitors, redirect to the business's strengths.
- Include off-topic handling: redirect naturally and briefly, vary phrasing each time, keep it one sentence.
- Include personality variation: vary responses naturally, sound like a real person.
- Be written as if speaking directly to the AI model in second person
- Include a strict instruction that the bot must keep every response to 2-3 sentences maximum. Short, clear, conversational replies only.
${featureInstructions ? '\nCLIENT-SELECTED FEATURES — include these behaviors:\n' + featureInstructions : ''}

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
  const { name, phone, jobType, urgency, businessEmail, businessName, ownerPhone, conversation } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail is required' });

  // ── SMS ALERT (Twilio) ──
  if (ownerPhone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    try {
      const smsBody = `New lead from your website!\nName: ${name || 'Unknown'}\nPhone: ${phone || 'Unknown'}\nJob: ${jobType || 'Not specified'}\nUrgency: ${urgency || 'Normal'}\n\nCall them back!`;
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          From: process.env.TWILIO_PHONE_NUMBER,
          To: ownerPhone,
          Body: smsBody
        }).toString()
      });
      console.log('[SMS] Lead alert sent to', ownerPhone);
    } catch (smsErr) {
      console.error('[SMS Error] Lead alert failed:', smsErr.message);
      // Don't fail the whole request — email still goes out
    }
  }
  try {
    // ── CONVERSATION SUMMARY ──
    // Generate a 2-sentence summary of the conversation before sending the lead email
    let conversationSummary = '';
    if (conversation && conversation.length > 0) {
      try {
        const summaryResponse = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          system: 'You summarize chat conversations into exactly 2 short sentences for a business owner. Focus on what the customer needs, their timeline, and any context that would help close the sale. Plain text only, no formatting.',
          messages: [{ role: 'user', content: 'Summarize this customer conversation:\n\n' + conversation.map(function(m) { return (m.role === 'user' ? 'Customer: ' : 'Bot: ') + m.content; }).join('\n') }]
        });
        conversationSummary = summaryResponse.content[0].text.trim();
      } catch(e) {
        console.error('[Summary Error]', e.message);
      }
    }

    const callButton = phone ? `
      <div style="text-align:center;margin:16px 0;">
        <a href="tel:${phone.replace(/\D/g,'')}" style="font-family:sans-serif;font-size:28px;font-weight:800;color:#16a34a;text-decoration:none;letter-spacing:-0.01em;">📞 ${phone}</a>
        <div style="font-size:11px;color:#94a3b8;margin-top:4px;font-family:sans-serif;">Tap to call ${name ? name.split(' ')[0] : ''}</div>
      </div>` : '';

    const summaryBlock = conversationSummary ? `<div style="background:#eff6ff;border-radius:10px;padding:16px;margin:12px 0;border-left:4px solid #2563eb;"><p style="font-size:13px;font-weight:700;color:#1d4ed8;margin:0 0 6px;">Conversation summary</p><p style="font-size:14px;color:#1e3a5f;margin:0;line-height:1.6;">${conversationSummary}</p></div>` : '';

    const urgencyColor = (urgency || '').toLowerCase().includes('urgent') || (urgency || '').toLowerCase().includes('emergency') ? '#dc2626' : '#2563eb';
    const urgencyBg = (urgency || '').toLowerCase().includes('urgent') || (urgency || '').toLowerCase().includes('emergency') ? '#fee2e2' : '#eff6ff';

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
        subject: (urgency && (urgency.toLowerCase().includes('urgent') || urgency.toLowerCase().includes('emergency')) ? '🚨 URGENT — ' : '') + 'New Lead: ' + (name || 'Someone') + ' via ' + (businessName || 'your website'),
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:0;background:#f8fafc;border-radius:16px;overflow:hidden;">
          <div style="background:#0A2540;padding:20px 24px;text-align:center;">
            <p style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 4px;">New Lead Captured</p>
            <h1 style="color:white;font-size:1.4rem;font-weight:800;margin:0;">${name || 'New visitor'}</h1>
          </div>
          <div style="padding:24px;">
            <div style="background:white;border-radius:12px;padding:20px;border:1px solid #e2e8f0;margin-bottom:16px;">
              <table style="width:100%;border-collapse:collapse;">
                <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#94a3b8;width:80px;">Name</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#0f172a;font-weight:600;">${name || 'Not provided'}</td></tr>
                <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#94a3b8;">Phone</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#0f172a;font-weight:600;">${phone || 'Not provided'}</td></tr>
                <tr><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:13px;color:#94a3b8;">Job</td><td style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#0f172a;">${jobType || 'Not specified'}</td></tr>
                <tr><td style="padding:8px 0;font-size:13px;color:#94a3b8;">Urgency</td><td style="padding:8px 0;"><span style="background:${urgencyBg};color:${urgencyColor};font-size:12px;font-weight:700;padding:3px 10px;border-radius:99px;">${urgency || 'Normal'}</span></td></tr>
              </table>
            </div>
            ${summaryBlock}
            <div style="text-align:center;margin:20px 0;">
              ${callButton}
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0;">Sent by Netify Builds · The sooner you call the better your chances</p>
          </div>
        </div>`
      }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Email send failed' });
    res.json({ success: true });
  } catch (err) {
    console.error('[Lead Error]', err.message);
    res.status(500).json({ error: 'Lead capture failed' });
  }
});

// ── WELCOME EMAIL SEQUENCE ──
async function sendEmail(to, subject, html) {
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'onboarding@resend.dev', to, bcc: 'dolbeereli95@gmail.com', subject, html })
    });
  } catch(e) { console.error('[Email error]', e.message); }
}

function scheduleWelcomeSequence(email, ownerName, bizName, pkg, website) {
  const firstName = (ownerName || 'there').split(' ')[0];
  const isBot = pkg !== 'review';
  const isReview = pkg === 'review' || pkg === 'bundle';

  // Email 2 — Day 3: Installation guide / getting started
  setTimeout(async function() {
    await sendEmail(
      email,
      'Getting the most out of your ' + (isBot ? '24/7 Chat Assistant' : 'Review Filter') + ' — ' + bizName,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="color:#0A2540;font-size:1.3rem;margin-bottom:8px;">Hey ${firstName} — a few quick tips</h2>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">It's been a couple days and I wanted to make sure everything is running smoothly for you.</p>
        ${isBot ? `<div style="background:#f0f9ff;border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid #bae6fd;">
          <p style="font-size:13px;font-weight:700;color:#0369a1;margin-bottom:8px;">Tip: Check your leads folder</p>
          <p style="font-size:13px;color:#555;line-height:1.6;">Lead emails from your bot come from <strong>onboarding@resend.dev</strong> — add it to your contacts or check your spam folder once to make sure they're not getting filtered.</p>
        </div>` : ''}
        ${isReview ? `<div style="background:#f0fdf4;border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid #bbf7d0;">
          <p style="font-size:13px;font-weight:700;color:#15803d;margin-bottom:8px;">Tip: Start sending your review link today</p>
          <p style="font-size:13px;color:#555;line-height:1.6;">The sooner you start texting customers the review link after jobs, the sooner your rating starts improving. Even 3-4 reviews a week makes a visible difference in 30 days.</p>
        </div>` : ''}
        <p style="color:#555;font-size:14px;line-height:1.7;">Any questions at all — just reply to this email. I check it personally.<br><br>— Eli<br><span style="color:#94a3b8;font-size:12px;">Netify Builds · netifybuilds@gmail.com</span></p>
      </div>`
    );
  }, 3 * 24 * 60 * 60 * 1000); // 3 days

  // Email 3 — Day 7: Check-in with results nudge
  setTimeout(async function() {
    await sendEmail(
      email,
      'One week in — how\'s it going, ' + firstName + '?',
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="color:#0A2540;font-size:1.3rem;margin-bottom:8px;">One week in 🎉</h2>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">Hey ${firstName} — it's been a week since we got your ${isBot ? '24/7 chat assistant' : 'Review Filter'} live. I wanted to check in and see how things are going.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">You can see your stats anytime at your client portal — just go to <a href="https://netifybuilds.pages.dev/portal" style="color:#2563eb;">netifybuilds.pages.dev/portal</a> and log in with the access code I sent you.</p>
        ${!isReview && pkg !== 'bundle' ? `<div style="background:#fefce8;border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid #fde68a;">
          <p style="font-size:13px;font-weight:700;color:#b45309;margin-bottom:6px;">One more thing worth knowing about</p>
          <p style="font-size:13px;color:#555;line-height:1.6;">I also offer a Review Filter that catches unhappy customers privately before they post on Google, and sends happy ones straight to your review page. A lot of my clients add it after the first month. Happy to tell you more if you're curious.</p>
        </div>` : ''}
        <p style="color:#555;font-size:14px;line-height:1.7;">Just reply here if you need anything. I'm always around.<br><br>— Eli<br><span style="color:#94a3b8;font-size:12px;">Netify Builds · netifybuilds@gmail.com</span></p>
      </div>`
    );
  }, 7 * 24 * 60 * 60 * 1000); // 7 days
}

app.post('/signup', async (req, res) => {
  const { ownerName, bizName, email, phone, website, industry, area, hours, services, faqs, tone, package: pkg, differentiators, licensing, emergency, seasonal, botPersonality, billing, hearAbout, googleReviewLink, botColor, features } = req.body;
  if (!email || !bizName) return res.status(400).json({ error: 'email and bizName are required' });

  const pkgLabel = pkg === 'bundle' ? 'Full Bundle — $249.99/mo' : pkg === 'review' ? 'Review Filter — $89.99/mo' : '24/7 Website Chat Assistant — $199.99/mo';
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
    'BOT COLOR: ' + (botColor || '#2563eb'),
    'OPTIONAL FEATURES: ' + (features || 'None selected'),
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

    // Schedule welcome sequence follow-ups
    scheduleWelcomeSequence(email, ownerName, bizName, pkg, website);

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
2. Use that information to generate a complete, production-ready 24/7 chat assistant system prompt for a customer-facing ${isLeadGen ? 'Lead Generation' : 'FAQ'} bot

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

// ── CLIENT INFO STORE (persistent) ──
const clientInfo = loadData('client_info.json', {});
app.post('/register-client', (req, res) => {
  const { bizKey, bizName, plan, email } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  clientInfo[bizKey.toLowerCase()] = { bizName, plan: plan || 'bot', email, registeredAt: new Date().toISOString() };
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

app.get('/client-info/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase();
  res.json(clientInfo[key] || { bizKey: key });
});
const conversationLogs = loadData('conversation_logs.json', {});
app.post('/log-conversation', (req, res) => {
  const { bizName, messages, leadCaptured, timestamp } = req.body;
  if (!bizName) return res.status(400).json({ error: 'bizName required' });
  const key = bizName.toLowerCase().replace(/\s+/g, '_');
  if (!conversationLogs[key]) conversationLogs[key] = [];
  conversationLogs[key].unshift({ messages: messages || [], leadCaptured: leadCaptured || false, timestamp: timestamp || new Date().toISOString() });
  if (conversationLogs[key].length > 50) conversationLogs[key] = conversationLogs[key].slice(0, 50);
  debouncedSave('conversation_logs.json', conversationLogs);
  res.json({ success: true });
});

app.get('/conversations/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase();
  res.json({ conversations: (conversationLogs[key] || []).slice(0, 20) });
});
// ── KNOWLEDGE BASE UPDATE ──
app.post('/update-knowledge', async (req, res) => {
  const { bizKey, bizName, update, ownerEmail } = req.body;
  if (!bizKey || !update) return res.status(400).json({ error: 'bizKey and update required' });

  // Email Eli with the update request
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'dolbeereli95@gmail.com',
        subject: '🔧 Bot update request — ' + (bizName || bizKey),
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:16px;">
          <h2 style="color:#0A2540;margin-bottom:8px;">Bot Update Request</h2>
          <p style="color:#555;font-size:14px;margin-bottom:16px;">A client has submitted an update for their bot.</p>
          <div style="background:white;border-radius:10px;padding:16px;border:1px solid #e2e8f0;margin-bottom:16px;">
            <p style="font-size:13px;color:#94a3b8;margin:0 0 4px;">Business</p>
            <p style="font-size:15px;font-weight:600;color:#0f172a;margin:0 0 12px;">${bizName || bizKey}</p>
            <p style="font-size:13px;color:#94a3b8;margin:0 0 4px;">Update requested</p>
            <p style="font-size:14px;color:#0f172a;line-height:1.7;margin:0;">${update}</p>
          </div>
          ${ownerEmail ? `<p style="font-size:13px;color:#555;">Owner email: <a href="mailto:${ownerEmail}">${ownerEmail}</a></p>` : ''}
          <p style="font-size:12px;color:#94a3b8;margin-top:16px;">Update their bot in the builder and redeploy within 24 hours.</p>
        </div>`
      })
    });
    res.json({ success: true });
  } catch(err) {
    console.error('[Update Error]', err.message);
    res.status(500).json({ error: 'Failed to send update request' });
  }
});
app.post('/send-review-sms', async (req, res) => {
  const { to, message, bizName } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });

  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) {
    console.log('[Review SMS] Twilio not configured — skipping');
    return res.json({ success: true, note: 'Twilio not configured' });
  }

  try {
    const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        From: process.env.TWILIO_PHONE_NUMBER,
        To: to,
        Body: message
      }).toString()
    });
    const data = await response.json();
    if (data.error_code) throw new Error(data.message);
    console.log('[Review SMS] Sent to', to, 'for', bizName);
    res.json({ success: true });
  } catch (err) {
    console.error('[Review SMS Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/urgent-escalation', async (req, res) => {
  const { bizName, businessEmail, message, transcript } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail required' });
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: businessEmail,
        bcc: 'dolbeereli95@gmail.com',
        subject: '🚨 URGENT — Customer requesting immediate callback | ' + (bizName || 'your business'),
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fef2f2;border-radius:12px;border:1px solid #fecaca;">
          <h2 style="color:#dc2626;margin-bottom:4px;">Urgent Callback Requested</h2>
          <p style="color:#555;font-size:14px;margin-bottom:16px;">A customer on your website is asking to speak with someone right now.</p>
          <div style="background:white;border-radius:10px;padding:16px;border:1px solid #e5e7eb;margin-bottom:16px;">
            <p style="margin:0;font-size:14px;"><strong>Their message:</strong> ${message || 'Not provided'}</p>
          </div>
          <div style="margin-bottom:16px;">
            <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin-bottom:8px;">Chat Transcript</p>
            <pre style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;color:#374151;">${transcript || 'No transcript available'}</pre>
          </div>
          <p style="color:#dc2626;font-size:13px;font-weight:600;">Call them back as soon as possible.</p>
          <p style="color:#999;font-size:12px;margin-top:16px;text-align:center;">Sent by Netify Builds</p>
        </div>`
      })
    });
    res.json({ success: true });
  } catch(err) {
    console.error('[Urgent Escalation Error]', err.message);
    res.status(500).json({ error: 'Failed to send escalation' });
  }
});

// ── ANALYTICS ──
const analyticsLogs = loadData('analytics_logs.json', {});
app.post('/log-analytics', (req, res) => {
  const { bizName, event, data } = req.body;
  if (!bizName) return res.status(400).json({ error: 'bizName required' });
  const key = bizName.toLowerCase().replace(/\s+/g, '_');
  if (!analyticsLogs[key]) analyticsLogs[key] = { conversations: 0, messages: 0, leads: 0, firstMessages: [], startDate: new Date().toISOString() };
  if (event === 'conversation') analyticsLogs[key].conversations++;
  if (event === 'message') analyticsLogs[key].messages++;
  if (event === 'lead') analyticsLogs[key].leads++;
  if (event === 'firstMessage' && data) {
    analyticsLogs[key].firstMessages.push({ text: data.substring(0, 100), date: new Date().toISOString() });
    if (analyticsLogs[key].firstMessages.length > 100) analyticsLogs[key].firstMessages = analyticsLogs[key].firstMessages.slice(-100);
  }
  debouncedSave('analytics_logs.json', analyticsLogs);
  res.json({ success: true });
});

app.get('/analytics/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase();
  const data = analyticsLogs[key];
  if (!data) return res.json({ bizKey: key, conversations: 0, messages: 0, leads: 0, conversionRate: '0%', commonQuestions: [] });
  const rate = data.conversations > 0 ? Math.round((data.leads / data.conversations) * 100) + '%' : '0%';
  res.json({ bizKey: key, conversations: data.conversations, messages: data.messages, leads: data.leads, conversionRate: rate, commonQuestions: data.firstMessages.slice(-10), startDate: data.startDate });
});

// Simple in-memory store for review logs — resets on server restart
// Load review logs from disk — seeded with test data if empty
const reviewLogs = loadData('review_logs.json', {
  'test_business': [
    { type: 'positive', feedback: 'Technician was on time and very professional', name: 'Sarah M', contact: '', date: new Date(Date.now() - 1*24*60*60*1000).toISOString() },
    { type: 'positive', feedback: 'Great service, will definitely use again', name: 'Mike T', contact: '', date: new Date(Date.now() - 2*24*60*60*1000).toISOString() },
    { type: 'positive', feedback: 'Not specified', name: '', contact: '', date: new Date(Date.now() - 3*24*60*60*1000).toISOString() },
    { type: 'negative', feedback: 'Technician arrived 2 hours late with no call ahead. Very frustrating.', name: 'Dave R', contact: '(937) 555-0198', date: new Date(Date.now() - 4*24*60*60*1000).toISOString() },
    { type: 'positive', feedback: 'Fixed my AC fast, great price', name: 'Jennifer L', contact: '', date: new Date(Date.now() - 5*24*60*60*1000).toISOString() },
    { type: 'positive', feedback: 'Not specified', name: '', contact: '', date: new Date(Date.now() - 6*24*60*60*1000).toISOString() },
    { type: 'negative', feedback: 'The repair didnt fix the problem and I had to call again the next day', name: 'Tom B', contact: 'tom@email.com', date: new Date(Date.now() - 7*24*60*60*1000).toISOString() },
    { type: 'positive', feedback: 'Best HVAC company in Dayton', name: 'Rachel K', contact: '', date: new Date(Date.now() - 8*24*60*60*1000).toISOString() },
  ]
});

app.post('/log-review', (req, res) => {
  const { businessName, type, feedback, contact, date } = req.body;
  if (!businessName) return res.status(400).json({ error: 'businessName required' });
  const key = businessName.toLowerCase().replace(/\s+/g, '_');
  if (!reviewLogs[key]) reviewLogs[key] = [];
  reviewLogs[key].push({ type, feedback, name: name || '', contact, date: date || new Date().toISOString() });
  debouncedSave('review_logs.json', reviewLogs);
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
