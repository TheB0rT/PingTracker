// --- 1. Import necessary libraries ---
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const fs = require('fs'); // File System: to read and write files
const path = require('path'); // Path: to help find files

// --- 2. Initialize the Express app ---
const app = express();
const PORT = 3000; // The port our server will run on

// --- 3. Set up global variables and constants ---
const TARGET_URL = 'https://epoch.strykersoft.us/';
const STATUS_FILE = path.join(__dirname, 'status.json'); // A file to store our data

// In-memory state variables
let lastKnownContent = '';
let lastPingTime = null;

// --- 4. Function to load the initial status from our file ---
function loadInitialStatus() {
    try {
        if (fs.existsSync(STATUS_FILE)) {
            const data = fs.readFileSync(STATUS_FILE, 'utf-8');
            const status = JSON.parse(data);
            lastKnownContent = status.lastKnownContent || '';
            lastPingTime = status.lastPingTime ? new Date(status.lastPingTime) : null;
            console.log('Initial status loaded from file.');
        } else {
             console.log('No status file found. Starting fresh.');
        }
    } catch (error) {
        console.error('Error loading status file:', error);
    }
}

// --- 5. The Core Scraper Function ---
async function checkServerStatus() {
    try {
        console.log('Checking server status...');
        
        // Fetch the website's HTML
        const response = await axios.get(TARGET_URL);
        const html = response.data;
        
        // Load the HTML into Cheerio to parse it
        const $ = cheerio.load(html);
        
        // Select a specific, reliable part of the page to check for changes.
        // The table body (tbody) is a good candidate.
        const currentContent = $('tbody').html();

        // If the content is different from what we last saw...
        if (currentContent && lastKnownContent && currentContent !== lastKnownContent) {
            console.log('Change detected! Updating ping time.');
            lastPingTime = new Date(); // Record the current time
            
            // Save the new state to our file for persistence
            const statusToSave = {
                lastKnownContent: currentContent,
                lastPingTime: lastPingTime.toISOString() // Save as standard string
            };
            fs.writeFileSync(STATUS_FILE, JSON.stringify(statusToSave, null, 2));
        }

        // Update our "last seen" content
        lastKnownContent = currentContent;

    } catch (error) {
        console.error('Error checking server status:', error.message);
    }
}

// --- 6. Set up the API Endpoint ---
// This is the URL our frontend will call
app.get('/api/status', (req, res) => {
    res.json({
        lastPingTime: lastPingTime
    });
});

// --- 7. Serve our Frontend File ---
// When someone visits the main URL, send them the index.html file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});


// --- 8. Start Everything ---
app.listen(PORT, () => {
    console.log(`Server is running at http://localhost:${PORT}`);
    
    // Load any previously saved status
    loadInitialStatus();
    
    // Run the check once immediately on startup
    checkServerStatus();
    
    // Schedule the check to run every minute
    cron.schedule('* * * * *', checkServerStatus); 
    console.log('Cron job scheduled to run every minute.');
});