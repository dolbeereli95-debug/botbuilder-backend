const express = require('express');
const { OAuth2Client } = require('google-auth-library');
const GOOGLE_CLIENT_ID = '968822994959-js3lra786sg48d1t29l5ju5kbio6h6m1.apps.googleusercontent.com';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI = 'https://botbuilder-backend-production.up.railway.app/calendar/callback';
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

function getCalendarClient(tokens) {
  const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  client.setCredentials(tokens);
  return client;
}
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'nb-admin-2026';
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

// ── WEBSOCKET SERVER FOR EXTENSION ──
const { WebSocketServer } = require('ws');
const extensionClients = {}; // bizKey -> ws connection

function setupWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/extension-ws' });
  wss.on('connection', function(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const bizKey = url.searchParams.get('bizKey');
    if (!bizKey) { ws.close(); return; }

    extensionClients[bizKey] = ws;
    console.log('[Extension] Connected:', bizKey);

    ws.on('message', function(data) {
      try {
        const msg = JSON.parse(data);
        if (msg.type === 'register') {
          extensionClients[bizKey] = ws;
          // Auto-scan if no scan exists yet
          if (clientInfo[bizKey] && !clientInfo[bizKey].siteScan) {
            console.log('[Extension] First connect for', bizKey, '-- requesting auto-scan');
            setTimeout(function() {
              if (extensionClients[bizKey] && extensionClients[bizKey].readyState === 1) {
                extensionClients[bizKey].send(JSON.stringify({ type: 'scan_request' }));
              }
            }, 2000);
          }
        }
        if (msg.type === 'scan_result') {
          if (clientInfo[bizKey]) {
            clientInfo[bizKey].siteScan = { html: msg.html, scannedAt: new Date().toISOString() };
            debouncedSave('client_info.json', clientInfo);
            console.log('[Extension] Site scan stored for', bizKey);
          }
        }
        if (msg.type === 'advisor_checks') {
          if (clientInfo[bizKey]) {
            clientInfo[bizKey].advisorChecks = msg.checks;
            clientInfo[bizKey].advisorChecksAt = new Date().toISOString();
            debouncedSave('client_info.json', clientInfo);
          }
        }
        if (msg.type === 'edit_result') {
          console.log('[Extension] Edit result for', bizKey, ':', msg.success ? 'success' : msg.error);
        }
        if (msg.type === 'page_ready') {
          // Check for pending edits when client opens their site
          if (clientInfo[bizKey] && clientInfo[bizKey].pendingEdits && clientInfo[bizKey].pendingEdits.length > 0) {
            clientInfo[bizKey].pendingEdits.forEach(function(edit) {
              ws.send(JSON.stringify({ type: 'edit', edit: edit, editId: edit.editId }));
            });
            clientInfo[bizKey].pendingEdits = [];
            debouncedSave('client_info.json', clientInfo);
          }
        }
        if (msg.type === 'edit_queued') {
          console.log('[Extension] Edit queued for next visit:', bizKey);
        }
      } catch(e) { console.error('[Extension WS Error]', e.message); }
    });

    ws.on('close', function() {
      if (extensionClients[bizKey] === ws) delete extensionClients[bizKey];
      console.log('[Extension] Disconnected:', bizKey);
    });
  });
  return wss;
}

// Function to send edit command to extension
async function sendEditToExtension(bizKey, edit) {
  const ws = extensionClients[bizKey];
  const editId = Date.now().toString();
  edit.editId = editId;

  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'edit', edit: edit, editId: editId }));
    return { sent: true, editId };
  } else {
    // Queue for when extension reconnects
    if (clientInfo[bizKey]) {
      if (!clientInfo[bizKey].pendingEdits) clientInfo[bizKey].pendingEdits = [];
      clientInfo[bizKey].pendingEdits.push(edit);
      debouncedSave('client_info.json', clientInfo);
    }
    return { sent: false, queued: true, editId };
  }
}

