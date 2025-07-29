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

// --- 4. The Core Scraper Function (Corrected for the REAL website structure) ---
async function checkServerStatus() {
  try {
    console.log('Checking server status...');
    
    const response = await axios.get('https://epoch.strykersoft.us/', {
      headers: { // Keep the user-agent, it's good practice
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36'
      }
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // ================== THE REAL FIX ==================
    // The website does not use a table. We will extract text and parse it manually.
    const newStatuses = [];
    const bodyText = $('body').text(); // Get all text from the page
    const lines = bodyText.split('\n').map(line => line.trim()).filter(Boolean); // Split into lines

    // Find lines that contain server status keywords
    const keywords = ["Auth Server", "Kezan", "Gurubashi", "Acct Registration"];
    lines.forEach(line => {
      keywords.forEach(keyword => {
        if (line.startsWith(keyword)) {
          const parts = line.split(':');
          const serverName = parts[0].trim();
          const serverStatus = parts[1] ? parts[1].trim() : 'Unknown';
          newStatuses.push({ name: serverName, status: serverStatus });
        }
      });
    });
    // ======================================================

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