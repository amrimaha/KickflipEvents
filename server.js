
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { OAuth2Client } from 'google-auth-library';
import Anthropic from '@anthropic-ai/sdk';

const app = express();
const port = process.env.PORT || 3001;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const client = new OAuth2Client(GOOGLE_CLIENT_ID);
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.use(cors());
app.use(express.json({ limit: '2mb' }));

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Google OAuth token verification
app.post('/api/auth/google', async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token is required' });

  try {
    const ticket = await client.verifyIdToken({ idToken: token, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    res.json({ user: { id: payload.sub, name: payload.name, email: payload.email, avatar: payload.picture } });
  } catch (error) {
    console.error('Error verifying Google token:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

// Claude AI chat proxy
app.post('/api/chat', async (req, res) => {
  const { query, events = [] } = req.body;
  if (!query) return res.status(400).json({ error: 'query is required' });

  const now = new Date();
  const currentDateTime = now.toLocaleString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: 'numeric', minute: 'numeric', timeZone: 'America/Los_Angeles'
  });

  const registrySnapshot = events.map(e => ({
    id: e.id, title: e.title, date: e.date, startDate: e.startDate,
    location: e.locationName || e.location, description: e.vibeDescription || e.description,
    category: e.category, vibeTags: e.vibeTags, organizer: e.organizer
  }));

  const systemPrompt = `You are Kickflip, Seattle's premier event discovery AI.
Your persona is cool, connected, and in-the-know about Seattle's local scene.
Your mission is to connect users with experiences that match their vibe.

CRITICAL: KEEP RESPONSES EXTREMELY SHORT. MAX 12 WORDS for the "text" field.
No fluff. No "Here are some events". Just the vibe.

PROTOCOL:
1. ABUNDANCE: Always prefer showing MORE events rather than fewer.
2. DIVERSITY: Mix high-profile events with underground/niche hidden gems.
3. BREADTH: Ensure results cover different neighborhoods, prices, and categories.
4. ACCURACY: Prioritize INTERNAL RECORDS. Fill gaps with your Seattle knowledge.

RESPONSE FORMAT: Always respond with valid JSON only:
{"text": "short vibe message max 12 words", "events": [...array of event objects...]}`;

  const userPrompt = `INTERNAL SYSTEM RECORDS (OFFICIAL DATABASE):
${JSON.stringify(registrySnapshot)}

CURRENT DATE/TIME: ${currentDateTime} (Seattle Time)
USER INPUT: "${query}"

OPERATIONAL PROTOCOL:
1. Scan INTERNAL SYSTEM RECORDS first. Include any relevant internal records in results.
2. For broad queries ("fun", "music", "anything"), return diverse mix of internal records.
3. For specific queries, match exact records. Use your Seattle knowledge to fill gaps.
4. Return valid JSON: {"text": "max 12 word vibe", "events": [array]}`;

  try {
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const fullText = message.content[0]?.text || '';
    const jsonMatch = fullText.match(/\{[\s\S]*\}/);

    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return res.json({ text: parsed.text || 'Checking the local scene...', events: parsed.events || [] });
      } catch (e) {
        return res.json({ text: fullText.trim(), events: [] });
      }
    }
    res.json({ text: fullText.trim() || 'Checking the local scene...', events: [] });
  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ error: 'AI service unavailable', text: 'Connection bumpy. Try again?', events: [] });
  }
});

app.listen(port, () => {
  console.log(`KickflipEvents backend running on port ${port}`);
});