app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (
      origin.includes('netifybuilds.com') ||
      origin.includes('netifybuilds.pages.dev') ||
      origin.startsWith('http://localhost') ||
      origin.startsWith('http://127.0.0.1')
    ) {
      return callback(null, true);
    }
    return callback(new Error('Not allowed by CORS'));
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
  const { messages, systemPrompt, bizKey, isAdminSession: clientAdminFlag } = req.body;

  // Domain validation -- check the widget is being used from a registered domain
  const origin = req.headers.origin || req.headers.referer || '';
  if (bizKey && clientInfo[bizKey.toLowerCase()]) {
    const client = clientInfo[bizKey.toLowerCase()];
    if (client.domain && origin && !origin.includes(client.domain) && !origin.includes('localhost') && !origin.includes('127.0.0.1') && !origin.includes('netifybuilds')) {
      console.warn('[Domain Mismatch]', bizKey, 'called from', origin, 'expected', client.domain);
      return res.status(403).json({ reply: 'Unauthorized domain.' });
    }
  }
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }
  // Check activation status
  if (bizKey) {
    const clientKey = bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const client = clientInfo[clientKey];
    if (client && client.activated === false) {
      return res.status(403).json({ error: 'Bot not yet activated. Please activate your bot in the client portal to go live.' });
    }
  }

  // Fall back to stored system prompt if widget didn't send one
  let resolvedPrompt = systemPrompt;
  if ((!resolvedPrompt || typeof resolvedPrompt !== 'string' || resolvedPrompt.length < 10) && bizKey) {
    const storedClient = clientInfo[bizKey.toLowerCase()];
    if (storedClient && storedClient.systemPrompt) {
      resolvedPrompt = storedClient.systemPrompt;
    }
  }
  if (!resolvedPrompt || typeof resolvedPrompt !== 'string' || resolvedPrompt.length < 10) {
    return res.status(400).json({ error: 'systemPrompt is required' });
  }

  // Detect admin mode -- if the message IS the bizKey, switch to admin mode
  const lastUserMsg = (messages[messages.length - 1] || {}).content || '';
  const trimmedMsg = lastUserMsg.trim().toLowerCase().replace(/\s+/g, '_');

  // Admin session detection -- defined early so all handlers can use it
  const adminKeywords = ['edit your website', 'make changes to your website', 'website change', 'improve it or boost', 'Google rankings', 'business setup'];
  const isAdminSession = clientAdminFlag === true || (bizKey && clientInfo[bizKey] && messages.length >= 1 && (
    messages.some(function(m) { return m.role === 'user' && m.content && m.content.trim().toLowerCase() === (bizKey || '').toLowerCase(); }) ||
    messages.some(function(m) { return m.role === 'assistant' && m.content && adminKeywords.some(function(k) { return m.content.includes(k); }); })
  ));

  // Check if this is an admin code entry
  if (bizKey && trimmedMsg === bizKey.toLowerCase() && clientInfo[bizKey]) {
    const client = clientInfo[bizKey];
    // Fetch site scan for context
    let siteContext = '';
    if (client.siteScan && client.siteScan.html) {
      siteContext = '\n\nHere is what we know about their website:\n' + extractSiteContent(client.siteScan.html);
    }
    if (client.advisorChecks && client.advisorChecks.length > 0) {
      siteContext += '\n\nAutomated issues detected on their site:\n' +
        client.advisorChecks.map(function(c) { return '- [' + c.impact.toUpperCase() + '] ' + c.issue + '. Fix: ' + c.fix; }).join('\n');
    }
    const adminSystemPrompt = `You are a smart website advisor and editor for ${client.bizName || 'this business'}. The business owner just authenticated. Greet them warmly by business name and let them know they can ask you to edit their website, get advice on improving it, or ask any questions about their business setup.

You have two modes in this conversation:

EDITOR MODE: When they ask you to change something on their website, generate a structured edit command at the end of your response:\n\nFor text changes: EDIT_COMMAND|{\"type\":\"text_replace\",\"oldText\":\"exact current text\",\"newText\":\"replacement text\",\"description\":\"what this change does\"}\n\nFor image changes: EDIT_COMMAND|{\"type\":\"image_replace\",\"selector\":\"css selector\",\"altText\":\"which image\",\"description\":\"which image to replace\"}\n\nFor SEO changes: EDIT_COMMAND|{\"type\":\"seo_update\",\"metaTitle\":\"new title if changing\",\"metaDescription\":\"new description if changing\",\"description\":\"updating SEO fields\"}\n\nADVISOR MODE: When they ask why their site is not performing, what to improve, why they are not ranking on Google -- give specific actionable advice based on their actual site content. Be direct and concrete, never generic.\n\nKeep responses conversational and warm. 2-3 sentences max unless they need detailed advice. Never use markdown formatting.${siteContext}`;

    // Build proactive issues message if we have advisor checks
    let adminGreetingContent = 'Admin authenticated';
    if (client.advisorChecks && client.advisorChecks.length > 0) {
      const highIssues = client.advisorChecks.filter(function(c) { return c.impact === 'high'; });
      if (highIssues.length > 0) {
        adminGreetingContent = 'Admin authenticated. Please greet them and immediately mention you noticed ' + highIssues.length + ' high-priority issue' + (highIssues.length > 1 ? 's' : '') + ' on their site that could be costing them leads. List them briefly and offer to fix them.';
      }
    }

    const adminResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: adminSystemPrompt,
      messages: [{ role: 'user', content: adminGreetingContent }]
    });

    const adminText = adminResponse.content[0].text;
    return res.json({ reply: adminText, adminMode: true });
  }

  // Handle quick reply buttons
  if (isAdminSession) {
    if (lastUserMsg === 'Make a website change') {
      return res.json({ reply: 'Sure! What would you like to change? Just describe it in plain English — for example: "Change my phone number to 937-555-0123" or "Update my hours to Monday through Friday 8am to 5pm."', adminMode: true });
    }
    if (lastUserMsg === 'Advise me on my site') {
      const client = clientInfo[bizKey] || {};
      // If we have a scan use it
      if (client.siteScan && client.siteScan.html) {
        const extracted = extractSiteContent(client.siteScan.html);
        // Fall through to full admin Claude response with site context
      } else if (client.domain || client.website || bizKey) {
        // Try to fetch site directly from server
        try {
          const rawDomain = client.domain || client.website || '';
          // For netifybuilds3467 use netifybuilds.com
          const siteUrl = rawDomain ? 'https://' + rawDomain.replace(/^https?:\/\//, '') : null;
          if (!siteUrl) throw new Error('No domain on file');
          const siteUrlFinal = siteUrl;
          const siteRes = await fetch(siteUrl, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
            signal: AbortSignal.timeout(8000)
          });
          if (siteRes && siteRes.ok) {
            const html = await siteRes.text();
            client.siteScan = { html: html.substring(0, 50000), scannedAt: new Date().toISOString() };
            debouncedSave('client_info.json', clientInfo);
            console.log('[Admin] Server-side scan completed for', bizKey);
          }
        } catch(e) {
          console.log('[Admin] Server-side scan failed:', e.message);
        }
      }
      // If still no scan after trying
      if (!client.siteScan || !client.siteScan.html) {
        if (client.advisorChecks && client.advisorChecks.length > 0) {
          const high = client.advisorChecks.filter(function(c) { return c.impact === 'high'; });
          const med = client.advisorChecks.filter(function(c) { return c.impact === 'medium'; });
          let advice = 'Based on what I can see from your page, here are the most important things to address: ';
          if (high.length > 0) advice += high.map(function(c) { return c.issue + '. ' + c.fix; }).join(' ');
          if (med.length > 0) advice += ' Also worth looking at: ' + med.map(function(c) { return c.issue; }).join(', ') + '.';
          return res.json({ reply: advice, adminMode: true });
        }
        return res.json({ reply: "What aspect of your site would you like advice on? Google rankings, conversions, trust signals, or something specific?", adminMode: true });
      }
      // Fall through to full Claude admin response which will use siteScan context
    }
  }

  // Check for admin exit command
  if (isAdminSession && (lastUserMsg.toLowerCase() === 'exit admin' || lastUserMsg.toLowerCase() === 'done' || lastUserMsg.toLowerCase() === 'exit')) {
    // Send change summary email if there were changes this session
    const client = clientInfo[bizKey];
    if (client && client.changeHistory && client.changeHistory.length > 0) {
      const recentChanges = client.changeHistory.filter(function(c) {
        return c.savedAt && (Date.now() - new Date(c.savedAt).getTime()) < 2 * 60 * 60 * 1000; // last 2 hours
      });
      if (recentChanges.length > 0 && client.email) {
        fetch('https://botbuilder-backend-production.up.railway.app/send-change-summary', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bizKey: bizKey, changes: recentChanges })
        }).catch(function(e) { console.error('[Summary email error]', e.message); });
      }
    }
    return res.json({ reply: 'You\'re back in customer mode. Your website changes are saved.', adminMode: false, exitAdmin: true });
  }

  // Check if already in admin mode (previous messages show admin was authenticated)
  // isAdminSession defined above
  // Check for revert command
  const revertTriggers = ['undo', 'revert', 'undo that', 'revert that', 'go back', 'undo last change', 'revert last change'];
  if (isAdminSession && revertTriggers.some(t => lastUserMsg.toLowerCase().includes(t))) {
    const ws = extensionClients[bizKey];
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'revert_last' }));
      return res.json({ reply: 'Done, that change has been reverted.', adminMode: true });
    } else {
      return res.json({ reply: 'Your browser needs to be open on your website for me to revert changes. Open your site in Chrome and try again.', adminMode: true });
    }
  }

  const revertAllTriggers = ['undo all', 'revert all', 'revert all changes', 'undo everything'];
  if (isAdminSession && revertAllTriggers.some(t => lastUserMsg.toLowerCase().includes(t))) {
    const ws = extensionClients[bizKey];
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'revert_all' }));
      return res.json({ reply: 'All changes have been reverted.', adminMode: true });
    }
  }


  if (isAdminSession && bizKey && clientInfo[bizKey]) {
    const client = clientInfo[bizKey];
    let siteContext = '';
    if (client.siteScan && client.siteScan.html) {
      siteContext = '\n\nWebsite content summary:\n' + extractSiteContent(client.siteScan.html);
    }
    const adminSystemPrompt = `You are a website advisor and editor for ${client.bizName || 'this business'}. The owner is authenticated.

EDITOR MODE: When asked to change ANY text on the website, you MUST end your response with an EDIT_COMMAND. No exceptions. Do not apologize. Do not say you will do it. Just do it and include the command.

Format for text changes:
EDIT_COMMAND|{"type":"text_replace","oldText":"exact text to find","newText":"replacement","description":"what changed"}

Format for nav links (use selector):
EDIT_COMMAND|{"type":"text_replace","selector":"nav a","oldText":"exact link text","newText":"new text","description":"nav change"}

Format for SEO:
EDIT_COMMAND|{"type":"seo_update","metaTitle":"new title","metaDescription":"new description","description":"SEO update"}

CRITICAL RULES:
- ALWAYS include EDIT_COMMAND at the end when asked to change something
- The oldText must be the EXACT text as it appears on the page
- Keep your reply before the command to 1 sentence max
- Never say "I will do it" or "let me do that" without also including the EDIT_COMMAND

ADVISOR MODE: Give specific actionable advice when asked. Direct and concrete only.

Never use markdown.${siteContext}`;

    // Keep only last 6 messages to avoid confusion from failed attempts
    const filteredMsgs = messages
      .filter(function(m) { return m && typeof m.content === 'string' && m.content.trim() !== (bizKey || ''); })
      .slice(-6);
    if (filteredMsgs.length === 0) filteredMsgs.push({ role: 'user', content: lastUserMsg });
    // Ensure starts with user message
    const firstUserIdx = filteredMsgs.findIndex(function(m) { return m.role === 'user'; });
    const adminMsgs = firstUserIdx >= 0 ? filteredMsgs.slice(firstUserIdx) : [{ role: 'user', content: lastUserMsg }];

    const adminResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: adminSystemPrompt,
      messages: adminMsgs.length > 0 ? adminMsgs : [{ role: 'user', content: lastUserMsg }]
    });

    let adminText = adminResponse.content[0].text;
    console.log('[Admin Raw Response]', JSON.stringify(adminText.substring(0, 500)));

    // Normalize -- Claude sometimes puts EDIT_COMMAND on a new line with extra spaces
    adminText = adminText.replace(/\n\s*EDIT_COMMAND\|/g, '\nEDIT_COMMAND|');

    // Parse and send edit command if present
    if (adminText.includes('EDIT_COMMAND|')) {
      const parts = adminText.split('EDIT_COMMAND|');
      const replyText = parts[0].trim();
      try {
        const editData = JSON.parse(parts[1].trim());
        const sendResult = await sendEditToExtension(bizKey, editData);
        console.log('[Admin Edit] Send result for', bizKey, ':', JSON.stringify(sendResult));
        const ws = extensionClients[bizKey];
        const isConnected = ws && ws.readyState === 1;
        let finalReply = replyText || 'Done!';
        if (!isConnected) {
          finalReply = (replyText || 'Got it!') + ' The change is queued. Open your website in Chrome with the extension active and it will apply.';
        } else {
          finalReply = (replyText || 'Done!') + ' Check your website — it should show now. Note: this is a live preview. To make it permanent, update your website file and push it.';
        }
        return res.json({ reply: finalReply, adminMode: true, editSent: true });
      } catch(e) {
        console.error('[Admin Edit Parse Error]', e.message, 'Raw:', parts[1] ? parts[1].substring(0, 200) : 'none');
        return res.json({ reply: (replyText || 'I generated the change but had trouble sending it. Try describing it again.'), adminMode: true });
      }
    }

    return res.json({ reply: adminText, adminMode: true });
  }
  const handoffKeywords = ['speak to someone', 'talk to someone', 'real person', 'human', 'speak to a person', 'call me', 'representative', 'agent', 'talk to eli', 'speak to eli'];
  const wantsHandoff = handoffKeywords.some(kw => lastUserMsg.toLowerCase().includes(kw));
  if (wantsHandoff && bizKey) {
    return res.json({ reply: 'Of course! Let me get someone for you right away.', handoffRequested: true });
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
  const enrichedPrompt = resolvedPrompt + timeInjection;

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
    // Check for FETCH_SLOTS trigger
    if (reply.includes('FETCH_SLOTS') && bizKey && clientInfo[bizKey] && clientInfo[bizKey].calendarConnected) {
      try {
        const slotsRes = await fetch('https://botbuilder-backend-production.up.railway.app/calendar/availability/' + bizKey);
        const slotsData = await slotsRes.json();
        const slots = slotsData.slots || [];
        if (slots.length === 0) {
          return res.json({ reply: reply.replace('FETCH_SLOTS', '').trim() + " I don't see any open slots in the next 2 weeks. Please call us directly to schedule.", bizKey });
        }
        const slotList = slots.map(function(s, i) { return (i+1) + '. ' + s.label; }).join('\n');
        if (!global.pendingSlots) global.pendingSlots = {};
        global.pendingSlots[bizKey] = slots;
        return res.json({ reply: reply.replace('FETCH_SLOTS', '').trim() + '\n\nHere are the next available times:\n' + slotList + '\n\nWhich works best for you?', bizKey, slots });
      } catch(e) { console.error('[Slots Error]', e.message); }
    }

    // Check for BOOK_SLOT trigger
    if (reply.includes('BOOK_SLOT|') && bizKey && clientInfo[bizKey] && clientInfo[bizKey].calendarConnected) {
      try {
        const bookParts = reply.split('BOOK_SLOT|')[1].split('|');
        const slotIdx = parseInt(bookParts[0]) - 1;
        const custName = bookParts[1] || 'Customer';
        const custPhone = bookParts[2] || '';
        const service = bookParts[3] || 'Appointment';
        const slots = (global.pendingSlots && global.pendingSlots[bizKey]) || [];
        const slot = slots[slotIdx];
        if (!slot) throw new Error('Slot not found');
        const bookRes2 = await fetch('https://botbuilder-backend-production.up.railway.app/calendar/book', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bizKey, slotStart: slot.start, slotEnd: slot.end, customerName: custName, customerPhone: custPhone, service })
        });
        const bookData = await bookRes2.json();
        if (bookData.success) {
          return res.json({ reply: reply.split('BOOK_SLOT|')[0].trim() + ' Your ' + service + ' is confirmed for ' + slot.label + '. See you then!', bizKey, booked: true });
        }
      } catch(e) { console.error('[Book Slot Error]', e.message); }
    }

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
        const bizName = resolvedPrompt.match(/for ([^,\.]+)/)?.[1] || 'Unknown Business';
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
    try {
const { clientData, systemPromptRequest: customSystemPrompt, features } = req.body;
  if (!clientData || typeof clientData !== 'string' || clientData.length < 50) {
    return res.status(400).json({ error: 'clientData is required' });
  }

  // Build feature-specific additions based on what client selected
  const featureList = (features || '').toLowerCase();
  const hasAppointment = featureList.includes('appointment');
  const hasCalendar = featureList.includes('calendar') || featureList.includes('google calendar');
  const hasEmergency = featureList.includes('emergency') || !!(data.emergency && data.emergency.trim() && data.emergency !== 'Not provided');
  const hasMultilang = featureList.includes('multilanguage') || featureList.includes('multilang');
  const hasPricing = featureList.includes('pricing');
  const hasWorkout = featureList.includes('workout');
  const hasGroomer = featureList.includes('groomer') || featureList.includes('pet intake');
  const hasAutoSymptom = featureList.includes('symptom') || featureList.includes('autosymptom');
  const hasMoving = featureList.includes('moving') || featureList.includes('move estimator');
  const hasCleaning = featureList.includes('cleaning') || featureList.includes('quote estimator');

  const featureInstructions = [
    hasEmergency ? ('- EMERGENCY ESCALATION: If the customer signals a true emergency (no heat, burst pipe, gas smell, flooding, power outage, urgent safety issue), immediately tell them to call the emergency number directly: ' + (clientInfo[bizKey] && clientInfo[bizKey].emergency ? clientInfo[bizKey].emergency : 'the emergency line') + '. Do not just capture the lead — push them to call now. Still capture their name and number after directing them.') : '- Do not treat after-hours inquiries as emergencies unless explicitly stated. Capture leads normally.',
    hasAppointment && !hasCalendar ? '- APPOINTMENT FLOW: When a customer asks to book or schedule, collect their preferred day, time, and reason. Do NOT confirm the appointment — tell them someone will call to confirm. Email this as a formatted appointment request.' : '',
    hasAppointment && hasCalendar ? '- CALENDAR BOOKING: You can both book appointments AND collect callback requests. When a customer describes a problem or need, naturally offer them a choice: "I can book an appointment for you right now or have someone call you back — which works better?" If they want to book, ask what service they need then output on its own line: FETCH_SLOTS. The system will provide available slots — present them as numbered options like "1. Tuesday at 10am". When they pick one, collect their name and phone if not already provided, then output: BOOK_SLOT|[slot_index]|[customer_name]|[customer_phone]|[service]. If they prefer a callback, collect name and phone normally and output the LEAD_CAPTURED trigger. Never push booking over callback — let the customer choose.' : '',
    hasMultilang ? '- MULTILANGUAGE: Detect and respond in whatever language the customer writes in. Never force English.' : '',
    hasPricing ? '- PRICING GUIDE: When asked about cost, don\'t just say "it depends." Walk the customer through the key factors that affect price for their specific situation and give a realistic ballpark range based on the business\'s pricing data.' : '',
    hasWorkout ? '- WORKOUT SPLIT BUILDER: When someone asks about training, programs, or getting started, guide them through a short conversation: ask their main goal (lose weight / build muscle / improve endurance), experience level (beginner / intermediate / advanced), days per week available, and equipment access. Then provide a clear personalized weekly workout split — e.g. "Push/Pull/Legs" or "Full Body 3x" — described in plain sentences, no markdown. After delivering the split, naturally suggest they speak with a trainer at the gym to refine it and capture their name and number.' : '',
    hasGroomer ? '- PET INTAKE QUALIFIER: When a customer asks about grooming, ask about their pet\'s breed, size (small/medium/large), coat type (short/medium/long/double coat), and whether the pet is anxious or has any sensitivities. Based on their answers, tell them what service level they likely need, approximate time, and what to expect. Then capture their name and number to book.' : '',
    hasAutoSymptom ? '- SYMPTOM CHECKER: When a customer describes a car problem — noise, warning light, vibration, smell, or handling issue — ask 1-2 clarifying questions (when it happens, which part of the car, how long it\'s been going on). Then give a plain-English explanation of the most likely cause and a realistic cost range. Always suggest they bring it in for a free inspection and capture their name and number.' : '',
    hasMoving ? '- MOVE ESTIMATOR: When someone asks about moving services or a quote, walk them through: number of rooms or bedrooms, moving distance (local/long distance), what floor they\'re on, any large or specialty items (piano, safe, etc.), and preferred timing. Give a realistic cost range based on typical rates and note factors that affect price. Then capture their name and number for a formal quote.' : '',
    hasCleaning ? '- QUOTE ESTIMATOR: When someone asks about cleaning services or pricing, ask about: square footage or number of bedrooms/bathrooms, type of cleaning (standard/deep/move-in/move-out), frequency they want (one-time/weekly/biweekly/monthly), and any pets or special requests. Give a realistic price range and mention available time slots. Then capture their name and number to book.' : '',
  ].filter(Boolean).join('\n');

  const systemPromptRequest = customSystemPrompt || `You are a bot-building expert. Given client business data, generate a complete, production-ready 24/7 chat assistant system prompt for a customer-facing FAQ and lead generation bot.

The client data you receive may be in any format — structured labeled fields, comma-separated lists, newline-separated items, plain conversational sentences, partial sentences, or a mix of all of these. It may also contain typos, abbreviations, or informal language. Your job is to interpret it intelligently regardless of how it's written. Extract every useful piece of information no matter how it's formatted or phrased. If something is abbreviated (e.g. "ac" = air conditioning, "hvac", "sqft", "appt") interpret it correctly. If something is unclear, use your best judgment based on context. Never skip information just because it's formatted unusually.

The system prompt you write must:
- Start with the bot name and role
- Include all business details naturally woven in
- Know all the FAQs and answers thoroughly
- Understand the services, pricing, and hours
- Follow the specified tone exactly
- Know what to never say
- Include a strict instruction that the bot must NEVER use markdown formatting, bullet points, bold text, headers, or emojis in any response. Plain conversational sentences only — no asterisks, no dashes as bullets, no pound signs, nothing. Just natural human-sounding text.
- Include after-hours behavior: the bot should know the business hours and when someone contacts outside those hours, acknowledge it warmly and let them know someone from the team will follow up first thing during business hours. Never promise a specific callback time like '20 minutes' after hours. Still capture the lead naturally during the conversation.
- Include clear lead capture instructions: naturally collect name, phone number, job type, and urgency through conversation. Once name AND phone are collected, tell the customer someone from the team will reach out — never use the owner's specific name in this context. Then output this exact trigger at the very end of the response: LEAD_CAPTURED|[name]|[phone]|[job type or Not specified]|[urgency or Not specified]. The trigger must always use this exact format with pipe separators and no extra spaces. Never show the trigger to the customer. Never ask for contact info again if already collected in the conversation.
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

  } catch(e) { console.error('[/generate Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.post('/lead', async (req, res) => {
  const { name, phone, jobType, urgency, businessEmail, businessName, ownerPhone, conversation } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail is required' });

  // ── SMS ALERT (Twilio) ──
  if (ownerPhone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    try {
      const smsBody = `New lead from your website!\nName: ${name || 'Unknown'}\nPhone: ${phone || 'Unknown'}\nJob: ${jobType || 'Not specified'}\nUrgency: ${urgency || 'Normal'}\n\nCall them back! Reply STOP to stop these alerts.`;
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
        subject: (urgency && (urgency.toLowerCase().includes('urgent') || urgency.toLowerCase().includes('emergency')) ? '🚨 URGENT — ' : '') + 'New Lead: ' + (name || 'Someone') + (phone ? ' · ' + phone : '') + ' via ' + (businessName || 'your website'),
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

// ── PERSISTENT EMAIL SCHEDULER ──
// Stores scheduled emails in data file so they survive redeploys

var scheduledEmails = loadData('scheduled_emails.json') || [];

function saveScheduledEmails() {
  debouncedSave('scheduled_emails.json', scheduledEmails);
}

// Check every 5 minutes for emails that are due
setInterval(async function() {
  var now = Date.now();
  var pending = scheduledEmails.filter(function(e) { return e.sendAt <= now && !e.sent; });
  for (var i = 0; i < pending.length; i++) {
    var e = pending[i];
    try {
      await sendEmail(e.to, e.subject, e.html);
      e.sent = true;
      e.sentAt = new Date().toISOString();
      console.log('[Scheduler] Sent:', e.subject, 'to', e.to);
    } catch(err) {
      console.error('[Scheduler] Failed to send:', e.subject, err.message);
    }
  }
  if (pending.length > 0) {
    // Clean up old sent emails older than 60 days
    scheduledEmails = scheduledEmails.filter(function(e) {
      return !e.sent || (Date.now() - new Date(e.sentAt).getTime() < 60 * 24 * 60 * 60 * 1000);
    });
    saveScheduledEmails();
  }
}, 5 * 60 * 1000);

function queueEmail(to, subject, html, delayMs) {
  scheduledEmails.push({
    to: to,
    subject: subject,
    html: html,
    sendAt: Date.now() + delayMs,
    sent: false,
    queuedAt: new Date().toISOString()
  });
  saveScheduledEmails();
}

function scheduleWelcomeSequence(email, ownerName, bizName, pkg, website) {
  const firstName = (ownerName || 'there').split(' ')[0];
  const isBot = pkg !== 'review' && pkg !== 'review_campaign';
  const isReview = pkg === 'review' || pkg === 'bundle' || pkg === 'review_campaign' || pkg === 'all' || pkg === 'bot_campaign';
  const isCampaign = pkg === 'campaign' || pkg === 'all' || pkg === 'bot_campaign' || pkg === 'review_campaign';

  // Email 2 — Day 3
  queueEmail(
      email,
      'Quick check-in — ' + bizName,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="color:#0A2540;font-size:1.3rem;margin-bottom:8px;">Hey ${firstName} — just checking in</h2>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">It's been a few days since you signed up. I wanted to make sure you got the install code and everything is moving along.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">If you're waiting on a web developer or still working on getting it installed — no rush. Your subscription doesn't start until you hit <strong>Activate</strong> in your client portal, so you're not on the clock yet.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">If you ran into any issues or need help with the install, just reply to this email and I'll sort it out same day.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;">— Eli<br><span style="color:#94a3b8;font-size:12px;">Netify Builds · netifybuilds@gmail.com</span></p>
      </div>`
  , 3 * 24 * 60 * 60 * 1000); // 3 days

  // Email 3 — Day 7
  queueEmail(
      email,
      'Still here if you need anything — ' + bizName,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="color:#0A2540;font-size:1.3rem;margin-bottom:8px;">Hey ${firstName} — still here</h2>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">Just wanted to follow up one more time. Once your bot is installed and you're ready to go live, log into your client portal at <a href="https://netifybuilds.com/portal" style="color:#2563eb;">netifybuilds.com/portal</a> and hit Activate — that's when your subscription starts.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">If you need any help with the install or anything else, just reply here. I handle everything personally.</p>
        ${!isReview && pkg !== 'bundle' ? `<div style="background:#fefce8;border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid #fde68a;">
          <p style="font-size:13px;font-weight:700;color:#b45309;margin-bottom:6px;">One more thing worth knowing about</p>
          <p style="font-size:13px;color:#555;line-height:1.6;">I also offer a Review Filter that catches unhappy customers privately before they post on Google, and sends happy ones straight to your review page. A lot of my clients add it after the first month. Happy to tell you more if you're curious.</p>
        </div>` : ''}
        <p style="color:#555;font-size:14px;line-height:1.7;">Just reply here if you need anything. I'm always around.<br><br>— Eli<br><span style="color:#94a3b8;font-size:12px;">Netify Builds · netifybuilds@gmail.com</span></p>
      </div>`
  , 7 * 24 * 60 * 60 * 1000); // 7 days

  // Email 4 -- Day 14
  queueEmail(
      email,
      'Two weeks in -- how are things looking, ' + firstName + '?',
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="color:#0A2540;font-size:1.3rem;margin-bottom:8px;">Two weeks in</h2>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">Hey ${firstName} -- wanted to check in and see how things are going with ${bizName}.</p>
        ${isBot ? `<p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">Your chat assistant has been running for two weeks now. You can see all your conversations and leads captured in your client portal. If the bot ever says something that needs updating, just hit the "Send Update Request" button in the portal and I'll fix it same day.</p>` : ''}
        ${isReview ? `<p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">The more consistently you send the review link after jobs, the faster your Google rating climbs. Even 3-4 a week makes a real difference within 30 days.</p>` : ''}
        ${isCampaign ? `<p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">If you haven't sent your customer list yet, now is a great time -- reply to this email and we'll get your first campaign scheduled.</p>` : ''}
        <p style="color:#555;font-size:14px;line-height:1.7;">Any questions at all, just reply here.<br><br>-- Eli<br><span style="color:#94a3b8;font-size:12px;">Netify Builds</span></p>
      </div>`
  , 14 * 24 * 60 * 60 * 1000); // 14 days

  // Email 5 -- Day 30
  queueEmail(
      email,
      'One month with Netify Builds -- ' + bizName,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;">
        <h2 style="color:#0A2540;font-size:1.3rem;margin-bottom:8px;">One month in</h2>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">Hey ${firstName} -- it's been a full month. I hope things are going well at ${bizName}.</p>
        <p style="color:#555;font-size:14px;line-height:1.7;margin-bottom:16px;">Log into your portal anytime to see your stats -- conversations, leads captured, review counts, and any private feedback. Everything is tracked and updated in real time.</p>
        ${!isReview ? `<div style="background:#fefce8;border-radius:10px;padding:16px;margin-bottom:16px;border:1px solid #fde68a;">
          <p style="font-size:13px;font-weight:700;color:#b45309;margin-bottom:6px;">Worth knowing about</p>
          <p style="font-size:13px;color:#555;line-height:1.6;">A lot of my clients add the Review Filter after their first month once they see how the chat assistant is working. It catches unhappy customers before they post publicly and sends happy ones straight to Google. Happy to tell you more if you're curious.</p>
        </div>` : ''}
        <p style="color:#555;font-size:14px;line-height:1.7;">As always -- any issues or updates needed, just reply here. I'm around.<br><br>-- Eli<br><span style="color:#94a3b8;font-size:12px;">Netify Builds</span></p>
      </div>`
  , 30 * 24 * 60 * 60 * 1000); // 30 days
}

