// --- 1. Import necessary libraries ---
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const path = require('path');
const { Redis } = require('@upstash/redis'); // Import the Upstash Redis client

// --- 2. Initialize the Express app and Redis client ---
const app = express();
const PORT = process.env.PORT || 3000; // Render provides the PORT variable

// Connect to your Upstash database using the environment variables we set
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// --- 3. Set up global variables and constants ---
const TARGET_URL = 'https://epoch.strykersoft.us/';

// --- 4. The Core Scraper Function (Now talks to Redis) ---
async function checkServerStatus() {
    try {
        console.log('Checking server status...');
        
        const response = await axios.get(TARGET_URL);
        const html = response.data;
        const $ = cheerio.load(html);
        const currentContent = $('tbody').html();

        // Get the last known content from our Redis database
        const lastKnownContent = await redis.get('lastKnownContent');

        // If the content is different, update the database
        if (currentContent && lastKnownContent && currentContent !== lastKnownContent) {
            console.log('Change detected! Updating ping time in Redis.');
            const newPingTime = new Date();
            
            // Atomically set both new values in the database
            await redis.mset({
                'lastKnownContent': currentContent,
                'lastPingTime': newPingTime.toISOString()
            });
        } else if (!lastKnownContent && currentContent) {
            // This handles the very first run
            console.log('First run, setting initial content.');
            await redis.set('lastKnownContent', currentContent);
        }

    } catch (error) {
        console.error('Error checking server status:', error.message);
    }
}

// --- 5. Set up the API Endpoint (Now talks to Redis) ---
app.get('/api/status', async (req, res) => {
    // Fetch the latest ping time directly from the database
    const lastPingTime = await redis.get('lastPingTime');
    res.json({
        lastPingTime: lastPingTime // This will be null if it was never set
    });
});

// --- 6. Serve our Frontend File ---
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// --- 7. Start Everything ---
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    
    // Run the check once immediately on startup
    checkServerStatus();
    
    // Schedule the check to run every minute
    cron.schedule('* * * * *', checkServerStatus); 
    console.log('Cron job scheduled to run every minute.');
});