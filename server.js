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

// --- 4. The Core Scraper Function (With Quality Gate) ---
async function checkServerStatus() {
  try {
    console.log('Checking server status...');
    
    const response = await axios.get('https://epoch.strykersoft.us/');
    const html = response.data;
    const $ = cheerio.load(html);

    const newStatuses = [];
    $('tbody tr').each((i, row) => {
      const serverName = $(row).find('td').eq(0).text().trim();
      const serverStatus = $(row).find('td').eq(1).text().trim();
      if (serverName) {
        newStatuses.push({ name: serverName, status: serverStatus });
      }
    });

    // ================== THE FINAL FIX: THE QUALITY GATE ==================
    // If our scrape resulted in zero servers, we assume the scrape failed.
    // We will not proceed, preserving the last known good status in Redis.
    if (newStatuses.length === 0) {
      console.log('Scrape returned 0 servers. Assuming upstream failure. Skipping update.');
      return; // End the function here.
    }
    // =====================================================================
    
    const newStatusesString = JSON.stringify(newStatuses);
    const oldStatusesJSON = await redis.get('serverStatuses');
    let oldStatuses = null;

    if (oldStatusesJSON) {
        try {
            oldStatuses = JSON.parse(oldStatusesJSON);
        } catch (e) {
            console.error('Found corrupted data in Redis, will overwrite with fresh data. Error:', e.message);
            // We no longer delete the key, we just let the good data overwrite it.
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

    // Only good, valid data will ever reach this line.
    await redis.set('serverStatuses', newStatusesString);

  } catch (error) {
    console.error('Error in checkServerStatus function:', error.message);
  }
}

// --- 5. Serve our Frontend File and other API endpoints (Now also Safe) ---
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