function buildQuickReplies(data) {
  const { plan, features, industry, calendarConnected } = data;

  // Emergency tab quick replies - always industry specific
  var emergencyReplies = ['No heat or AC', 'Water leak', 'Power issue', 'Other emergency'];
  if (industry) {
    var ind = industry.toLowerCase();
    if (ind.includes('hvac') || ind.includes('heating') || ind.includes('cooling') || ind.includes('air')) {
      emergencyReplies = ['AC stopped working', 'No heat', 'Strange smell or noise', 'System leaking'];
    } else if (ind.includes('plumb')) {
      emergencyReplies = ['Pipe burst or leak', 'No hot water', 'Drain clogged', 'Toilet overflowing'];
    } else if (ind.includes('electric')) {
      emergencyReplies = ['Power outage', 'Sparks or burning smell', 'Breaker keeps tripping', 'No power to room'];
    } else if (ind.includes('roof')) {
      emergencyReplies = ['Active roof leak', 'Storm damage', 'Tree fell on roof', 'Ceiling is wet'];
    } else if (ind.includes('pest')) {
      emergencyReplies = ['Bees or wasps inside', 'Rodents in home', 'Bed bugs', 'Termite damage'];
    }
  }
  const hasAppointment = calendarConnected || (features && (features.includes('appointment') || features.includes('calendar')));
  const hasReview = plan && (plan.includes('review') || plan === 'all' || plan === 'bundle');

  // Base replies every service business bot gets
  var replies = ['Get a quote', 'Hours & availability', 'Service area'];

  // Add appointment booking if they have it
  if (hasAppointment) {
    replies = ['Book an appointment', 'Get a quote', 'Hours & availability', 'Service area'];
  }

  // Industry-specific adjustments
  if (industry) {
    var ind = industry.toLowerCase();
    if (ind.includes('hvac') || ind.includes('heating') || ind.includes('cooling') || ind.includes('air')) {
      replies = hasAppointment
        ? ['Book an appointment', 'AC not cooling', 'Get a quote', 'Service area']
        : ['AC not cooling', 'Get a quote', 'Hours & availability', 'Service area'];
    } else if (ind.includes('plumb')) {
      replies = hasAppointment
        ? ['Book an appointment', 'Emergency leak', 'Get a quote', 'Service area']
        : ['Emergency leak', 'Get a quote', 'Hours & availability', 'Service area'];
    } else if (ind.includes('roof')) {
      replies = hasAppointment
        ? ['Book an appointment', 'Free inspection', 'Get a quote', 'Service area']
        : ['Free inspection', 'Get a quote', 'Storm damage help', 'Service area'];
    } else if (ind.includes('electric')) {
      replies = hasAppointment
        ? ['Book an appointment', 'Get a quote', 'Emergency service', 'Service area']
        : ['Get a quote', 'Emergency service', 'Hours & availability', 'Service area'];
    } else if (ind.includes('clean')) {
      replies = hasAppointment
        ? ['Book a cleaning', 'Get a quote', 'Service area', 'Hours & availability']
        : ['Get a quote', 'Service area', 'Hours & availability', 'What do you clean?'];
    } else if (ind.includes('lawn') || ind.includes('landscape')) {
      replies = hasAppointment
        ? ['Book a visit', 'Get a quote', 'Service area', 'What services?']
        : ['Get a quote', 'Service area', 'What services?', 'Hours & availability'];
    } else if (ind.includes('dental') || ind.includes('dentist')) {
      replies = hasAppointment
        ? ['Book an appointment', 'New patient info', 'Insurance accepted', 'Hours & availability']
        : ['New patient info', 'Insurance accepted', 'Hours & availability', 'Services offered'];
    } else if (ind.includes('auto') || ind.includes('car') || ind.includes('mechanic')) {
      replies = hasAppointment
        ? ['Book a service', 'Get a quote', 'Hours & availability', 'Service area']
        : ['Get a quote', 'Hours & availability', 'What services?', 'Service area'];
    } else if (ind.includes('pest')) {
      replies = hasAppointment
        ? ['Book an inspection', 'Get a quote', 'Service area', 'Emergency service']
        : ['Get a quote', 'Service area', 'What pests?', 'Emergency service'];
    } else if (ind.includes('moving') || ind.includes('move')) {
      replies = hasAppointment
        ? ['Get a quote', 'Book a date', 'Service area', 'What do you move?']
        : ['Get a quote', 'Service area', 'What do you move?', 'Hours & availability'];
    }
  }

  return {
    question: replies.slice(0, 4),
    emergency: emergencyReplies.slice(0, 4)
  };
}

function buildSystemPrompt(data) {
  const { bizName, botName, services, hours, area, faqs, differentiators,
    licensing, emergency, seasonal, googleReviewLink, tone, leadCapture, industry, features } = data;
  const name = botName || (bizName + ' Assistant');
  const toneDesc = tone === 'professional' ? 'Professional and polished' :
    tone === 'casual' ? 'Casual and friendly' : 'Friendly and conversational';

  return `You are ${name}, the AI chat assistant for ${bizName}. You help answer questions, capture leads, and provide excellent customer service 24/7.

Keep every response to 2-3 sentences maximum. Be ${toneDesc.toLowerCase()}, like a knowledgeable friend, not a salesperson. Never use markdown formatting, bullet points, bold text, or emojis. Plain conversational sentences only.

ABOUT THE BUSINESS:
Business Name: ${bizName}
${industry ? 'Industry: ' + industry : ''}
${services ? 'Services: ' + services : ''}
${hours ? 'Business Hours: ' + hours : ''}
${area ? 'Service Area: ' + area : ''}
${differentiators ? 'What Sets Us Apart: ' + differentiators : ''}
${licensing ? 'Licensing/Insurance: ' + licensing : ''}
${emergency ? 'Emergency Services: ' + emergency : ''}
${seasonal ? 'Seasonal Notes: ' + seasonal : ''}
${faqs ? 'FAQs: ' + faqs : ''}

LEAD COLLECTION:
${leadCapture === 'name_only' ? 'Collect the customer name only. Then let them know someone will follow up.' :
  leadCapture === 'name_email' ? 'Collect the customer name and email address through natural conversation.' :
  'Naturally collect the customer name then phone number through conversation. Never ask again once collected.'}

Once you have the required contact info, output this trigger exactly at the very end of your response on its own line:
LEAD_CAPTURED|[name]|[phone_or_email]|[job type or Not specified]|[urgency or Not specified]

Never show this trigger to the customer. Never mention it.

PERSONALITY: Vary your responses naturally. Sound like a real person, not a script.
LANGUAGE: Respond in whatever language the customer writes in.
HONESTY: If you don't know something, say so and offer to have someone follow up.
NEVER: Use markdown. Make up features or prices. Be pushy. Show the LEAD_CAPTURED trigger. Say someone is coming or on their way before collecting name and number. Ask what the call is about after already collecting contact info — just confirm what you got and offer to help. Once you have name and phone, confirm back naturally like 'Got it, [name] at [number] — someone will be in touch shortly. Anything else I can help with?' then answer any questions they have.`;
}

