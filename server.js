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

// --- 4. The Core Scraper Function (Updated with diagnostics and defense) ---
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

    const oldStatusesJSON = await redis.get('serverStatuses');
    
    // ================== NEW DIAGNOSTIC LOG ==================
    // This will show us the exact content of the variable before the check.
    console.log(`DEBUG: oldStatusesJSON from Redis is: >${oldStatusesJSON}<`);
    // ========================================================

    if (oldStatusesJSON && JSON.stringify(newStatuses) !== oldStatusesJSON) {
        console.log('STATUS CHANGE DETECTED!');
        
        // ================== NEW DEFENSIVE BLOCK ==================
        // We will try to parse the JSON, but if it fails, we won't crash.
        try {
            const oldPayload = JSON.parse(oldStatusesJSON);
            
            broadcast({
                type: 'STATUS_CHANGE',
                payload: newStatuses,
                oldPayload: oldPayload
            });
        } catch (parseError) {
            console.error('CRITICAL: Failed to parse oldStatusesJSON even after passing the check. The invalid data was:', oldStatusesJSON);
            console.error(parseError);
        }
        // ========================================================
    }

    // Always update Redis with the latest status
    await redis.set('serverStatuses', JSON.stringify(newStatuses));

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
    const statuses = statusesJSON ? JSON.parse(statusesJSON) : [];
    res.json(statuses);
});

// --- 6. Start Everything ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  cron.schedule('* * * * *', checkServerStatus); 
  console.log('Cron job scheduled to run every minute.');
});