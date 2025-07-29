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
let clients = []; // This array will hold all connected browser clients

// This function will send a message to all connected clients
function broadcast(data) {
  clients.forEach(client => {
    // The "data:" prefix and "\n\n" suffix are required by the SSE spec
    client.res.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

// The new /events endpoint for browsers to connect to
app.get('/events', (req, res) => {
  // Set headers required for SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders(); // Send headers immediately

  // Add this client to our list
  const clientId = Date.now();
  const newClient = { id: clientId, res };
  clients.push(newClient);
  console.log(`Client ${clientId} connected.`);

  // Handle client disconnect
  req.on('close', () => {
    clients = clients.filter(client => client.id !== clientId);
    console.log(`Client ${clientId} disconnected.`);
  });
});

// --- 4. The Core Scraper Function (Updated Logic) ---
async function checkServerStatus() {
  try {
    console.log('Checking server status...');
    
    const response = await axios.get('https://epoch.strykersoft.us/');
    const html = response.data;
    const $ = cheerio.load(html);

    // Scrape the status into a structured format
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
    
    // Compare the old status with the new one
    // We stringify them for a simple and reliable comparison
    if (oldStatusesJSON && JSON.stringify(newStatuses) !== oldStatusesJSON) {
        console.log('STATUS CHANGE DETECTED!');
        
        // A change occurred! Broadcast it to all connected browsers.
        broadcast({
            type: 'STATUS_CHANGE',
            payload: newStatuses,
            oldPayload: JSON.parse(oldStatusesJSON) // Send old status for comparison
        });
    }

    // Always update Redis with the latest status
    await redis.set('serverStatuses', JSON.stringify(newStatuses));

  } catch (error) {
    console.error('Error checking server status:', error.message);
  }
}

// --- 5. Serve our Frontend File and other API endpoints ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// An endpoint to get the initial status when the page first loads
app.get('/api/initial-status', async (req, res) => {
    const statuses = await redis.get('serverStatuses');
    res.json(JSON.parse(statuses || '[]'));
});

// --- 6. Start Everything ---
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  
  // Schedule the check to run every minute
  // cron.schedule('* * * * *', checkServerStatus);
  // For testing, let's run it every 10 seconds. Change back for production.
  cron.schedule('* * * * *', checkServerStatus); 
  console.log('Cron job scheduled to run every minute.');
});