app.post('/signup', async (req, res) => {
  const { ownerName, bizName, email, phone, website, industry, area, hours, services, faqs, tone, differentiators, licensing, emergency, seasonal, botPersonality, billing, hearAbout, googleReviewLink, botColor, features, alertEmail, reviewColor, campaignListSize, campaignListFormat, extraCampaigns, leadCapture } = req.body;
  if (!email || !bizName) return res.status(400).json({ error: 'email and bizName are required' });

  // Normalize plan label to plan code
  let pkg = req.body.package || req.body.pkg || '';
  if (pkg.includes('Chat') && pkg.includes('Review') && pkg.includes('Campaign')) pkg = 'all';
  else if (pkg.includes('Chat') && pkg.includes('Review')) pkg = 'bundle';
  else if (pkg.includes('Chat') && pkg.includes('Campaign')) pkg = 'bot_campaign';
  else if (pkg.includes('Review') && pkg.includes('Campaign')) pkg = 'review_campaign';
  else if (pkg.includes('Chat') || pkg === 'bot') pkg = 'bot';
  else if (pkg.includes('Review')) pkg = 'review';
  else if (pkg.includes('Campaign')) pkg = 'campaign';
  else if (!pkg) pkg = 'bot';

  const pkgLabel = 
    pkg === 'all'           ? 'All Products Bundle (Chat + Review + Campaigns) — 15% off' :
    pkg === 'bundle'        ? 'Chat + Review Bundle — 15% off ($297.50/mo)' :
    pkg === 'bot_campaign'  ? 'Chat + Campaigns Bundle — 15% off ($382.50/mo)' :
    pkg === 'review_campaign' ? 'Review + Campaigns Bundle — 15% off ($255/mo)' :
    pkg === 'review'        ? 'Review Filter — $100/mo' :
    pkg === 'campaign'      ? 'Reactivation Campaigns — $200/mo' :
                              '24/7 Chat Assistant — $250/mo';
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
    'REVIEW ALERT EMAIL: ' + (alertEmail || 'Not provided'),
    'BOT COLOR (set ACCENT_COLOR in widget code to this): ' + (botColor || '#2563eb'),
    'LEAD CAPTURE TYPE: ' + (leadCapture || 'name_phone'),
    'OPTIONAL FEATURES: ' + (features ? JSON.stringify(features) : 'None selected'),
    'BOT TONE: ' + (tone || 'Friendly and casual'),
    'BOT PERSONALITY NAME: ' + botName, '',
    // Campaign fields (only if they signed up for campaigns)
    ...(pkg && pkg.includes('campaign') || pkg === 'all' ? [
      'CAMPAIGN LIST SIZE: ' + (campaignListSize || 'Not provided'),
      'CAMPAIGN LIST FORMAT: ' + (campaignListFormat || 'Not provided'),
      'EXTRA CAMPAIGNS PER YEAR: ' + (extraCampaigns || '0'), ''
    ] : []),
    '===== END OF CLIENT DATA ====='
  ].join('\n');


  // Generate bizKey early so it's available in the email template
  const bizKey = bizName.toLowerCase().replace(/[^a-z0-9]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '') + '_' + Math.floor(1000 + Math.random() * 9000);

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
            <p style="margin:0 0 8px"><strong>Heard about us:</strong> ${hearAbout || 'Not provided'}</p>
            <p style="margin:0;background:#f0fdf4;border-radius:6px;padding:8px 12px;"><strong>Portal Access Code:</strong> <span style="font-family:monospace;font-weight:700;color:#15803d;">${bizKey}</span> — send this to the client so they can log into their portal</p>
          </div>
          <div style="background:#0A2540;border-radius:10px;padding:20px;">
            <p style="color:#93C5FD;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 12px;">Client Data — view and edit in admin tool</p>
            <p style="color:rgba(255,255,255,0.5);font-size:12px;margin:0 0 12px;">Manage this client at: <a href="https://netifybuilds.com/admin" style="color:#93C5FD;">netifybuilds.com/admin</a></p>
            <pre style="color:#e2e8f0;font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-word;margin:0;font-family:monospace;">${botBuilderData}</pre>
          </div>
          <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;margin-top:16px;">
            <p style="color:#15803d;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;margin:0 0 10px;">Widget Install Code — send this to client</p>
            <p style="color:#374151;font-size:13px;margin:0 0 10px;">Paste this before the closing &lt;/body&gt; tag on their website:</p>
            <pre style="background:#0f172a;color:#4ade80;font-size:11px;padding:14px;border-radius:8px;white-space:pre-wrap;word-break:break-all;margin:0 0 14px;font-family:monospace;">&lt;!-- Netify Builds Chat Widget --&gt;
&lt;script&gt;
window.__nb={bizKey:'${bizKey}',bizName:${JSON.stringify(bizName)},botName:${JSON.stringify(botName || bizName + ' Assistant')},accentColor:'${botColor || '#0A2540'}',backend:'https://botbuilder-backend-production.up.railway.app',leadEmail:${JSON.stringify(email)}};
&lt;/script&gt;
&lt;script src="https://netifybuilds.com/widget-loader.js"&gt;&lt;/script&gt;</pre>
            <ol style="color:#374151;font-size:13px;line-height:2;margin:0;padding-left:18px;">
              <li>Send the install code above to the client or their web developer</li>
              ${pkg === 'review' || pkg === 'bundle' || pkg === 'all' || pkg === 'review_campaign' ? '<li>Review filter is ready automatically — just make sure their Google review link is saved in their client record</li>' : ''}
              ${pkg === 'campaign' || pkg === 'all' || pkg === 'bot_campaign' || pkg === 'review_campaign' ? '<li>Get their customer list for campaigns</li>' : ''}
              <li>Bot stays inactive until they hit Activate in the portal — no subscription starts until then</li>
            </ol>
          </div>
          <p style="color:#999;font-size:12px;margin-top:20px;text-align:center;">Sent by Netify Builds</p>
        </div>`,
      }),
    });
    if (!response.ok) return res.status(500).json({ error: 'Email send failed' });

    // Auto-register client in portal system
    // bizKey already declared above
    // Extract domain from website URL
    let clientDomain = '';
    if (website) {
      try { clientDomain = new URL(website.startsWith('http') ? website : 'https://' + website).hostname; } catch(e) {}
    }
     clientInfo[bizKey] = {
       bizName: bizName,
       plan: pkg || 'faq',
       email: email,
       phone: phone || '',
       industry: industry || '',
       activated: false,
       registeredAt: new Date().toISOString(),
       googleReviewLink: googleReviewLink || '',
       campaignListSize: campaignListSize || '',
       campaignListFormat: campaignListFormat || '',
       domain: clientDomain,
       botName: botName || (bizName + ' Assistant'),
       botColor: botColor || '#0A2540',
       services: services || '',
       hours: hours || '',
       area: area || '',
       faqs: faqs || '',
       differentiators: differentiators || '',
       tone: tone || 'friendly',
       leadCapture: leadCapture || 'name_phone',
       emergency: emergency || '',
       features: features || ''
     };


    // Build and store system prompt automatically
    const qr = buildQuickReplies({
      plan: pkg, features, industry,
      calendarConnected: false
    });
    clientInfo[bizKey].quickReplies = qr.question || qr;
    clientInfo[bizKey].emergencyReplies = qr.emergency || [];
    clientInfo[bizKey].systemPrompt = buildSystemPrompt({
      bizName, botName: clientInfo[bizKey].botName, services, hours, area, faqs,
      differentiators, licensing, emergency, seasonal, googleReviewLink, tone, leadCapture, industry,
      features: (features || '').toLowerCase()
    });
    debouncedSave('client_info.json', clientInfo);
    // Schedule welcome sequence follow-ups — delayed to start from activation not signup
    // Day 3 and Day 7 emails are intentionally kept as-is since they relate to setup not subscription
    scheduleWelcomeSequence(email, ownerName, bizName, pkg, website);

    res.json({ success: true, bizKey });
  } catch (err) {
    console.error('[Signup Error]', err.message);
    res.status(500).json({ error: 'Signup email failed' });
  }
});


app.post('/extract-website', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url is required' });

  try {
    // Fetch the website
    const targetUrl = url.startsWith('http') ? url : 'https://' + url;
    const siteRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Cache-Control': 'no-cache'
      },
      signal: AbortSignal.timeout(15000),
      redirect: 'follow'
    });
    if (!siteRes.ok) return res.status(400).json({ error: 'Could not fetch website (status ' + siteRes.status + ').' });

    const html = await siteRes.text();

    // Strip down to readable text
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
      .trim()
      .substring(0, 12000);

    if (text.length < 100) return res.status(400).json({ error: 'Not enough content on page.' });

    const extractPrompt = `You are a strict data extractor. Your only job is to extract information that is EXPLICITLY and CLEARLY stated in the website text below.

RULES — you must follow these exactly:
- Only extract text that is clearly written on the page. Word-for-word or very close to it.
- If a field is not clearly stated, return null for that field. Do not guess, infer, or fill in anything.
- Do not summarize creatively. Do not make up plausible-sounding details.
- Do not combine vague hints into a conclusion. If it is not explicit, it is null.
- Return ONLY a valid JSON object. No preamble, no explanation, no markdown.

Extract these fields:
- services: A plain list of specific services mentioned by name. If only vague descriptions like "we help you" appear with no specific service names listed, return null. Return as a JSON array of strings, one service per item.
- hours: Business hours exactly as written. If not stated, return null.
- area: The geographic service area or locations served, exactly as written. Do not use the business address as the service area. If not stated, return null.
- faqs: Up to 5 question-answer pairs that are explicitly on the page (e.g. an FAQ section). If no FAQ section exists, return null.
- differentiators: Only include if the site explicitly states what makes them different (e.g. "family owned since 1998", "licensed and insured", "same-day service guaranteed"). If nothing specific is stated, return null. Return as a JSON array of strings, one item per differentiator. Do not join them with commas into a single string.
- emergency: Emergency or after-hours phone number, only if explicitly listed as such. If not stated, return null.
- licensing: Any licensing, insurance, or certification info explicitly stated. If not stated, return null.
- googleReviewLink: A Google review link if one appears on the page. If not present, return null.

WEBSITE TEXT:
${text}`;

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      system: 'You are a strict data extractor. Return only valid JSON. No markdown, no backticks, no explanation.',
      messages: [{ role: 'user', content: extractPrompt }],
    });

    const raw = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();

    // Safe parse — strip any accidental markdown fences
    const clean = raw.replace(/^```json|^```|```$/gm, '').trim();
    let extracted;
    try {
      extracted = JSON.parse(clean);
    } catch(e) {
      console.error('[Extract] JSON parse failed:', clean.substring(0, 200));
      return res.status(500).json({ error: 'Failed to parse extracted data.' });
    }

    console.log('[Extract] Success for', url, '— fields found:', Object.entries(extracted).filter(([k,v]) => v !== null).map(([k]) => k).join(', '));
    res.json({ success: true, data: extracted });

  } catch (err) {
    console.error('[Extract Error]', err.message);
    if (err.name === 'TimeoutError') return res.status(400).json({ error: 'Website took too long to load.' });
    res.status(500).json({ error: 'Extract failed: ' + err.message });
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
  const { name, contact, feedback, transcript, urgent, businessEmail, businessName, ownerPhone } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail is required' });

  // Feature 3: Urgent SMS alert to business owner
  if (urgent && ownerPhone && process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    try {
      const urgentSMS = 'URGENT: ' + (businessName || 'Your business') + ' received negative feedback that needs immediate attention. Log into your Netify Builds portal to review it now. Reply STOP to opt out.';
      await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER, To: ownerPhone, Body: urgentSMS }).toString()
      });
      console.log('[Urgent SMS] Sent to', ownerPhone, 'for', businessName);
    } catch(smsErr) {
      console.error('[Urgent SMS Error]', smsErr.message);
    }
  }

  const subjectPrefix = urgent ? '🚨 URGENT — ' : '⚠️ ';
  const transcriptHtml = transcript
    ? transcript.map(function(m) {
        const isBot = m.role === 'bot';
        return '<div style="margin-bottom:8px;display:flex;flex-direction:column;align-items:' + (isBot ? 'flex-start' : 'flex-end') + '"><div style="max-width:85%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;background:' + (isBot ? '#f1f5f9;color:#0f172a' : '#2563eb;color:white') + '">' + m.text + '</div><div style="font-size:10px;color:#94a3b8;margin-top:3px;">' + (isBot ? 'Bot' : 'Customer') + '</div></div>';
      }).join('')
    : '<p style="color:#94a3b8;font-size:13px;">No transcript available</p>';

  // Feature 4: Generate suggested response
  let suggestedResponse = '';
  if (feedback) {
    try {
      const suggestionRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: 'You write short, professional, empathetic responses for small business owners to send to unhappy customers. 2-3 sentences max. Acknowledge the issue, apologize sincerely, offer to make it right. Plain text only, no formatting.',
        messages: [{ role: 'user', content: 'Customer feedback: ' + feedback + '\nBusiness name: ' + (businessName || 'our business') }]
      });
      suggestedResponse = suggestionRes.content[0].text.trim();
    } catch(e) { console.error('[Suggestion Error]', e.message); }
  }
  const suggestionBlock = suggestedResponse
    ? '<div style="background:#f0f9ff;border-radius:10px;padding:16px;margin:12px 0;border-left:4px solid #0891b2;"><p style="font-size:13px;font-weight:700;color:#0369a1;margin:0 0 8px;">Suggested response to send this customer:</p><p style="font-size:14px;color:#1e3a5f;margin:0;line-height:1.6;font-style:italic;">"' + suggestedResponse + '"</p></div>'
    : '';

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: businessEmail,
        subject: subjectPrefix + 'Private Feedback -- ' + (businessName || 'your business'),
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:24px;background:#fff7ed;border-radius:12px;border:1px solid #fed7aa;">
          ${urgent ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;font-weight:600;color:#dc2626;">⚠️ This feedback contains urgent language — respond as soon as possible.</div>' : ''}
          <h2 style="color:#c2410c;margin-bottom:4px;">Private Feedback Received</h2>
          <p style="color:#555;font-size:14px;margin-bottom:20px;">A customer left private feedback. This has not been posted publicly.</p>
          <div style="background:white;border-radius:10px;padding:16px 20px;border:1px solid #e5e7eb;margin-bottom:20px;">
            <p style="margin:0 0 8px;font-size:14px;"><strong>Name:</strong> ${name || 'Not provided'}</p>
            <p style="margin:0 0 8px;font-size:14px;"><strong>Contact:</strong> ${contact || 'Not provided'}</p>
            <p style="margin:0;font-size:14px;"><strong>Issue:</strong> ${feedback || 'Not provided'}</p>
          </div>
          ${suggestionBlock}
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
  const { bizKey, bizName, plan, email, googleReviewLink, domain, secret } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  clientInfo[bizKey.toLowerCase()] = { bizName, plan: plan || 'bot', email, googleReviewLink: googleReviewLink || '', domain: domain || '', activated: false, registeredAt: new Date().toISOString() };
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

app.post('/activate-client', async (req, res) => {
  const { bizKey } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  const key = bizKey.toLowerCase();
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  // Prevent activation if already activated
  if (clientInfo[key].activated) return res.json({ success: true, alreadyActivated: true });

  // Don't mark as activated yet -- wait for Stripe payment confirmation
  // Just notify Eli that the client is heading to Stripe
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'dolbeereli95@gmail.com',
        subject: '💳 Client heading to Stripe -- ' + (clientInfo[key].bizName || key),
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#eff6ff;border-radius:12px;border:1px solid #bfdbfe;">
          <h2 style="color:#1d4ed8;margin-bottom:8px;">Client hitting Activate</h2>
          <p style="color:#374151;font-size:14px;margin-bottom:16px;"><strong>${clientInfo[key].bizName || key}</strong> clicked Activate and is being sent to Stripe to pay.</p>
          <div style="background:white;border-radius:8px;padding:14px;border:1px solid #e5e7eb;font-size:13px;color:#374151;">
            <p><strong>Business:</strong> ${clientInfo[key].bizName || key}</p>
            <p><strong>Email:</strong> ${clientInfo[key].email || 'Not on file'}</p>
            <p><strong>Time:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
            <p><strong>Plan:</strong> ${clientInfo[key].plan || 'Not specified'}</p>
          </div>
          <p style="color:#1d4ed8;font-size:13px;font-weight:600;margin-top:16px;">Bot will be marked active once Stripe confirms payment.</p>
        </div>`
      })
    });
  } catch(e) { console.error('[Activate email error]', e.message); }

  res.json({ success: true, pendingPayment: true });
});

// ── TRIGGER-BASED REACTIVATION CAMPAIGNS ──

// Check and fire triggered campaigns
async function checkTriggerCampaigns() {
  const now = new Date();
  const month = now.getMonth() + 1; // 1-12
  const day = now.getDate();

  // Seasonal triggers by industry
  const seasonalTriggers = {
    'HVAC': [
      { months: [4, 5], message: 'Summer is coming fast. Have you had your AC checked yet? A quick tune-up now can save you from a breakdown on the hottest day of the year. Reply STOP to opt out.' },
      { months: [9, 10], message: 'Cold weather is right around the corner. Get your furnace checked before the first freeze so you\'re not scrambling when it matters most. Reply STOP to opt out.' },
    ],
    'Plumbing': [
      { months: [11, 12], message: 'Frozen pipes are one of the most expensive plumbing emergencies. A quick winterization check now can save you thousands. Reply STOP to opt out.' },
      { months: [3, 4], message: 'Spring is a great time to check for any pipe damage from winter. Catch small leaks before they become big problems. Reply STOP to opt out.' },
    ],
    'Roofing': [
      { months: [3, 4], message: 'Winter can be tough on roofs. Spring is the perfect time for an inspection to catch any damage before summer storms. Reply STOP to opt out.' },
      { months: [9], message: 'Before winter sets in, it\'s worth having your roof inspected. Small issues now can turn into big leaks when the snow hits. Reply STOP to opt out.' },
    ],
    'Landscaping': [
      { months: [3, 4], message: 'Spring is here -- perfect time to get your yard looking great again. Reply STOP to opt out.' },
      { months: [10], message: 'Fall cleanup time. Let us get your yard ready for winter before the first frost. Reply STOP to opt out.' },
    ],
    'Cleaning Service': [
      { months: [3, 4], message: 'Spring cleaning season is here. Book now before our schedule fills up. Reply STOP to opt out.' },
      { months: [11], message: 'The holidays are coming. Let us get your home guest-ready before the rush. Reply STOP to opt out.' },
    ],
    'Pest Control': [
      { months: [4, 5], message: 'Pest season is starting. Get ahead of it with a preventative treatment now before infestations start. Reply STOP to opt out.' },
      { months: [9], message: 'As temperatures drop pests look for warm places to hide -- like your home. A fall treatment keeps them out. Reply STOP to opt out.' },
    ],
  };

  // Only run on the 1st of each month to avoid spamming
  if (day !== 1) return;

  for (const bizKey of Object.keys(clientInfo)) {
    try {
    const client = clientInfo[bizKey];
    if (!client.activated) continue;
    const plan = client.plan || '';
    if (['campaign','bot_campaign','review_campaign','all'].indexOf(plan) === -1) continue;
    if (!client.phone) continue;

    const industry = client.industry || '';
    const triggers = seasonalTriggers[industry] || [];
    const trigger = triggers.find(t => t.months.includes(month));

    if (!trigger) continue;

    // Check we haven't already sent this month
    const lastKey = 'triggered_' + bizKey + '_' + now.getFullYear() + '_' + month;
    if (client[lastKey]) continue;

    // Check if Twilio is configured
    if (!process.env.TWILIO_ACCOUNT_SID) continue;

    // Get their customer list from sms jobs
    const logs = reviewLogs[bizKey] || [];
    const customers = [...new Set(logs.filter(r => r.customerPhone).map(r => ({ phone: r.customerPhone, name: r.customerName || '' })))];

    if (customers.length === 0) continue;

    console.log('[Trigger Campaign] Firing for', bizKey, 'industry:', industry, 'month:', month, 'customers:', customers.length);

    // Send to each customer with a small delay — each wrapped in its own try/catch
    let sent = 0;
    for (const customer of customers.slice(0, 100)) {
      try {
        const firstName = customer.name ? customer.name.split(' ')[0] : '';
        const message = firstName ? 'Hey ' + firstName + '! ' + trigger.message : trigger.message;
        await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
          method: 'POST',
          headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER, To: customer.phone, Body: message }).toString()
        });
        sent++;
      } catch(smsErr) {
        console.error('[Trigger SMS Error] Failed for', customer.phone, ':', smsErr.message);
        // Continue to next customer regardless of failure
      }
      await new Promise(r => setTimeout(r, 200));
    }

    // Mark as sent for this month
    clientInfo[bizKey][lastKey] = new Date().toISOString();
    debouncedSave('client_info.json', clientInfo);

    // Email Eli summary
    try {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to: 'dolbeereli95@gmail.com',
          subject: 'Trigger campaign fired -- ' + (client.bizName || bizKey),
          html: '<div style="font-family:sans-serif;padding:24px;"><h3>Trigger campaign sent</h3><p><strong>Client:</strong> ' + (client.bizName || bizKey) + '</p><p><strong>Industry:</strong> ' + industry + '</p><p><strong>Sent to:</strong> ' + sent + ' customers</p><p><strong>Message:</strong> ' + trigger.message + '</p></div>'
        })
      });
    } catch(e) {}
    } catch(clientErr) { console.error('[Trigger Client Error]', bizKey, clientErr.message); }
  }
}

// Run trigger check on server start and every 24 hours
checkTriggerCampaigns();
setInterval(checkTriggerCampaigns, 24 * 60 * 60 * 1000);

// Manual trigger endpoint for testing
app.post('/trigger-campaigns', async (req, res) => {
    try {
const { secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  await checkTriggerCampaigns();
  res.json({ success: true });

  } catch(e) { console.error('[/trigger-campaigns Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── INBOUND SMS WEBHOOK (Twilio) ──
// Twilio calls this when a customer replies to a review request text
// ── MISSED CALL TEXT BACK ──

// Twilio hits this when a call comes in -- we respond with TwiML to ring the owner
// and set a status callback for when the call ends
app.post('/call-inbound', async (req, res) => {
  try {
    const { From, To, CallSid } = req.body;
    console.log('[Call Inbound]', From, '->', To);

    // Find which client owns this Twilio number
    const bizKey = Object.keys(clientInfo).find(function(k) {
      return clientInfo[k].twilioNumber === To || clientInfo[k].forwardingNumber === To;
    });

    if (bizKey && clientInfo[bizKey].ownerPhone) {
      // Ring the owner's real phone, with status callback
      const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial action="/call-status?bizKey=${bizKey}&callerPhone=${encodeURIComponent(From)}" timeout="20" callerId="${To}">
    <Number>${clientInfo[bizKey].ownerPhone}</Number>
  </Dial>
</Response>`;
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send(twiml);
    }

    // No client found -- just ring through
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  } catch(e) {
    console.error('[/call-inbound Error]', e.message);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
});

// Twilio hits this after the call ends -- if unanswered, fire the text back
app.post('/call-status', async (req, res) => {
  try {
    const { DialCallStatus, bizKey, callerPhone } = req.query;
    const { From } = req.body;
    const caller = callerPhone || From;

    console.log('[Call Status]', bizKey, 'dial status:', DialCallStatus, 'caller:', caller);

    // If call was not answered, send text back
    if ((DialCallStatus === 'no-answer' || DialCallStatus === 'busy' || DialCallStatus === 'failed') && bizKey && caller) {
      const client = clientInfo[bizKey];
      if (!client) return res.status(200).send('<Response></Response>');

      const bizName = client.bizName || 'us';
      const greeting = `Hey, sorry we missed your call! This is ${bizName}. What can we help you with?`;

      // Send text back to caller
      await fetch(`https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_ACCOUNT_SID}/Messages.json`, {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          From: process.env.TWILIO_PHONE_NUMBER,
          To: caller,
          Body: greeting
        }).toString()
      });

      // Start a bot SMS session for this caller
      if (!smsSessionStore[caller]) {
        smsSessionStore[caller] = {
          bizKey: bizKey,
          stage: 'bot_conversation',
          messages: [{ role: 'assistant', content: greeting }],
          startedAt: new Date().toISOString(),
          source: 'missed_call'
        };
      }

      console.log('[Missed Call Text Back] Sent to', caller, 'for', bizKey);
    }

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  } catch(e) {
    console.error('[/call-status Error]', e.message);
    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send('<Response></Response>');
  }
});

