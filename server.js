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

// --- 4. The Core Scraper Function (Updated with defensive checks) ---
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

    // Get the old status from our Redis database
    const oldStatusesJSON = await redis.get('serverStatuses');
    
    // **THE FIX IS HERE:** Check if oldStatusesJSON actually exists before comparing
    if (oldStatusesJSON && JSON.stringify(newStatuses) !== oldStatusesJSON) {
        console.log('STATUS CHANGE DETECTED!');
        
        // **AND HERE:** Safely parse the old status for the broadcast payload
        broadcast({
            type: 'STATUS_CHANGE',
            payload: newStatuses,
            oldPayload: JSON.parse(oldStatusesJSON) // It's safe to parse here because we know it exists
        });
    }

    // Always update Redis with the latest status
    await redis.set('serverStatuses', JSON.stringify(newStatuses));

  } catch (error) {
    // Improved error logging
    console.error('Error in checkServerStatus function:', error.message);
  }
}

// --- 5. Serve our Frontend File and other API endpoints ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// An endpoint to get the initial status when the page first loads
app.get('/api/initial-status', async (req, res) => {
    const statusesJSON = await redis.get('serverStatuses');
    
    // **THE FIX IS HERE TOO:** Safely parse the data before sending
    const statuses = statusesJSON ? JSON.parse(statusesJSON) : [];
    res.json(statuses);
});

// --- 6. Start Everything ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Schedule the check to run every minute
  cron.schedule('* * * * *', checkServerStatus); 
  console.log('Cron job scheduled to run every minute.');
});``