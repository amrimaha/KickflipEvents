
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

// Claude AI chat proxy — with built-in web search
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

DISCOVERY PROTOCOL:
1. INTERNAL FIRST: Always check INTERNAL SYSTEM RECORDS first. Include all matching events.
2. WEB SEARCH: Use web_search to find real-time Seattle events that supplement the internal database.
   - Search for specific event types, venues, or dates the user asked about.
   - Use targeted queries like: "Seattle [type] events [date] 2025" or "site:eventbrite.com Seattle [type]"
   - Always search when the query mentions specific dates, venues, or niche categories.
3. MERGE: Combine internal records + web-discovered events into one unified list. No duplicates.
4. ABUNDANCE: Aim for 6–12 results. Mix high-profile events with underground/niche hidden gems.
5. DIVERSITY: Cover different neighborhoods, price points, and categories.

RESPONSE FORMAT: Always respond with valid JSON only — even after web searching:
{"text": "short vibe message max 12 words", "events": [...array of event objects...]}

Each event object must have:
  id (string), title (string), date (string), location (string),
  description (string), category (one of: music/food/art/party/outdoor/wellness/fashion/sports/comedy/other),
  vibeTags (array of strings), price (string), link (string, use real URL if found)`;

  const userPrompt = `INTERNAL SYSTEM RECORDS (OFFICIAL DATABASE):
${JSON.stringify(registrySnapshot)}

CURRENT DATE/TIME: ${currentDateTime} (Seattle Time)
USER QUERY: "${query}"

STEPS:
1. Pull all relevant events from INTERNAL SYSTEM RECORDS above.
2. Use web_search to find additional real Seattle events for this query — especially anything time-sensitive or not in the internal database.
3. Merge everything. Return valid JSON: {"text": "max 12 word vibe", "events": [array]}`;

  try {
    const conversationMessages = [{ role: 'user', content: userPrompt }];
    let finalText = '';
    const MAX_TURNS = 6;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await anthropic.messages.create(
        {
          model: 'claude-sonnet-4-6',
          max_tokens: 4096,
          system: systemPrompt,
          tools: [{ type: 'web_search_20250305', name: 'web_search' }],
          messages: conversationMessages,
        },
        { headers: { 'anthropic-beta': 'web-search-2025-03-05' } }
      );

      // Extract any text blocks from this turn
      const textBlocks = response.content.filter(b => b.type === 'text');
      if (textBlocks.length > 0) {
        finalText = textBlocks.map(b => b.text).join('');
      }

      // Done — Claude finished generating
      if (response.stop_reason === 'end_turn') {
        break;
      }

      // Claude wants to use a tool — add its response and continue the loop
      if (response.stop_reason === 'tool_use') {
        conversationMessages.push({ role: 'assistant', content: response.content });

        // Build tool_result blocks for each tool_use call
        // For the built-in web_search tool, Anthropic executes the search server-side.
        // The results come back inside the response.content as web_search_tool_result blocks.
        // We forward them back so Claude can synthesize.
        const toolResultBlocks = response.content
          .filter(b => b.type === 'tool_use')
          .map(toolUse => {
            // Find if a corresponding result block was already returned by the API
            const resultBlock = response.content.find(
              b => b.type === 'web_search_tool_result_20250305' && b.tool_use_id === toolUse.id
            );
            return {
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: resultBlock ? resultBlock.content : 'Search complete — incorporate any relevant Seattle events found.',
            };
          });

        if (toolResultBlocks.length > 0) {
          conversationMessages.push({ role: 'user', content: toolResultBlocks });
        } else {
          // No tool_use blocks found despite tool_use stop reason — bail out
          break;
        }
      } else {
        // Any other stop reason — exit loop
        break;
      }
    }

    // Parse the final JSON from Claude's text response
    const jsonMatch = finalText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]);
        return res.json({
          text: parsed.text || 'Checking the local scene...',
          events: parsed.events || [],
        });
      } catch (e) {
        return res.json({ text: finalText.trim(), events: [] });
      }
    }

    res.json({ text: finalText.trim() || 'Checking the local scene...', events: [] });
  } catch (error) {
    console.error('Claude API error:', error);
    res.status(500).json({ error: 'AI service unavailable', text: 'Connection bumpy. Try again?', events: [] });
  }
});

app.listen(port, () => {
  console.log(`KickflipEvents backend running on port ${port}`);
});