app.post('/sms-inbound', async (req, res) => {
    try {
const { Body, From, To } = req.body;
  if (!Body || !From) return res.status(200).send('<Response></Response>');

  const reply = Body.trim().toLowerCase();
  const phone = From;

  // Find which client this phone number belongs to by checking sms_sessions
  const session = smsSessionStore[phone];

  // Handle STOP/HELP
  if (reply === 'stop' || reply === 'help') {
    return res.status(200).send('<Response></Response>');
  }

  // Check if this is an owner replying to a handoff session
  const handoff = handoffStore[phone];
  if (handoff && handoff.active) {
    if (reply === 'done') {
      // Owner ended the handoff
      const sid = handoff.sessionId;
      if (handoffStore[sid]) handoffStore[sid].active = false;
      delete handoffStore[phone];
      res.setHeader('Content-Type', 'text/xml');
      return res.status(200).send('<Response><Message>Handoff ended. The customer has been notified.</Message></Response>');
    }
    // Store owner reply for widget to pick up
    const sid = handoff.sessionId;
    if (handoffStore[sid]) handoffStore[sid].pendingReply = Body.trim();
    res.setHeader('Content-Type', 'text/xml');
    return res.status(200).send('<Response><Message>Delivered to customer.</Message></Response>');
  }

  let responseText = '';

  if (session && session.stage === 'awaiting_rating') {
    const rating = parseInt(reply);
    if (isNaN(rating) || rating < 1 || rating > 5) {
      responseText = 'Please reply with a number from 1 to 5.';
    } else if (rating >= 4) {
      // Happy customer — send Google review link
      const googleLink = session.googleReviewLink || '';
      responseText = 'We\'re so glad to hear that! If you have a moment, a Google review would mean the world to us: ' + googleLink;
      // Log as positive
      const key = session.bizKey;
      if (!reviewLogs[key]) reviewLogs[key] = [];
      reviewLogs[key].push({
        type: 'positive',
        feedback: 'SMS review: rated ' + rating + '/5',
        name: session.customerName || 'SMS Customer',
        contact: phone,
        date: new Date().toISOString(),
        source: 'sms'
      });
      debouncedSave('review_logs.json', reviewLogs);
      smsSessionStore[phone] = { ...session, stage: 'complete', rating };
    } else {
      // Unhappy customer — ask for feedback
      responseText = 'We\'re sorry to hear that. Would you mind telling us what went wrong? Your feedback helps us improve.';
      smsSessionStore[phone] = { ...session, stage: 'awaiting_feedback', rating };
    }
  } else if (session && session.stage === 'awaiting_feedback') {
    // Log negative feedback
    const key = session.bizKey;
    if (!reviewLogs[key]) reviewLogs[key] = [];
    const urgentWords = ['lawyer','attorney','sue','refund','fraud','terrible','horrible','worst','furious','scam'];
    const isUrgent = urgentWords.some(w => reply.includes(w));
    reviewLogs[key].push({
      type: 'negative',
      feedback: Body.trim(),
      name: session.customerName || 'SMS Customer',
      contact: phone,
      date: new Date().toISOString(),
      source: 'sms',
      resolved: false
    });
    debouncedSave('review_logs.json', reviewLogs);

    // Email the business owner
    const client = clientInfo[key] || {};
    if (client.email) {
      try {
        await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'onboarding@resend.dev',
            to: client.email,
            bcc: 'dolbeereli95@gmail.com',
            subject: (isUrgent ? '🚨 URGENT -- ' : '⚠️ ') + 'Private SMS Feedback -- ' + (client.bizName || key),
            html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#fff7ed;border-radius:12px;border:1px solid #fed7aa;">
              <h2 style="color:#c2410c;margin-bottom:4px;">Private Feedback via SMS</h2>
              <p style="color:#555;font-size:14px;margin-bottom:16px;">A customer replied to your review request with negative feedback.</p>
              <div style="background:white;border-radius:10px;padding:16px;border:1px solid #e5e7eb;margin-bottom:16px;">
                <p style="font-size:14px;margin:0 0 8px;"><strong>Customer:</strong> ${session.customerName || 'Unknown'}</p>
                <p style="font-size:14px;margin:0 0 8px;"><strong>Phone:</strong> ${phone}</p>
                <p style="font-size:14px;margin:0 0 8px;"><strong>Rating:</strong> ${session.rating}/5</p>
                <p style="font-size:14px;margin:0;"><strong>Feedback:</strong> ${Body.trim()}</p>
              </div>
              <p style="color:#c2410c;font-size:13px;font-weight:600;">A quick follow-up call can often prevent a bad Google review.</p>
              <p style="color:#999;font-size:12px;margin-top:16px;text-align:center;">Sent by Netify Builds</p>
            </div>`
          })
        });
      } catch(e) { console.error('[SMS Feedback Email Error]', e.message); }

      // Urgent SMS to owner
      if (isUrgent && client.phone && process.env.TWILIO_ACCOUNT_SID) {
        try {
          await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
            method: 'POST',
            headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER, To: client.phone, Body: 'URGENT: A customer left urgent negative feedback via SMS. Check your Netify Builds portal now. Reply STOP to opt out.' }).toString()
          });
        } catch(e) {}
      }
    }

    responseText = 'Thank you for letting us know. We take all feedback seriously and will be in touch shortly.';
    smsSessionStore[phone] = { ...session, stage: 'complete' };
  } else if (session && session.stage === 'bot_conversation') {
    // Missed call text back -- run through the bot
    const key = session.bizKey;
    const client = clientInfo[key] || {};
    try {
      session.messages.push({ role: 'user', content: Body.trim() });
      const smsSystemPrompt = `You are a helpful assistant for ${client.bizName || 'a local service business'}. A customer missed your call and you texted them back. Keep replies short (1-2 sentences max, this is SMS). Naturally collect their name and what they need help with. Once you have their name and service needed, output LEAD_CAPTURED|[name]|[phone]|[job type]|[urgency] at the very end. Never show the trigger to the customer.`;
      const aiRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        system: smsSystemPrompt,
        messages: session.messages.slice(-6)
      });
      let botReply = aiRes.content[0].text;

      // Check for lead capture
      if (botReply.includes('LEAD_CAPTURED|')) {
        const parts = botReply.split('LEAD_CAPTURED|')[1].split('|');
        const leadName = parts[0] || 'Unknown';
        const leadPhone = phone;
        const jobType = parts[2] || 'General inquiry';
        const urgency = parts[3] || 'Normal';
        botReply = botReply.split('LEAD_CAPTURED|')[0].trim();

        // Email the owner
        if (client.email) {
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'onboarding@resend.dev',
              to: client.email,
              bcc: 'dolbeereli95@gmail.com',
              subject: 'Missed call lead captured -- ' + leadName + ' -- ' + (client.bizName || key),
              html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f0f9ff;border-radius:12px;border:1px solid #bae6fd;">
                <h2 style="color:#0369a1;">Missed Call Lead Captured</h2>
                <p style="color:#374151;font-size:14px;">Your bot texted back a missed call and captured a lead.</p>
                <div style="background:white;border-radius:10px;padding:16px;border:1px solid #e5e7eb;">
                  <p style="font-size:14px;margin:0 0 8px;"><strong>Name:</strong> ${leadName}</p>
                  <p style="font-size:14px;margin:0 0 8px;"><strong>Phone:</strong> ${leadPhone}</p>
                  <p style="font-size:14px;margin:0 0 8px;"><strong>Job:</strong> ${jobType}</p>
                  <p style="font-size:14px;margin:0;"><strong>Urgency:</strong> ${urgency}</p>
                </div>
                <p style="color:#0369a1;font-size:13px;font-weight:600;margin-top:16px;">Give them a call back when you get a chance.</p>
              </div>`
            })
          }).catch(function(e) { console.error('[Missed Call Lead Email]', e.message); });
        }
        session.stage = 'complete';
      }

      session.messages.push({ role: 'assistant', content: botReply });
      smsSessionStore[phone] = session;
      responseText = botReply;
    } catch(e) {
      console.error('[SMS Bot Error]', e.message);
      responseText = 'Thanks for your message. We\'ll be in touch soon!';
    }
  } else {
    // No session found -- generic response
    responseText = 'Thanks for your message. For help, contact us directly.';
  }

  // Send reply via TwiML
  const twiml = responseText
    ? '<Response><Message>' + responseText + '</Message></Response>'
    : '<Response></Response>';
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml);

  } catch(e) { console.error('[/sms-inbound Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── SMS SESSION STORE (in-memory, resets on redeploy -- acceptable for short sessions) ──
const smsSessionStore = {};

// ── CHAT HANDOFF STORE ──
// Links active website chats to owner SMS replies
const handoffStore = {};
// handoffStore[ownerPhone] = { bizKey, chatSessionId, customerMessages: [], active: true }
// handoffStore[chatSessionId] = { ownerPhone, bizKey, pendingReply: null }

// ── SEND REVIEW SMS WITH SESSION TRACKING ──
// Override /send-review-sms to track sessions for two-way flow
// (sessions stored in smsSessionStore keyed by customer phone)

// ── APPOINTMENT REQUEST ──
app.post('/appointment-request', async (req, res) => {
  const { bizKey, customerName, customerPhone, preferredDay, preferredTime, reason, businessEmail, businessName } = req.body;
  if (!businessEmail) return res.status(400).json({ error: 'businessEmail required' });

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: businessEmail,
        bcc: 'dolbeereli95@gmail.com',
        subject: 'New Appointment Request -- ' + (businessName || 'your business'),
        html: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f0f9ff;border-radius:12px;border:1px solid #bae6fd;">
          <h2 style="color:#0369a1;margin-bottom:8px;">New Appointment Request</h2>
          <p style="color:#374151;font-size:14px;margin-bottom:16px;">Someone requested an appointment through your website chat.</p>
          <div style="background:white;border-radius:8px;padding:16px;border:1px solid #e5e7eb;font-size:14px;color:#374151;">
            <p style="margin:0 0 8px;"><strong>Name:</strong> ${customerName || 'Not provided'}</p>
            <p style="margin:0 0 8px;"><strong>Phone:</strong> ${customerPhone || 'Not provided'}</p>
            <p style="margin:0 0 8px;"><strong>Preferred day:</strong> ${preferredDay || 'Flexible'}</p>
            <p style="margin:0 0 8px;"><strong>Preferred time:</strong> ${preferredTime || 'Flexible'}</p>
            <p style="margin:0;"><strong>Reason:</strong> ${reason || 'Not specified'}</p>
          </div>
          <p style="color:#0369a1;font-size:13px;font-weight:600;margin-top:16px;">Give them a call to confirm the appointment.</p>
        </div>`
      })
    });
    res.json({ success: true });
  } catch(e) {
    console.error('[Appointment Request Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// -- CONFIRM ACTIVATION (called by Stripe webhook after payment) --
app.post('/confirm-activation', async (req, res) => {
  const { bizKey, stripeCustomerId, secret } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const key = bizKey.toLowerCase();
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });

  clientInfo[key].activated = true;
  clientInfo[key].activatedAt = new Date().toISOString();
  if (stripeCustomerId) clientInfo[key].stripeCustomerId = stripeCustomerId;
  debouncedSave('client_info.json', clientInfo);

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'dolbeereli95@gmail.com',
        subject: '🟢 Payment confirmed -- ' + (clientInfo[key].bizName || key),
        html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px;background:#f0fdf4;border-radius:12px;border:1px solid #86efac;">
          <h2 style="color:#15803d;margin-bottom:8px;">Bot is now live</h2>
          <p style="color:#374151;font-size:14px;"><strong>${clientInfo[key].bizName || key}</strong> paid via Stripe. Bot is now activated.</p>
          <p style="color:#374151;font-size:13px;margin-top:8px;"><strong>Activated:</strong> ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
        </div>`
      })
    });
  } catch(e) {}

  res.json({ success: true });
});

app.get('/client-info/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  res.json(clientInfo[key] || { bizKey: key });
});
const conversationLogs = loadData('conversation_logs.json', {});
app.post('/log-conversation', (req, res) => {
  const { bizName, messages, leadCaptured, leadName, leadPhone, leadJobType, timestamp } = req.body;
  if (!bizName) return res.status(400).json({ error: 'bizName required' });
  const key = bizName.toLowerCase().replace(/\s+/g, '_');
  if (!conversationLogs[key]) conversationLogs[key] = [];
  conversationLogs[key].unshift({
    messages: messages || [],
    leadCaptured: leadCaptured || false,
    leadName: leadName || '',
    leadPhone: leadPhone || '',
    leadJobType: leadJobType || '',
    timestamp: timestamp || new Date().toISOString()
  });
  if (conversationLogs[key].length > 50) conversationLogs[key] = conversationLogs[key].slice(0, 50);
  debouncedSave('conversation_logs.json', conversationLogs);
  res.json({ success: true });
});

app.get('/conversations/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  res.json({ conversations: (conversationLogs[key] || []).slice(0, 20) });
});
// ── KNOWLEDGE BASE UPDATE ──
app.post('/update-knowledge', async (req, res) => {
  // Track portal activity for health score
  const { bizKey, bizName, update, ownerEmail } = req.body;
  if (bizKey && clientInfo[bizKey.toLowerCase()]) { clientInfo[bizKey.toLowerCase()].lastActivity = new Date().toISOString(); debouncedSave('client_info.json', clientInfo); }
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
  const { to, message, bizName, bizKey, customerName } = req.body;
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
        Body: message + '\n\nReply STOP to opt out.'
      }).toString()
    });
    const data = await response.json();
    if (data.error_code) throw new Error(data.message);
    console.log('[Review SMS] Sent to', to, 'for', bizName);

    // Store session for two-way flow
    if (bizKey) {
      const key = bizKey.toLowerCase();
      const client = clientInfo[key] || {};
      smsSessionStore[to] = {
        bizKey: key,
        bizName: bizName || client.bizName || '',
        customerName: customerName || '',
        googleReviewLink: client.googleReviewLink || '',
        stage: 'awaiting_rating',
        sentAt: new Date().toISOString()
      };
      // Auto-expire session after 7 days
      setTimeout(function() { delete smsSessionStore[to]; }, 7 * 24 * 60 * 60 * 1000);
    }

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
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
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
  const { businessName, type, feedback, name, contact, date } = req.body;
  if (!businessName) return res.status(400).json({ error: 'businessName required' });
  const key = businessName.toLowerCase().replace(/\s+/g, '_');
  if (!reviewLogs[key]) reviewLogs[key] = [];
  reviewLogs[key].push({ type, feedback, name: name || '', contact, date: date || new Date().toISOString() });
  debouncedSave('review_logs.json', reviewLogs);
  console.log('[Review Log]', businessName, type);
  res.json({ success: true });
});

app.get('/review-report/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
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


// ── RESOLVE FEEDBACK ──
app.post('/resolve-feedback', (req, res) => {
  const { bizKey, index, resolved } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  const key = bizKey.toLowerCase();
  const logs = reviewLogs[key] || [];
  // negativeFeedback is built from logs filtered to negative — find by index into that subset
  const negativeLogs = logs.filter(r => r.type === 'negative');
  if (index >= 0 && index < negativeLogs.length) {
    // Find this entry in the main logs array and update it
    const target = negativeLogs[index];
    const mainIdx = logs.indexOf(target);
    if (mainIdx >= 0) {
      reviewLogs[key][mainIdx].resolved = resolved;
      debouncedSave('review_logs.json', reviewLogs);
    }
  }
  res.json({ success: true });
});

// ── LOG SMS JOB ──
app.post('/log-sms-job', async (req, res) => {
  const { bizKey, customerName, customerPhone, jobType, delayHours } = req.body;
  if (!bizKey || !customerPhone) return res.status(400).json({ error: 'bizKey and customerPhone required' });
  const key = bizKey.toLowerCase();
  const client = clientInfo[key] || {};
  const bizName = client.bizName || bizKey;
  const googleLink = client.googleReviewLink || '';
  const delay = parseInt(delayHours) || 24;

  // Log the job
  if (!reviewLogs[key]) reviewLogs[key] = [];
  const jobEntry = {
    type: 'sms_job',
    customerName: customerName || 'Unknown',
    customerPhone,
    jobType: jobType || 'Not specified',
    delayHours: delay,
    loggedAt: new Date().toISOString(),
    sent: false
  };
  reviewLogs[key].push(jobEntry);
  debouncedSave('review_logs.json', reviewLogs);

  // Schedule the SMS send
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER) {
    setTimeout(async function() {
      try {
        var message;
        if (customerName && customerName.trim()) {
          var firstName = customerName.trim().split(' ')[0];
          message = 'Hey ' + firstName + '! Thanks for choosing ' + bizName + '. How did we do? Reply with a number from 1 to 5. Reply STOP to opt out.';
        } else {
          message = 'Hey! Thanks for choosing ' + bizName + '. How did we do? Reply with a number from 1 to 5. Reply STOP to opt out.';
        }
        await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
          method: 'POST',
          headers: {
            'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER, To: customerPhone, Body: message }).toString()
        });
        // Mark as sent
        const logs = reviewLogs[key] || [];
        const jobIdx = logs.indexOf(jobEntry);
        if (jobIdx >= 0) { reviewLogs[key][jobIdx].sent = true; debouncedSave('review_logs.json', reviewLogs); }
        console.log('[SMS Job] Review text sent to', customerPhone, 'for', bizName);
      } catch(err) {
        console.error('[SMS Job Error]', err.message);
      }
    }, delay * 60 * 60 * 1000);
  } else {
    console.log('[SMS Job] Twilio not configured — job logged but SMS not scheduled');
  }

  res.json({ success: true });
});

// ── BILLING PORTAL ──
app.post('/billing-portal', async (req, res) => {
  // Stripe not yet configured — return graceful message
  res.status(200).json({ error: 'Billing portal not yet configured. Email netifybuilds@gmail.com to manage your subscription.' });
});

// -- GOOGLE AUTH --
app.post('/auth/google', async (req, res) => {
  const { credential } = req.body;
  if (!credential) return res.status(400).json({ error: 'No credential provided' });
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const email = payload.email;
    if (!email) return res.status(400).json({ error: 'No email in token' });
    const match = Object.entries(clientInfo).find(function([key, val]) {
      return val.email && val.email.toLowerCase() === email.toLowerCase();
    });
    if (!match) return res.status(404).json({ error: 'No account found for ' + email + '. Use your access code or email netifybuilds@gmail.com.' });
    const [bizKey, clientData] = match;
    console.log('[Google Auth] Login:', email, '->', bizKey);
    res.json({ success: true, bizKey, bizName: clientData.bizName, email });
  } catch(err) {
    console.error('[Google Auth Error]', err.message);
    res.status(401).json({ error: 'Google sign-in failed. Please use your access code instead.' });
  }
});

// ── CHAT HANDOFF ENDPOINTS ──

// Widget calls this to request a live handoff
app.post('/request-handoff', async (req, res) => {
  const { bizKey, sessionId, customerMessage, bizName, businessPhone } = req.body;
  if (!bizKey || !sessionId) return res.status(400).json({ error: 'bizKey and sessionId required' });
  const key = bizKey.toLowerCase();
  const client = clientInfo[key] || {};
  const ownerPhone = businessPhone || client.phone || '';

  if (!ownerPhone) return res.json({ success: false, reason: 'no_phone' });
  if (!process.env.TWILIO_ACCOUNT_SID) return res.json({ success: false, reason: 'no_twilio' });

  // Store handoff session
  handoffStore[ownerPhone] = { bizKey: key, sessionId, active: true, startedAt: new Date().toISOString() };
  handoffStore[sessionId] = { ownerPhone, bizKey: key, pendingReply: null };

  // Text the owner
  const ownerMsg = 'A customer on your website wants to talk to someone.\n\nThey said: "' + (customerMessage || '').substring(0, 100) + '"\n\nReply to this text and your message will be delivered to them instantly. Reply DONE when finished.';


  try {
    await fetch('https://api.twilio.com/2010-04-01/Accounts/' + process.env.TWILIO_ACCOUNT_SID + '/Messages.json', {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + Buffer.from(process.env.TWILIO_ACCOUNT_SID + ':' + process.env.TWILIO_AUTH_TOKEN).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ From: process.env.TWILIO_PHONE_NUMBER, To: ownerPhone, Body: ownerMsg }).toString()
    });
    console.log('[Handoff] Started for', key, 'session', sessionId);
    res.json({ success: true });

    // Auto-expire after 30 minutes
    setTimeout(function() {
      if (handoffStore[ownerPhone] && handoffStore[ownerPhone].sessionId === sessionId) {
        delete handoffStore[ownerPhone];
        delete handoffStore[sessionId];
      }
    }, 30 * 60 * 1000);
  } catch(e) {
    console.error('[Handoff Error]', e.message);
    res.json({ success: false, reason: 'sms_failed' });
  }
});

// Widget polls this to get owner reply
app.get('/handoff-reply/:sessionId', (req, res) => {
  const session = handoffStore[req.params.sessionId];
  if (!session) return res.json({ active: false, reply: null });
  const reply = session.pendingReply;
  if (reply) session.pendingReply = null; // clear after reading
  res.json({ active: session.active !== false, reply });
});

