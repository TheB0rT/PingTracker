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

// --- 4. The Core Scraper Function (FINAL version) ---
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
    
    const newStatuses = [];
    $('div.text-center div[id]').each((i, element) => {
      const serverName = $(element).attr('id');
      const p_tag = $(element).find('p');
      let serverStatus = 'Unknown';

      if (p_tag.hasClass('up')) {
        serverStatus = 'Up';
      } else if (p_tag.hasClass('down')) {
        serverStatus = 'Down';
      }

      if (serverName && serverStatus !== 'Unknown') {
        newStatuses.push({ name: serverName, status: serverStatus });
      }
    });

    if (newStatuses.length === 0) {
      console.log('Scrape returned 0 servers. Skipping update.');
      return; 
    }
    
    const newStatusesString = JSON.stringify(newStatuses);
    const oldStatusesJSON = await redis.get('serverStatuses');
    let oldStatuses = null;

    if (oldStatusesJSON) {
        try {
            oldStatuses = JSON.parse(oldStatusesJSON);
        } catch (e) {
            console.error('Found corrupted data in Redis, will overwrite now. Error:', e.message);
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

    // ================== THE FINAL BULLETPROOF CHECK ==================
    // This is a hard gate. We will not allow a non-string or empty string to be saved.
    if (typeof newStatusesString === 'string' && newStatusesString.length > 2) { // > 2 to avoid saving "[]"
        await redis.set('serverStatuses', newStatusesString);
    } else {
        // If this log ever appears, it will tell us the source of the corruption.
        console.error('CRITICAL FAILURE: Attempted to write invalid data to Redis. Halting write operation.');
        console.error('Data Type:', typeof newStatusesString);
        console.error('Data Value:', newStatusesString);
    }
    // =================================================================

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