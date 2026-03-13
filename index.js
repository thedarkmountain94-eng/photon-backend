require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Environment Variables
const {
  INSTAGRAM_APP_ID,
  INSTAGRAM_APP_SECRET,
  INSTAGRAM_VERIFY_TOKEN,
  SUPABASE_URL,
  SUPABASE_SERVICE_KEY,
  FRONTEND_URL,
  PORT = 3000
} = process.env;

// Initialize Supabase
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// ==========================================
// 1. INSTAGRAM OAUTH ROUTES
// ==========================================

app.get('/auth/instagram', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/instagram/callback`;
  const scope = 'instagram_manage_comments,instagram_manage_messages,pages_messaging,pages_read_engagement';
  
  const authUrl = `https://www.facebook.com/v18.0/dialog/oauth?client_id=${INSTAGRAM_APP_ID}&display=page&extras={"setup":{"channel":"IG_API"}}&redirect_uri=${redirectUri}&response_type=code&scope=${scope}`;
  
  res.redirect(authUrl);
});

app.get('/auth/instagram/callback', async (req, res) => {
  const { code, state } = req.query; // 'state' should contain the Supabase user ID passed from frontend
  const redirectUri = `${req.protocol}://${req.get('host')}/auth/instagram/callback`;

  try {
    // 1. Exchange code for short-lived token
    const tokenResponse = await axios.get(`https://graph.facebook.com/v18.0/oauth/access_token`, {
      params: {
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        redirect_uri: redirectUri,
        code: code
      }
    });
    const shortLivedToken = tokenResponse.data.access_token;

    // 2. Exchange for long-lived token
    const longLivedResponse = await axios.get(`https://graph.facebook.com/v18.0/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: INSTAGRAM_APP_ID,
        client_secret: INSTAGRAM_APP_SECRET,
        fb_exchange_token: shortLivedToken
      }
    });
    const longLivedToken = longLivedResponse.data.access_token;

    // 3. Get User Info (Fetch connected Instagram account)
    const userResponse = await axios.get(`https://graph.facebook.com/v18.0/me?fields=id,name,accounts{instagram_business_account}&access_token=${longLivedToken}`);
    
    // Extract IG user ID (assuming first connected page)
    const igAccountId = userResponse.data.accounts?.data[0]?.instagram_business_account?.id;
    
    // 4. Save to Supabase
    // Note: 'state' should be passed from the frontend containing the logged-in user's UUID
    if (igAccountId && state) {
       await supabase.from('users').update({
         instagram_user_id: igAccountId,
         instagram_access_token: longLivedToken,
       }).eq('id', state);
    }

    res.redirect(`${FRONTEND_URL}/dashboard?success=true`);
  } catch (error) {
    console.error('OAuth Error:', error.response?.data || error.message);
    res.redirect(`${FRONTEND_URL}/dashboard?error=oauth_failed`);
  }
});

// ==========================================
// 2. INSTAGRAM WEBHOOK ROUTES
// ==========================================

app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === INSTAGRAM_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'instagram') {
    res.status(200).send('EVENT_RECEIVED'); // Acknowledge immediately to Facebook

    for (const entry of body.entry) {
      for (const change of entry.changes) {
        if (change.field === 'comments') {
          const comment = change.value;
          await handleInstagramComment(comment);
        }
      }
    }
  } else {
    res.sendStatus(404);
  }
});

async function handleInstagramComment(comment) {
  const postId = comment.media.id;
  const commentText = comment.text.toLowerCase();
  const commenterIgId = comment.from.id;
  const commenterUsername = comment.from.username;
  const commentId = comment.id;

  // 1. Find active automation for this post
  const { data: automations, error } = await supabase
    .from('automations')
    .select('*, users(instagram_access_token)')
    .eq('post_id', postId)
    .eq('status', 'active');

  if (error || !automations || automations.length === 0) return;

  const automation = automations[0];
  const accessToken = automation.users.instagram_access_token;

  // 2. Check keywords
  const hasKeyword = automation.keywords.some(keyword => 
    commentText.includes(keyword.toLowerCase())
  );

  if (!hasKeyword) return;

  try {
    // 3a. Send Public Comment Reply
    if (automation.comment_reply_text) {
      await axios.post(`https://graph.facebook.com/v18.0/${commentId}/replies`, {
        message: automation.comment_reply_text
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    }

    // 3b. Send DM to commenter
    if (automation.dm_message) {
      await axios.post(`https://graph.facebook.com/v18.0/me/messages`, {
        recipient: { id: commenterIgId },
        message: { text: automation.dm_message }
      }, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
    }

    // 3c. Save Lead
    await supabase.from('leads').insert({
      automation_id: automation.id,
      user_id: automation.user_id,
      triggered_by_username: commenterUsername,
      triggered_by_ig_id: commenterIgId,
      dm_sent: true,
      dm_seen: false,
      link_clicked: false
    });

    // 3d. Update Metrics (Increment messages_sent)
    const today = new Date().toISOString().split('T')[0];
    
    const { data: existingMetric } = await supabase
      .from('metrics')
      .select('*')
      .eq('user_id', automation.user_id)
      .eq('date', today)
      .single();

    if (existingMetric) {
      await supabase.from('metrics')
        .update({ messages_sent: existingMetric.messages_sent + 1 })
        .eq('id', existingMetric.id);
    } else {
      await supabase.from('metrics')
        .insert({
          user_id: automation.user_id,
          date: today,
          messages_sent: 1
        });
    }

  } catch (err) {
    console.error('Error handling comment:', err.response?.data || err.message);
  }
}

// ==========================================
// 3. AUTOMATIONS CRUD ROUTES
// ==========================================

app.post('/automations/create', async (req, res) => {
  const { data, error } = await supabase.from('automations').insert(req.body).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

app.get('/automations/:user_id', async (req, res) => {
  const { data, error } = await supabase.from('automations').select('*').eq('user_id', req.params.user_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.put('/automations/:id', async (req, res) => {
  const { data, error } = await supabase.from('automations').update(req.body).eq('id', req.params.id).select();
  if (error) return res.status(400).json({ error: error.message });
  res.json(data[0]);
});

app.delete('/automations/:id', async (req, res) => {
  const { error } = await supabase.from('automations').delete().eq('id', req.params.id);
  if (error) return res.status(400).json({ error: error.message });
  res.json({ success: true });
});

// ==========================================
// 4. LEADS & METRICS ROUTES
// ==========================================

app.get('/leads/:automation_id', async (req, res) => {
  const { data, error } = await supabase.from('leads').select('*').eq('automation_id', req.params.automation_id);
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

app.get('/metrics/:user_id', async (req, res) => {
  const { period } = req.query; // 7days, 30days, alltime
  let query = supabase.from('metrics').select('*').eq('user_id', req.params.user_id);

  if (period === '7days') {
    const d = new Date(); d.setDate(d.getDate() - 7);
    query = query.gte('date', d.toISOString().split('T')[0]);
  } else if (period === '30days') {
    const d = new Date(); d.setDate(d.getDate() - 30);
    query = query.gte('date', d.toISOString().split('T')[0]);
  }

  const { data, error } = await query;
  if (error) return res.status(400).json({ error: error.message });
  res.json(data);
});

// Start Server
app.listen(PORT, () => {
  console.log(`Photon Clout Backend running on port ${PORT}`);
});