app.get('/send-page/:bizKey', async (req, res) => {
    try {
const bizKey = req.params.bizKey.toLowerCase();
  const client = clientInfo[bizKey] || {};
  const bizName = client.bizName || bizKey.replace(/_\d+$/, '').replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  const googleLink = client.googleReviewLink || '';
  const twilioReady = !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1">
<title>Quick Send — ${bizName}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8fafc;min-height:100vh;padding:24px 16px;}
.card{background:white;border-radius:16px;padding:24px;box-shadow:0 2px 12px rgba(0,0,0,0.08);max-width:480px;margin:0 auto;}
h1{font-size:1.2rem;font-weight:700;color:#0A2540;margin-bottom:4px;}
.sub{font-size:13px;color:#64748b;margin-bottom:20px;line-height:1.5;}
label{display:block;font-size:12px;font-weight:600;color:#374151;margin-bottom:6px;text-transform:uppercase;letter-spacing:0.05em;}
input{width:100%;padding:12px 14px;border:1.5px solid #e2e8f0;border-radius:10px;font-size:15px;font-family:inherit;outline:none;margin-bottom:14px;}
input:focus{border-color:#2563eb;}
.btn{width:100%;padding:14px;background:#0A2540;color:white;border:none;border-radius:10px;font-size:15px;font-weight:700;cursor:pointer;font-family:inherit;}
.btn:disabled{opacity:0.5;cursor:not-allowed;}
.success{background:#f0fdf4;border:1.5px solid #86efac;border-radius:12px;padding:16px;margin-top:14px;display:none;text-align:center;}
.success-icon{font-size:32px;margin-bottom:8px;}
.success-msg{font-size:14px;font-weight:600;color:#15803d;}
.success-sub{font-size:12px;color:#64748b;margin-top:4px;}
.error{background:#fef2f2;border:1.5px solid #fecaca;border-radius:12px;padding:14px;margin-top:14px;display:none;font-size:13px;color:#dc2626;font-weight:600;}
.brand{text-align:center;font-size:11px;color:#94a3b8;margin-top:20px;}
</style>
</head>
<body>
<div class="card">
  <h1>${bizName}</h1>
  <p class="sub">Enter the customer's name and phone number — the review request text sends immediately.</p>
  <label>Customer Name</label>
  <input type="text" id="custName" placeholder="e.g. John Smith" autocomplete="off" />
  <label>Customer Phone</label>
  <input type="tel" id="custPhone" placeholder="(555) 867-5309" autocomplete="off" />
  <button class="btn" id="sendBtn" onclick="sendReview()">Send Review Request →</button>
  <div class="success" id="successBox">
    <div class="success-icon">✓</div>
    <div class="success-msg" id="successMsg">Review request sent!</div>
    <div class="success-sub" id="successSub"></div>
  </div>
  <div class="error" id="errorBox"></div>
</div>
<p class="brand">Powered by Netify Builds</p>
<script>
var BACKEND = 'https://botbuilder-backend-production.up.railway.app';
var BIZ_KEY = '${bizKey}';
var BIZ_NAME = '${bizName}';
var GOOGLE_LINK = '${googleLink}';
var TWILIO_READY = ${twilioReady};

async function sendReview() {
  var name = document.getElementById('custName').value.trim();
  var phone = document.getElementById('custPhone').value.trim();
  var errorBox = document.getElementById('errorBox');
  errorBox.style.display = 'none';

  if (!name) { document.getElementById('custName').focus(); return; }
  if (!phone) { document.getElementById('custPhone').focus(); return; }

  var firstName = name.split(' ')[0];
  var message = name ? ('Hey ' + firstName + '! Thanks for choosing ' + BIZ_NAME + '. How did we do? Reply with a number from 1 to 5. Reply STOP to opt out.') : ('Hey! Thanks for choosing ' + BIZ_NAME + '. How did we do? Reply with a number from 1 to 5. Reply STOP to opt out.');

  var btn = document.getElementById('sendBtn');
  btn.textContent = 'Sending...';
  btn.disabled = true;

  try {
    var res = await fetch(BACKEND + '/send-review-sms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to: phone, message: message, bizName: BIZ_NAME, bizKey: BIZ_KEY, customerName: name })
    });
    var data = await res.json();

    if (data.success) {
      document.getElementById('successBox').style.display = 'block';
      document.getElementById('successMsg').textContent = 'Review request sent to ' + firstName + '!';
      document.getElementById('successSub').textContent = phone;
      document.getElementById('custName').value = '';
      document.getElementById('custPhone').value = '';
      btn.textContent = 'Send Another →';
      btn.disabled = false;
    } else {
      throw new Error(data.error || 'Send failed');
    }
  } catch(err) {
    errorBox.textContent = 'Failed to send: ' + err.message + '. Check that Twilio is set up.';
    errorBox.style.display = 'block';
    btn.textContent = 'Send Review Request →';
    btn.disabled = false;
  }
}

['custName','custPhone'].forEach(function(id) {
  document.getElementById(id).addEventListener('keypress', function(e) {
    if (e.key === 'Enter') sendReview();
  });
});
</script>
</body>
</html>`);

  } catch(e) { console.error('[/send-page/:bizKey Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── CLIENT HEALTH SCORE ──
function calculateHealthScore(bizKey) {
  const key = bizKey.toLowerCase();
  const client = clientInfo[key];
  if (!client) return 0;

  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;
  const plan = client.plan || 'faq';
  const hasBot = ['bot','faq','bundle','bot_campaign','all'].indexOf(plan) !== -1;
  const hasReview = ['review','bundle','review_campaign','all'].indexOf(plan) !== -1;
  const hasCampaign = ['campaign','bot_campaign','review_campaign','all'].indexOf(plan) !== -1;

  let score = 0;
  let maxScore = 0;

  // Bot activity -- conversations and leads in last 30 days
  if (hasBot) {
    maxScore += 40;
    const analytics = analyticsLogs[key] || {};
    const convs = analytics.conversations || 0;
    const leads = analytics.leads || 0;
    score += Math.min(20, convs * 2); // up to 20 pts for conversations
    score += Math.min(20, leads * 4); // up to 20 pts for leads
  }

  // Review activity -- reviews sent in last 30 days
  if (hasReview) {
    maxScore += 40;
    const logs = reviewLogs[key] || [];
    const recentReviews = logs.filter(r => (now - new Date(r.date).getTime()) < 30 * day);
    score += Math.min(40, recentReviews.length * 4);
  }

  // Activation status
  maxScore += 10;
  if (client.activated) score += 10;

  // Portal engagement -- recently logged in (approximated by last update request)
  maxScore += 10;
  if (client.lastActivity && (now - new Date(client.lastActivity).getTime()) < 14 * day) {
    score += 10;
  }

  // Normalize to 0-100
  return maxScore > 0 ? Math.round((score / maxScore) * 100) : 0;
}

const healthScoreCache = {};
const HEALTH_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 hours

app.get('/health-score/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const cached = healthScoreCache[key];
  if (cached && (Date.now() - cached.ts) < HEALTH_CACHE_TTL) {
    return res.json(cached.data);
  }
  const score = calculateHealthScore(key);
  const label = score >= 70 ? 'Active' : score >= 40 ? 'Slowing down' : 'At risk';
  const color = score >= 70 ? '#15803d' : score >= 40 ? '#b45309' : '#dc2626';
  const data = { bizKey: key, score, label, color };
  healthScoreCache[key] = { data, ts: Date.now() };
  res.json(data);
});

// Weekly health report to Eli
async function sendWeeklyHealthReport() {
  const allKeys = Object.keys(clientInfo).filter(k => clientInfo[k].activated);
  if (allKeys.length === 0) return;

  const scores = allKeys.map(k => ({
    key: k,
    bizName: clientInfo[k].bizName || k,
    score: calculateHealthScore(k),
    label: calculateHealthScore(k) >= 70 ? 'Active' : calculateHealthScore(k) >= 40 ? 'Slowing down' : 'At risk',
    email: clientInfo[k].email || ''
  })).sort((a, b) => a.score - b.score);

  const atRisk = scores.filter(s => s.score < 40);
  const slowingDown = scores.filter(s => s.score >= 40 && s.score < 70);
  const active = scores.filter(s => s.score >= 70);

  const makeRow = (s) => `<tr><td style="padding:8px 12px;font-size:13px;color:#0f172a;">${s.bizName}</td><td style="padding:8px 12px;font-size:13px;font-weight:700;color:${s.score >= 70 ? '#15803d' : s.score >= 40 ? '#b45309' : '#dc2626'};">${s.score}/100</td><td style="padding:8px 12px;font-size:13px;color:#64748b;">${s.label}</td></tr>`;

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: 'dolbeereli95@gmail.com',
        subject: 'Weekly Client Health Report -- ' + new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric' }),
        html: `<div style="font-family:sans-serif;max-width:600px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px;">
          <h2 style="color:#0A2540;margin-bottom:4px;">Client Health Report</h2>
          <p style="color:#64748b;font-size:14px;margin-bottom:20px;">${allKeys.length} active clients</p>
          ${atRisk.length > 0 ? `<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:14px 16px;margin-bottom:16px;"><p style="font-size:13px;font-weight:700;color:#dc2626;margin:0 0 10px;">At Risk (${atRisk.length}) -- reach out this week</p><table style="width:100%;border-collapse:collapse;">${atRisk.map(makeRow).join('')}</table></div>` : ''}
          ${slowingDown.length > 0 ? `<div style="background:#fefce8;border:1px solid #fde68a;border-radius:8px;padding:14px 16px;margin-bottom:16px;"><p style="font-size:13px;font-weight:700;color:#b45309;margin:0 0 10px;">Slowing Down (${slowingDown.length})</p><table style="width:100%;border-collapse:collapse;">${slowingDown.map(makeRow).join('')}</table></div>` : ''}
          ${active.length > 0 ? `<div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:14px 16px;"><p style="font-size:13px;font-weight:700;color:#15803d;margin:0 0 10px;">Active (${active.length})</p><table style="width:100%;border-collapse:collapse;">${active.map(makeRow).join('')}</table></div>` : ''}
          <p style="color:#94a3b8;font-size:12px;text-align:center;margin-top:20px;">Sent by Netify Builds</p>
        </div>`
      })
    });
    console.log('[Health Report] Sent --', allKeys.length, 'clients');
  } catch(e) { console.error('[Health Report Error]', e.message); }
}

app.post('/send-health-report', async (req, res) => {
    try {
const { secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  await sendWeeklyHealthReport();
  res.json({ success: true });

  } catch(e) { console.error('[/send-health-report Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── MONTHLY REVIEW REPORT ──
async function sendMonthlyReviewReport(bizKey) {
  const key = bizKey.toLowerCase();
  const client = clientInfo[key];
  if (!client || !client.email) return;
  const logs = reviewLogs[key] || [];
  if (logs.length === 0) return;

  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  const monthName = monthStart.toLocaleString('en-US', { month: 'long', year: 'numeric' });

  const thisMonth = logs.filter(r => {
    const d = new Date(r.date);
    return d >= monthStart && d <= monthEnd;
  });

  const positive = thisMonth.filter(r => r.type === 'positive').length;
  const negative = thisMonth.filter(r => r.type === 'negative').length;
  const total = thisMonth.length;
  const allTime = logs.filter(r => r.type === 'positive').length;
  const satRate = total > 0 ? Math.round((positive / total) * 100) : 0;
  const negativeFeedback = thisMonth.filter(r => r.type === 'negative' && r.feedback);
  const unresolvedCount = negativeFeedback.filter(r => !r.resolved).length;

  const satColor = satRate >= 90 ? '#15803d' : satRate >= 70 ? '#b45309' : '#dc2626';
  const satBg = satRate >= 90 ? '#dcfce7' : satRate >= 70 ? '#fef9c3' : '#fee2e2';
  const satLabel = satRate >= 90 ? 'Excellent' : satRate >= 70 ? 'Good' : 'Needs attention';

  const negativeSummary = negativeFeedback.length > 0
    ? negativeFeedback.slice(0, 3).map(f => '<li style="font-size:13px;color:#374151;margin-bottom:8px;line-height:1.6;">' + (f.feedback || 'No details').substring(0, 120) + (f.feedback && f.feedback.length > 120 ? '...' : '') + '</li>').join('')
    : '<li style="font-size:13px;color:#15803d;">No negative feedback this month.</li>';

  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: client.email,
        bcc: 'dolbeereli95@gmail.com',
        subject: 'Your ' + monthName + ' Review Report -- ' + (client.bizName || bizKey),
        html: `<div style="font-family:sans-serif;max-width:560px;margin:0 auto;padding:0;background:#f8fafc;border-radius:16px;overflow:hidden;">
          <div style="background:#0A2540;padding:24px;text-align:center;">
            <p style="color:rgba(255,255,255,0.5);font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 4px;">Monthly Review Report</p>
            <h1 style="color:white;font-size:1.3rem;font-weight:800;margin:0;">${client.bizName || bizKey}</h1>
            <p style="color:rgba(255,255,255,0.4);font-size:13px;margin:6px 0 0;">${monthName}</p>
          </div>
          <div style="padding:24px;">
            <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px;">
              <div style="background:white;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                <div style="font-size:28px;font-weight:800;color:#0f172a;">${total}</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:3px;">Responses</div>
              </div>
              <div style="background:white;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                <div style="font-size:28px;font-weight:800;color:#15803d;">${positive}</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:3px;">Sent to Google</div>
              </div>
              <div style="background:white;border-radius:10px;padding:16px;text-align:center;border:1px solid #e2e8f0;">
                <div style="font-size:28px;font-weight:800;color:#dc2626;">${negative}</div>
                <div style="font-size:11px;color:#94a3b8;margin-top:3px;">Caught privately</div>
              </div>
            </div>
            <div style="background:white;border-radius:10px;padding:16px 20px;border:1px solid #e2e8f0;margin-bottom:16px;display:flex;align-items:center;justify-content:space-between;">
              <div>
                <div style="font-size:13px;font-weight:700;color:#0f172a;">Satisfaction rate this month</div>
                <div style="font-size:12px;color:#94a3b8;margin-top:2px;">All time happy customers sent to Google: ${allTime}</div>
              </div>
              <div style="background:${satBg};color:${satColor};font-size:16px;font-weight:800;padding:8px 16px;border-radius:99px;">${total > 0 ? satRate + '%' : 'N/A'} ${total > 0 ? satLabel : ''}</div>
            </div>
            ${unresolvedCount > 0 ? '<div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:14px 18px;margin-bottom:16px;"><p style="font-size:13px;font-weight:700;color:#dc2626;margin:0 0 6px;">You have ' + unresolvedCount + ' unresolved feedback item' + (unresolvedCount > 1 ? 's' : '') + ' from this month</p><p style="font-size:12px;color:#555;margin:0;">Log into your portal to review and mark them resolved.</p></div>' : ''}
            <div style="background:white;border-radius:10px;padding:16px 20px;border:1px solid #e2e8f0;margin-bottom:20px;">
              <p style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#94a3b8;margin:0 0 10px;">Private feedback this month</p>
              <ul style="margin:0;padding-left:16px;">${negativeSummary}</ul>
            </div>
            <p style="color:#94a3b8;font-size:12px;text-align:center;margin:0;">Questions? Reply to this email or text Eli at (937) 367-1847.<br>Sent by Netify Builds</p>
          </div>
        </div>`
      })
    });
    console.log('[Monthly Report] Sent for', bizKey);
  } catch(e) {
    console.error('[Monthly Report Error]', e.message);
  }
}

// Endpoint to trigger monthly reports manually or via Railway cron
app.post('/send-monthly-reports', async (req, res) => {
    try {
const { secret } = req.body;
  if (secret !== ADMIN_SECRET) return res.status(403).json({ error: 'Unauthorized' });
  const keys = Object.keys(clientInfo).filter(k => {
    const c = clientInfo[k];
    return c.activated && (c.plan === 'review' || c.plan === 'bundle' || c.plan === 'review_campaign' || c.plan === 'all');
  });
  console.log('[Monthly Reports] Sending to', keys.length, 'clients');
  for (const key of keys) {
    await sendMonthlyReviewReport(key);
    await new Promise(r => setTimeout(r, 500));
  }
  res.json({ success: true, sent: keys.length });

  } catch(e) { console.error('[/send-monthly-reports Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// Helper: extract meaningful content from raw HTML
function extractSiteContent(html) {
  // Strip scripts, styles, and HTML tags
  let text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Extract key elements
  const phoneMatch = html.match(/(\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4})/);
  const emailMatch = html.match(/([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+\.[a-zA-Z]{2,})/);
  const hoursMatch = html.match(/(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)[\s\S]{0,100}/gi);
  const titleMatch = html.match(/<title[^>]*>(.*?)<\/title>/i);
  const h1s = [...html.matchAll(/<h1[^>]*>(.*?)<\/h1>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
  const h2s = [...html.matchAll(/<h2[^>]*>(.*?)<\/h2>/gi)].map(m => m[1].replace(/<[^>]+>/g, '').trim()).slice(0, 6);
  const metaDesc = html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);

  return [
    titleMatch ? 'PAGE TITLE: ' + titleMatch[1].replace(/<[^>]+>/g, '') : '',
    metaDesc ? 'META DESCRIPTION: ' + metaDesc[1] : '',
    h1s.length ? 'H1 HEADINGS: ' + h1s.join(' | ') : '',
    h2s.length ? 'H2 HEADINGS: ' + h2s.join(' | ') : '',
    phoneMatch ? 'PHONE: ' + phoneMatch[1] : 'PHONE: not found',
    emailMatch ? 'EMAIL: ' + emailMatch[1] : '',
    hoursMatch ? 'HOURS CONTENT: ' + hoursMatch.slice(0,3).join(' ') : 'HOURS: not clearly listed',
    'PAGE TEXT SAMPLE: ' + text.substring(0, 2000)
  ].filter(Boolean).join('\n');
}

// ── ADMIN ENDPOINTS ──

// Admin auth middleware
function requireAdmin(req, res, next) {
  const secret = req.headers['x-admin-secret'] || req.query.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  next();
}

// Get all clients
app.get('/admin/clients', requireAdmin, (req, res) => {
  res.json(clientInfo);
});

// Update a client record
app.post('/admin/update-client/:bizKey', requireAdmin, (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  const allowed = ['bizName','email','phone','plan','domain','googleReviewLink','emergency','botName','botColor','services','hours','area','faqs','differentiators','tone','leadCapture','systemPrompt','activated','features','isFree'];
  allowed.forEach(function(field) {
    if (req.body[field] !== undefined) clientInfo[key][field] = req.body[field];
  });
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

// Regenerate system prompt for a client
app.post('/admin/regenerate-prompt/:bizKey', requireAdmin, (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  const data = { ...clientInfo[key], ...req.body };
  const prompt = buildSystemPrompt({
    bizName: data.bizName, botName: data.botName, services: data.services,
    hours: data.hours, area: data.area, faqs: data.faqs,
    differentiators: data.differentiators, licensing: data.licensing,
    emergency: data.emergency, seasonal: data.seasonal,
    googleReviewLink: data.googleReviewLink, tone: data.tone,
    leadCapture: data.leadCapture, industry: data.industry,
    features: (data.features || clientInfo[key].features || '').toLowerCase()
  });
  clientInfo[key].systemPrompt = prompt;
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true, prompt });
});

// ── DEMO BOT GENERATOR ──
app.post('/admin/generate-demo', requireAdmin, (req, res) => {
  const { bizName, botName, bizInitial, color, systemPrompt, qrs, emergs } = req.body;
  if (!bizName) return res.status(400).json({ error: 'bizName required' });

  const c = color || '#0A2540';
  const bn = botName || bizName + ' Assistant';
  const bi = bizInitial || bizName.charAt(0).toUpperCase();
  const sp = JSON.stringify(systemPrompt || '');
  const qrsJson = JSON.stringify(qrs || ['Get a quote', 'Hours & availability', 'Service area']);
  const ergsJson = JSON.stringify(emergs || ['Emergency service', 'Get a quote', 'Service area']);

  // Only show emergency button for relevant industries
  const emergencyInds = ['hvac','heating','cooling','air','plumb','electric','roof','pest','locksmith','auto','mechanic','flood','restoration','sewer','drain','gas','furnace'];
  const indLower = (req.body.industry || '').toLowerCase();
  const showEmergency = emergencyInds.some(function(i) { return indLower.includes(i); });
  const emergencyBtnHtml = showEmergency ? `<button class="ab" onclick="showChat('emergency')"><div class="bi be"><svg viewBox="0 0 24 24"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg></div><div><div class="bt">Emergency service</div><div class="bs">Urgent issue? We respond fast</div></div><div class="ba"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div></button>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="color-scheme" content="light">
<title>${bizName} — Bot Demo</title>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@600;700;800&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'DM Sans',sans-serif;background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}
.wrap{max-width:440px;width:100%;text-align:center;}
.badge{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,0.1);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.8);font-size:11px;font-weight:600;padding:5px 14px;border-radius:99px;margin-bottom:20px;letter-spacing:0.02em;}
.title{font-family:'Plus Jakarta Sans',sans-serif;font-size:2rem;font-weight:800;color:white;letter-spacing:-0.03em;margin-bottom:8px;line-height:1.2;}
.sub{font-size:14px;color:rgba(255,255,255,0.6);margin-bottom:28px;line-height:1.6;}
.cta-box{background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:16px;padding:18px 22px;text-align:left;}
.cta-box p{font-size:13px;line-height:1.6;color:rgba(255,255,255,0.7);margin-bottom:12px;}
.cta-box a{display:inline-flex;align-items:center;gap:6px;background:white;color:#0A2540;font-size:13px;font-weight:700;padding:10px 20px;border-radius:99px;text-decoration:none;}
#nb-w{position:fixed;bottom:24px;right:24px;z-index:9999;width:60px;height:60px;border-radius:50%;background:${c};border:none;cursor:pointer;box-shadow:0 4px 24px rgba(0,0,0,0.3);display:flex;align-items:center;justify-content:center;-webkit-tap-highlight-color:transparent;transition:transform 0.2s;}
#nb-w:hover{transform:scale(1.08);}
#nb-w svg{width:26px;height:26px;stroke:white;fill:none;stroke-width:2;stroke-linecap:round;position:absolute;top:50%;left:50%;transition:all 0.3s cubic-bezier(0.34,1.56,0.64,1);}
#nb-w .o{transform:translate(-50%,-50%) scale(1);opacity:1;}
#nb-w .x{transform:translate(-50%,-50%) scale(0.5);opacity:0;stroke-width:2.5;}
#nb-b{position:fixed;bottom:96px;right:16px;z-index:9998;width:calc(100vw - 32px);max-width:388px;background:white;border-radius:24px;box-shadow:0 20px 60px rgba(0,0,0,0.18);border:1px solid rgba(0,0,0,0.06);display:none;flex-direction:column;overflow:hidden;font-family:'DM Sans',-apple-system,sans-serif;opacity:0;transform:translateY(16px);transition:opacity 0.25s,transform 0.25s cubic-bezier(0.16,1,0.3,1);}
#nb-b.op{display:flex;}#nb-b.vi{opacity:1;transform:translateY(0);}
#hh{background:${c};position:relative;overflow:hidden;}
#hh::before{content:"";position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,0.07) 1px,transparent 1px);background-size:20px 20px;pointer-events:none;}
#hi{position:relative;z-index:1;padding:24px 22px 22px;}
.av{width:44px;height:44px;border-radius:50%;border:2.5px solid rgba(0,0,0,0.15);display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:700;font-family:'Plus Jakarta Sans',sans-serif;}
.av1{background:rgba(255,255,255,0.2);color:white;}
.av2{background:linear-gradient(135deg,#4f46e5,#7c3aed);color:white;font-size:10px;margin-left:-10px;}
#hg{font-family:'Plus Jakarta Sans',sans-serif;font-size:22px;font-weight:800;color:white;letter-spacing:-0.03em;line-height:1.2;margin-bottom:6px;}
#hs{font-size:13px;color:rgba(255,255,255,0.5);margin-bottom:14px;}
#lb{display:inline-flex;align-items:center;gap:6px;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.2);color:#4ade80;font-size:11px;font-weight:600;padding:5px 12px;border-radius:99px;}
#ld{width:6px;height:6px;border-radius:50%;background:#22c55e;animation:pl 2s infinite;}
@keyframes pl{0%,100%{opacity:1}50%{opacity:0.5}}
#ac{background:#f8fafc;padding:16px 16px 6px;}
.ab{width:100%;background:white;border:1.5px solid #e2e8f0;border-radius:16px;padding:15px 16px;display:flex;align-items:center;gap:13px;cursor:pointer;font-family:inherit;transition:all 0.18s;text-align:left;margin-bottom:8px;}
.ab:hover{border-color:#cbd5e1;box-shadow:0 4px 16px rgba(0,0,0,0.07);transform:translateY(-1px);}
.bi{width:42px;height:42px;border-radius:12px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.bi svg{width:19px;height:19px;fill:none;stroke-width:2;stroke-linecap:round;}
.bc{background:#eff6ff;}.bc svg{stroke:#2563eb;}
.bp{background:#f0fdf4;}.bp svg{stroke:#16a34a;}
.be{background:#fff7ed;}.be svg{stroke:#ea580c;}
.bt{font-family:'Plus Jakarta Sans',sans-serif;font-size:14px;font-weight:700;color:#0f172a;margin-bottom:2px;}
.bs{font-size:12px;color:#64748b;}
.ba{margin-left:auto;color:#cbd5e1;flex-shrink:0;}
.ba svg{width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round;}
#hf{background:#f8fafc;padding:10px 16px 14px;text-align:center;font-size:10.5px;color:#cbd5e1;border-top:1px solid #f1f5f9;}
#cs{display:none;flex-direction:column;background:white;}
#cs.vi{display:flex;}
#ct{padding:14px 16px;border-bottom:1px solid #f1f5f9;display:flex;align-items:center;gap:10px;background:white;}
#bk{width:32px;height:32px;border-radius:9px;background:#f8fafc;border:1.5px solid #e2e8f0;cursor:pointer;display:flex;align-items:center;justify-content:center;}
#bk svg{width:16px;height:16px;stroke:#475569;fill:none;stroke-width:2.5;stroke-linecap:round;}
#cn{font-family:'Plus Jakarta Sans',sans-serif;font-size:14px;font-weight:700;color:#0f172a;}
#cst{display:flex;align-items:center;gap:4px;font-size:11px;color:#94a3b8;margin-top:1px;}
#cd{width:5px;height:5px;border-radius:50%;background:#22c55e;animation:pl 2s infinite;}
#ms{flex:1;min-height:300px;max-height:360px;overflow-y:auto;padding:18px 14px 10px;display:flex;flex-direction:column;gap:10px;background:#f8fafc;}
#ms::-webkit-scrollbar{width:0;}
.mb{max-width:268px;padding:10px 15px;font-size:13.5px;line-height:1.55;word-wrap:break-word;white-space:pre-wrap;}
.mb.bot{background:white;color:#0f172a;border:1.5px solid #e2e8f0;border-radius:4px 18px 18px 18px;align-self:flex-start;}
.mb.user{background:${c};color:white;border-radius:18px 4px 18px 18px;align-self:flex-end;}
.ty{align-self:flex-start;background:white;border:1.5px solid #e2e8f0;border-radius:4px 18px 18px 18px;padding:12px 16px;display:flex;gap:5px;}
.ty span{width:5px;height:5px;border-radius:50%;background:#94a3b8;animation:td 1.2s infinite;}
.ty span:nth-child(2){animation-delay:0.2s;}.ty span:nth-child(3){animation-delay:0.4s;}
@keyframes td{0%,100%{opacity:0.25;transform:translateY(0)}50%{opacity:1;transform:translateY(-3px)}}
#qr{display:flex;flex-wrap:wrap;gap:6px;padding:6px 14px 0;}
.qb{background:white;border:1.5px solid #e2e8f0;border-radius:99px;padding:6px 14px;font-size:12.5px;font-weight:500;color:#334155;cursor:pointer;font-family:inherit;transition:all 0.15s;}
.qb:hover{border-color:${c};background:${c};color:white;}
#ir{padding:12px 14px 14px;background:white;border-top:1px solid #f1f5f9;}
#ib{display:flex;align-items:center;gap:8px;background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:14px;padding:9px 9px 9px 14px;transition:all 0.15s;}
#ib:focus-within{border-color:${c};background:white;}
#ni{flex:1;border:none;background:transparent;font-size:16px;font-family:inherit;color:#0f172a;outline:none;}
#ni::placeholder{color:#94a3b8;}
#sn{width:34px;height:34px;border-radius:10px;background:${c};border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;}
#sn:hover{opacity:0.85;}
#sn svg{width:14px;height:14px;stroke:white;fill:none;stroke-width:2.5;stroke-linecap:round;}
#cf{text-align:center;margin-top:8px;font-size:10px;color:#cbd5e1;}
@media(max-width:480px){#nb-b{right:0;left:0;width:100%;max-width:100%;border-radius:20px 20px 0 0;bottom:0;height:82vh;transform:none!important;}#nb-w{bottom:80px;right:16px;}}
</style>
</head>
<body>
<div class="wrap">
  <div class="badge">&#x26A1; Demo by Netify Builds</div>
  <div class="title">${bizName}<br>Chat Assistant</div>
  <div class="sub">This is exactly what your customers would see on your website. Try it &mdash; tap the button in the bottom right corner.</div>
  <div class="cta-box">
    <p>Want this on your website, trained on your real business, capturing leads 24/7?</p>
    <a href="https://netifybuilds.com" target="_blank">Get yours at netifybuilds.com &rarr;</a>
  </div>
</div>

<button id="nb-w">
  <svg class="o" viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
  <svg class="x" viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
</button>

<div id="nb-b">
  <div id="home-screen">
    <div id="hh"><div id="hi">
      <div style="display:flex;margin-bottom:18px;"><div class="av av1">${bi}</div><div class="av av2">AI</div></div>
      <div id="hg">Hi there &#x1F44B;<br>How can we help?</div>
      <div id="hs">${bizName}</div>
      <div id="lb"><div id="ld"></div>&nbsp;We&rsquo;re online now</div>
    </div></div>
    <div id="ac">
      <button class="ab" onclick="showChat('question')">
        <div class="bi bc"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></div>
        <div><div class="bt">I have a question</div><div class="bs">Get answers instantly, 24/7</div></div>
        <div class="ba"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div>
      </button>
      <button class="ab" onclick="showChat('callback')">
        <div class="bi bp"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 12a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.6 1.28h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 8.6a16 16 0 0 0 6 6l.87-.87a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/></svg></div>
        <div><div class="bt">Request a callback</div><div class="bs">Leave your number, we'll call back</div></div>
        <div class="ba"><svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg></div>
      </button>
      ${emergencyBtnHtml}
    </div>
    <div id="hf">Powered by <a href="https://netifybuilds.com" target="_blank" style="color:#94a3b8;">Netify Builds</a></div>
  </div>

  <div id="cs">
    <div id="ct">
      <button id="bk" onclick="showHome()"><svg viewBox="0 0 24 24"><polyline points="15 18 9 12 15 6"/></svg></button>
      <div style="flex:1;"><div id="cn">${bn}</div><div id="cst"><div id="cd"></div>&nbsp;Online &middot; Replies instantly</div></div>
      <button onclick="closeChat()" style="width:28px;height:28px;border-radius:8px;background:#f8fafc;border:1.5px solid #e2e8f0;cursor:pointer;display:flex;align-items:center;justify-content:center;"><svg viewBox="0 0 24 24" style="width:14px;height:14px;stroke:#475569;fill:none;stroke-width:2.5;stroke-linecap:round;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button>
    </div>
    <div id="ms"></div>
    <div id="qr"></div>
    <div id="ir">
      <div id="ib"><input id="ni" placeholder="Type a message..." autocomplete="off"/><button id="sn"><svg viewBox="0 0 24 24"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button></div>
      <div id="cf">Powered by <a href="https://netifybuilds.com" target="_blank" style="color:#cbd5e1;">Netify Builds</a></div>
    </div>
  </div>
</div>

<script>
var BE='https://botbuilder-backend-production.up.railway.app';
var SP=${sp};
var QR=${qrsJson};
var ER=${ergsJson};
var msgs=[],gs=false,io=false;
var w=document.getElementById('nb-w');
var b=document.getElementById('nb-b');
var fm={question:"Sure, what's on your mind? I can help with questions about our services, pricing, hours, or anything else.",callback:"Of course! What's your name and best callback number?",emergency:"We're on it. What's happening right now?"};
var cr={question:QR,callback:[],emergency:ER};
function showChat(t){document.getElementById('home-screen').style.display='none';document.getElementById('cs').classList.add('vi');if(!gs){gs=true;addMsg(fm[t]||fm.question,'bot');msgs.push({role:'assistant',content:fm[t]||fm.question});showQR(cr[t]||[]);}setTimeout(function(){document.getElementById('ni').focus();},300);}
function showHome(){document.getElementById('cs').classList.remove('vi');document.getElementById('home-screen').style.display='block';msgs=[];gs=false;document.getElementById('ms').innerHTML='';document.getElementById('qr').innerHTML='';}
function closeChat(){b.classList.remove('vi');setTimeout(function(){b.classList.remove('op');w.style.display='flex';},220);io=false;}
function addMsg(tx,rl){var m=document.getElementById('ms');var d=document.createElement('div');d.className='mb '+rl;d.textContent=tx;m.appendChild(d);m.scrollTop=m.scrollHeight;}
function showQR(rs){var q=document.getElementById('qr');q.innerHTML='';(rs||[]).forEach(function(r){var btn=document.createElement('button');btn.className='qb';btn.textContent=r;btn.onclick=function(){q.innerHTML='';document.getElementById('ni').value=r;send();};q.appendChild(btn);});}
async function send(){var inp=document.getElementById('ni');var tx=inp.value.trim();if(!tx)return;inp.value='';document.getElementById('qr').innerHTML='';addMsg(tx,'user');msgs.push({role:'user',content:tx});var m=document.getElementById('ms');var ty=document.createElement('div');ty.className='ty';ty.innerHTML='<span></span><span></span><span></span>';m.appendChild(ty);m.scrollTop=m.scrollHeight;try{var rs=await fetch(BE+'/chat',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({messages:msgs.slice(-8),systemPrompt:SP,bizKey:''})});var d=await rs.json();ty.remove();var rp=d.reply||'Sorry, something went wrong.';if(rp.includes('LEAD_CAPTURED|')){rp=rp.split('LEAD_CAPTURED|')[0].trim();}addMsg(rp,'bot');msgs.push({role:'assistant',content:rp});}catch(e){ty.remove();addMsg('Sorry, something went wrong. Please try again.','bot');}}
w.addEventListener('click',function(){if(io)return;io=true;w.style.display='none';b.classList.add('op');setTimeout(function(){b.classList.add('vi');},10);});
document.getElementById('sn').addEventListener('click',send);
document.getElementById('ni').addEventListener('keypress',function(e){if(e.key==='Enter')send();});
</script>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html');
  res.setHeader('Content-Disposition', 'attachment; filename="' + (bizName || 'demo').replace(/[^a-z0-9]/gi,'_').toLowerCase() + '_demo_bot.html"');
  res.send(html);
});

// ── WIDGET SCRIPT GENERATOR ──
app.get('/widget-script/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const client = clientInfo[key];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const bizName = client.bizName || 'Your Business';
  const botName = client.botName || (bizName + ' Assistant');
  const accentColor = client.botColor || '#0A2540';
  const systemPrompt = client.systemPrompt || '';
  const greeting = client.greeting || '';

  const script = `<!-- Netify Builds Chat Widget -->
<script>
(function() {
  var BIZ_KEY      = '${key}';
  var BIZ_NAME     = '${bizName.replace(/'/g, "\'")}';
  var BOT_NAME     = '${botName.replace(/'/g, "\'")}';
  var ACCENT_COLOR = '${accentColor}';
  var BACKEND_URL  = 'https://botbuilder-backend-production.up.railway.app';
  var SYSTEM_PROMPT = ${JSON.stringify(systemPrompt)};
  var GREETING = ${JSON.stringify(greeting)};
  var HOURS = null;
  var LEAD_EMAIL = '${(client.email || '').replace(/'/g, "\'")}';
  var AUTO_OPEN_DELAY = null;

  var s = document.createElement('script');
  s.src = 'https://netifybuilds.com/widget.js';
  s.setAttribute('data-bizkey', BIZ_KEY);
  s.setAttribute('data-bizname', BIZ_NAME);
  s.setAttribute('data-botname', BOT_NAME);
  s.setAttribute('data-color', ACCENT_COLOR);
  s.setAttribute('data-backend', BACKEND_URL);
  s.setAttribute('data-prompt', encodeURIComponent(SYSTEM_PROMPT));
  s.setAttribute('data-greeting', encodeURIComponent(GREETING));
  s.setAttribute('data-email', LEAD_EMAIL);
  document.head.appendChild(s);
})();
</script>
<!-- End Netify Builds Widget -->`;

  res.setHeader('Content-Type', 'text/plain');
  res.send(script);
});

// Generate and return the full inline widget script for a client
app.get('/widget-inline/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const client = clientInfo[key];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  const bizNameSafe = (client.bizName || 'Your Business').replace(/[`'\\]/g, ' ');
  const botNameSafe = (client.botName || bizNameSafe + ' Assistant').replace(/[`'\\]/g, ' ');
  const accentColor = client.botColor || '#0A2540';
  const bizInitial = bizName.charAt(0).toUpperCase();

  res.setHeader('Content-Type', 'text/plain');
  res.send(`<!-- Netify Builds Chat Widget for ${client.bizName} -->
<script>
window.__nb = {
  bizKey: '${key}',
  bizName: ${JSON.stringify(client.bizName || 'Your Business')},
  botName: ${JSON.stringify(client.botName || (client.bizName || 'Your Business') + ' Assistant')},
  accentColor: '${accentColor}',
  backend: 'https://botbuilder-backend-production.up.railway.app',
  leadEmail: ${JSON.stringify(client.email || '')},
  systemPrompt: ${JSON.stringify(client.systemPrompt || '')}
};
</script>
<script src="https://netifybuilds.com/widget-loader.js"></script>
<!-- End Netify Builds Widget -->`);
});

// ── GOOGLE CALENDAR OAUTH ──

// Step 1: Generate OAuth URL for client to connect their calendar
app.get('/calendar/auth/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    scope: ['https://www.googleapis.com/auth/calendar'],
    state: key,
    prompt: 'consent'
  });
  res.redirect(url);
});

// Step 2: Handle callback, store tokens
app.get('/calendar/callback', async (req, res) => {
  const { code, state: bizKey } = req.query;
  if (!code || !bizKey) return res.status(400).send('Missing code or state');
  try {
    const client = new OAuth2Client(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI);
    const { tokens } = await client.getToken(code);
    if (!clientInfo[bizKey]) return res.status(404).send('Client not found');
    clientInfo[bizKey].calendarTokens = tokens;
    clientInfo[bizKey].calendarConnected = true;
    debouncedSave('client_info.json', clientInfo);
    console.log('[Calendar] Connected for', bizKey);
    res.send('<html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2 style="color:#16a34a;">Google Calendar Connected!</h2><p>You can close this tab and return to your portal.</p></body></html>');
  } catch(e) {
    console.error('[Calendar OAuth Error]', e.message);
    res.status(500).send('Calendar connection failed: ' + e.message);
  }
});

// Step 3: Get available slots for next 14 days
app.get('/calendar/availability/:bizKey', async (req, res) => {
  try {
    const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const client2 = clientInfo[key];
    if (!client2 || !client2.calendarTokens) return res.status(400).json({ error: 'Calendar not connected' });

    const cal = getCalendarClient(client2.calendarTokens);

    // Get existing events for next 14 days
    const now = new Date();
    const end = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);

    const response = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now.toISOString()}&timeMax=${end.toISOString()}&singleEvents=true&orderBy=startTime`, {
      headers: { Authorization: 'Bearer ' + client2.calendarTokens.access_token }
    });

    if (!response.ok) {
      // Try refreshing token
      if (GOOGLE_CLIENT_SECRET) {
        cal.on('tokens', function(newTokens) {
          clientInfo[key].calendarTokens = { ...client2.calendarTokens, ...newTokens };
          debouncedSave('client_info.json', clientInfo);
        });
        const newToken = await cal.refreshAccessToken();
        clientInfo[key].calendarTokens.access_token = newToken.credentials.access_token;
        debouncedSave('client_info.json', clientInfo);
      }
    }

    const data = await response.json();
    const busyTimes = (data.items || []).map(function(e) {
      return { start: e.start.dateTime || e.start.date, end: e.end.dateTime || e.end.date };
    });

    // Generate available slots based on owner settings
    const settings = client2.calendarSettings || { startHour: 8, endHour: 17, duration: 60, buffer: 30, workDays: [1,2,3,4,5] };
    const slots = [];
    const slotDuration = (settings.duration + settings.buffer) * 60 * 1000;

    const stepMinutes = (settings.duration || 60) + (settings.buffer || 30);

    for (let d = 0; d < 14 && slots.length < 3; d++) {
      const day = new Date(now);
      day.setDate(day.getDate() + d + 1);
      if (!settings.workDays.includes(day.getDay())) continue;

      // Step through day in duration+buffer increments
      for (let mins = (settings.startHour || 8) * 60; mins + (settings.duration || 60) <= (settings.endHour || 17) * 60; mins += stepMinutes) {
        const slotStart = new Date(day);
        slotStart.setHours(0, mins, 0, 0);
        const slotEnd = new Date(slotStart.getTime() + (settings.duration || 60) * 60 * 1000);

        // Skip if in the past
        if (slotStart <= now) continue;

        // Check conflict with existing calendar events
        const conflict = busyTimes.some(function(b) {
          const bStart = new Date(b.start);
          const bEnd = new Date(b.end);
          return slotStart < bEnd && slotEnd > bStart;
        });

        if (!conflict) {
          slots.push({
            start: slotStart.toISOString(),
            end: slotEnd.toISOString(),
            label: slotStart.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) + ' at ' + slotStart.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
          });
          if (slots.length >= 3) break;
        }
      }
    }

    res.json({ slots, connected: true });
  } catch(e) {
    console.error('[Calendar Availability Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Step 4: Book an appointment
app.post('/calendar/book', async (req, res) => {
  try {
    const { bizKey, slotStart, slotEnd, customerName, customerPhone, customerEmail, service, notes } = req.body;
    const key = bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
    const client2 = clientInfo[key];
    if (!client2 || !client2.calendarTokens) return res.status(400).json({ error: 'Calendar not connected' });

    const event = {
      summary: (service || 'Appointment') + ' — ' + (customerName || 'Customer'),
      description: [
        'Customer: ' + (customerName || 'Not provided'),
        'Phone: ' + (customerPhone || 'Not provided'),
        'Email: ' + (customerEmail || 'Not provided'),
        'Service: ' + (service || 'Not specified'),
        'Notes: ' + (notes || 'None'),
        '',
        'Booked via Netify Builds chat assistant'
      ].join('\n'),
      start: { dateTime: slotStart, timeZone: 'America/New_York' },
    };

    const bookRes = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + client2.calendarTokens.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(event)
    });

    if (!bookRes.ok) {
      const err = await bookRes.json();
      throw new Error(err.error.message || 'Booking failed');
    }

    const booked = await bookRes.json();

    // Send confirmation email to owner
    if (client2.email) {
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'onboarding@resend.dev',
          to: client2.email,
          bcc: 'dolbeereli95@gmail.com',
          subject: 'New appointment booked — ' + (customerName || 'Customer'),
          html: '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f0f9ff;border-radius:12px;border:1px solid #bae6fd;"><h2 style="color:#0369a1;">New Appointment Booked</h2><p style="color:#374151;">A customer booked an appointment through your chat bot.</p><div style="background:white;border-radius:8px;padding:16px;border:1px solid #e5e7eb;font-size:14px;color:#374151;"><p><strong>Name:</strong> ' + (customerName || 'Not provided') + '</p><p><strong>Phone:</strong> ' + (customerPhone || 'Not provided') + '</p><p><strong>Service:</strong> ' + (service || 'Not specified') + '</p><p><strong>Time:</strong> ' + new Date(slotStart).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }) + ' at ' + new Date(slotStart).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + '</p></div><p style="color:#0369a1;font-size:13px;font-weight:600;margin-top:16px;">This appointment has been added to your Google Calendar.</p></div>'
        })
      }).catch(function(e) { console.error('[Calendar Email Error]', e.message); });
    }

    res.json({ success: true, eventId: booked.id });
  } catch(e) {
    console.error('[Calendar Book Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Calendar settings update
app.post('/calendar/settings', (req, res) => {
  const { bizKey, startHour, endHour, duration, buffer, workDays } = req.body;
  const key = bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  clientInfo[key].calendarSettings = { startHour: startHour || 8, endHour: endHour || 17, duration: duration || 60, buffer: buffer || 30, workDays: workDays || [1,2,3,4,5] };
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

// Disconnect calendar
app.post('/calendar/disconnect', (req, res) => {
  const { bizKey } = req.body;
  const key = bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  delete clientInfo[key].calendarTokens;
  clientInfo[key].calendarConnected = false;
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

// ── MISSED CALL SETTINGS ──
app.post('/missed-call-settings', (req, res) => {
  const { bizKey, ownerPhone, twilioNumber, secret } = req.body;
  if (!secret || secret !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'Forbidden' });
  const key = bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  if (ownerPhone) clientInfo[key].ownerPhone = ownerPhone;
  if (twilioNumber) clientInfo[key].twilioNumber = twilioNumber;
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

// ── ADMIN MODE: ANALYZE SITE ──
app.post('/analyze-site', async (req, res) => {
  const { bizKey } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  const key = bizKey.toLowerCase();
  const client = clientInfo[key];
  if (!client) return res.status(404).json({ error: 'Client not found' });

  // Return cached scan if fresh (less than 24 hours old)
  if (client.siteScan && client.siteScan.scannedAt) {
    const age = Date.now() - new Date(client.siteScan.scannedAt).getTime();
    if (age < 24 * 60 * 60 * 1000) {
      return res.json({ html: client.siteScan.html, cached: true });
    }
  }

  // Request fresh scan from extension if connected
  const ws = extensionClients[key];
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'scan_request' }));
    return res.json({ scanning: true, message: 'Scan requested from extension' });
  }

  // Fall back to fetching the site directly
  try {
    const siteUrl = client.domain ? 'https://' + client.domain : null;
    if (!siteUrl) return res.json({ error: 'No site URL on file' });
    const response = await fetch(siteUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NetifyBuilds/1.0)' } });
    const html = await response.text();
    client.siteScan = { html: html.substring(0, 50000), scannedAt: new Date().toISOString() };
    debouncedSave('client_info.json', clientInfo);
    res.json({ html: client.siteScan.html, cached: false });
  } catch(e) {
    res.status(500).json({ error: 'Could not fetch site: ' + e.message });
  }
});

// ── ADMIN MODE: SAVE CHANGE TO HISTORY ──
app.post('/save-change-history', async (req, res) => {
  const { bizKey, change } = req.body;
  if (!bizKey || !change) return res.status(400).json({ error: 'bizKey and change required' });
  const key = bizKey.toLowerCase();
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });
  if (!clientInfo[key].changeHistory) clientInfo[key].changeHistory = [];
  change.savedAt = new Date().toISOString();
  clientInfo[key].changeHistory.unshift(change);
  // Keep last 20 changes only
  clientInfo[key].changeHistory = clientInfo[key].changeHistory.slice(0, 20);
  debouncedSave('client_info.json', clientInfo);
  res.json({ success: true });
});

app.get('/change-history/:bizKey', (req, res) => {
  const key = req.params.bizKey.toLowerCase().replace(/[^a-z0-9_]/g, '');
  const history = (clientInfo[key] && clientInfo[key].changeHistory) || [];
  res.json({ history });
});

// ── ADMIN MODE: SEND CHANGE SUMMARY EMAIL ──
app.post('/send-change-summary', async (req, res) => {
  const { bizKey, changes } = req.body;
  if (!bizKey || !changes || !changes.length) return res.status(400).json({ error: 'bizKey and changes required' });
  const key = bizKey.toLowerCase();
  const client = clientInfo[key];
  if (!client || !client.email) return res.status(404).json({ error: 'Client not found' });

  try {
    const changeRows = changes.map(function(c) {
      return '<tr><td style="padding:8px 12px;font-size:13px;color:#374151;border-bottom:1px solid #f1f5f9;">' +
        (c.description || c.type || 'Change') + '</td>' +
        '<td style="padding:8px 12px;font-size:12px;color:#94a3b8;border-bottom:1px solid #f1f5f9;">' +
        new Date(c.savedAt || Date.now()).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) +
        '</td></tr>';
    }).join('');

    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'onboarding@resend.dev',
        to: client.email,
        bcc: 'dolbeereli95@gmail.com',
        subject: 'Website changes summary -- ' + (client.bizName || bizKey),
        html: '<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px;background:#f8fafc;border-radius:12px;">' +
          '<div style="background:#0A2540;padding:20px 24px;border-radius:10px;margin-bottom:20px;">' +
          '<h2 style="color:white;margin:0;font-size:1.1rem;">Website update summary</h2>' +
          '<p style="color:rgba(255,255,255,0.45);font-size:13px;margin:4px 0 0;">' + (client.bizName || bizKey) + '</p>' +
          '</div>' +
          '<p style="font-size:14px;color:#374151;margin-bottom:16px;">Here are the changes made to your website in this session:</p>' +
          '<table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;">' +
          '<thead><tr><th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;text-align:left;border-bottom:1px solid #e2e8f0;">Change</th>' +
          '<th style="padding:10px 12px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#94a3b8;text-align:left;border-bottom:1px solid #e2e8f0;">Time</th></tr></thead>' +
          '<tbody>' + changeRows + '</tbody></table>' +
          '<p style="font-size:12px;color:#94a3b8;margin-top:16px;text-align:center;">To undo any of these changes, type "undo" into your bot while in admin mode.</p>' +
          '</div>'
      })
    });
    res.json({ success: true });
  } catch(e) {
    console.error('[Change Summary Error]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── ADMIN MODE: REVERT LAST CHANGE ──
app.post('/revert-edit', async (req, res) => {
    try {
const { bizKey, revertAll } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  const key = bizKey.toLowerCase();
  const ws = extensionClients[key];
  if (!ws || ws.readyState !== 1) return res.status(503).json({ error: 'Extension not connected' });
  ws.send(JSON.stringify({ type: revertAll ? 'revert_all' : 'revert_last' }));
  res.json({ success: true });

  } catch(e) { console.error('[/revert-edit Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── ADMIN MODE: SEO UPDATE ──
app.post('/update-seo', async (req, res) => {
    try {
const { bizKey, metaTitle, metaDescription } = req.body;
  if (!bizKey) return res.status(400).json({ error: 'bizKey required' });
  const key = bizKey.toLowerCase();
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });

  // Store SEO updates in client record
  if (!clientInfo[key].seoUpdates) clientInfo[key].seoUpdates = {};
  if (metaTitle) clientInfo[key].seoUpdates.metaTitle = metaTitle;
  if (metaDescription) clientInfo[key].seoUpdates.metaDescription = metaDescription;
  clientInfo[key].seoUpdates.updatedAt = new Date().toISOString();
  debouncedSave('client_info.json', clientInfo);

  // Send to extension to apply
  const ws = extensionClients[key];
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({
      type: 'seo_update',
      metaTitle,
      metaDescription
    }));
  }
  res.json({ success: true });

  } catch(e) { console.error('[/update-seo Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// ── ADMIN MODE: APPLY EDIT ──
app.post('/apply-edit', async (req, res) => {
    try {
const { bizKey, edit } = req.body;
  if (!bizKey || !edit) return res.status(400).json({ error: 'bizKey and edit required' });
  const key = bizKey.toLowerCase();
  if (!clientInfo[key]) return res.status(404).json({ error: 'Client not found' });

  const result = await sendEditToExtension(key, edit);
  res.json(result);

  } catch(e) { console.error('[/apply-edit Error]', e.message); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

const server = app.listen(PORT, () => {
  setupWebSocketServer(server);
  console.log('BotBuilder backend running on port ' + PORT);
  if (!process.env.ANTHROPIC_API_KEY) console.warn('WARNING: ANTHROPIC_API_KEY not set!');
  if (!process.env.RESEND_API_KEY) console.warn('WARNING: RESEND_API_KEY not set!');
});
