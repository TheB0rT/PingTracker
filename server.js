// --- 1. Import necessary libraries ---
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const path = require('path');
const { Redis } = require('@upstash/redis');

// --- 2. Initialize the app and Redis client ---
const app = express();
const PORT = process.env.PORT || 3000;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- 3. Set up for Server-Sent Events (SSE) ---
let clients = []; 

function broadcast(data) {
  clients.forEach(client => {
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); 

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);
  console.log(`Client ${clientId} connected.`);

  req.on('close', () => {
    clients = clients.filter(client => client.id !== clientId);
    console.log(`Client ${clientId} disconnected.`);
  });
});

// --- 4. The Core Scraper Function (Based on ACTUAL site content) ---
async function checkServerStatus() {
  try {
    console.log('Checking server status...');
    
    const response = await axios.get('https://epoch.strykersoft.us/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      }
    });

    const html = response.data;
    const $ = cheerio.load(html);
    const bodyText = $('body').text(); // Get the single line of text, e.g., "...Auth Server: Down Kezan (PvE): Down..."
    
    const newStatuses = [];
    // Define the exact server names to look for
    const serverNames = ["Epoch Website", "Auth Server", "Kezan (PvE)", "Gurubashi (PvP)", "Acct Registration"];

    // For each server name, find its status in the text string
    serverNames.forEach(serverName => {
      // This regex looks for the server name, a colon, whitespace, and captures the next word (Up/Down)
      const regex = new RegExp(`${serverName}:\\s*(\\w+)`);
      const match = bodyText.match(regex);

      if (match && match[1]) {
        newStatuses.push({ name: serverName, status: match[1] });
      }
    });

    if (newStatuses.length === 0) {
      console.log('Scrape returned 0 servers. Website structure may have changed. Skipping update.');
      return; 
    }
    
    const newStatusesString = JSON.stringify(newStatuses);
    const oldStatusesJSON = await redis.get('serverStatuses');
    let oldStatuses = null;

    if (oldStatusesJSON) {
        try {
            oldStatuses = JSON.parse(oldStatusesJSON);
        } catch (e) {
            console.error('Found corrupted data in Redis, will overwrite with fresh data. Error:', e.message);
        }
    }

    if (oldStatuses && newStatusesString !== oldStatusesJSON) {
        console.log('STATUS CHANGE DETECTED!');
        broadcast({
            type: 'STATUS_CHANGE',
            payload: newStatuses,
            oldPayload: oldStatuses
        });
    }

    await redis.set('serverStatuses', newStatusesString);

  } catch (error) {
    console.error('Error in checkServerStatus function:', error.message);
  }
}

// --- 5. Serve our Frontend File and other API endpoints ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/initial-status', async (req, res) => {
    const statusesJSON = await redis.get('serverStatuses');
    let statuses = []; 

    if (statusesJSON) {
        try {
            statuses = JSON.parse(statusesJSON);
        } catch (e) {
            console.error('API endpoint found corrupted data. Sending empty array to client. Error:', e.message);
        }
    }
    
    res.json(statuses);
});

// --- 6. Start Everything ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  cron.schedule('* * * * *', checkServerStatus); 
  console.log('Cron job scheduled to run every minute.');
});