import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import { config } from 'dotenv';
import sdk from '@api/fsq-developers';

// Load environment variables from .env file
config();

const app = express();
const PORT = process.env.PORT || 3002;

const API_TOKEN = process.env.TELEGRAM_API_TOKEN;
const NGROK_URL = process.env.NGROK_URL;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${API_TOKEN}`;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const FOURSQUARE_API_KEY = process.env.FOURSQUARE_API_KEY;

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// Foursquare SDK initialization
sdk.auth(FOURSQUARE_API_KEY);

let userSearchTerms = {};

// Middleware to parse JSON
app.use(bodyParser.json());

// Set up webhook endpoint
app.post(`/webhook/${API_TOKEN}`, (req, res) => {
    console.log('Webhook received:', req.body);
    const { message } = req.body;
    if (message) {
        handleMessage(message);
    }
    res.sendStatus(200);
});

// Function to handle messages
async function handleMessage(message) {
    console.log('Handling message:', message);
    const chatId = message.chat.id;

    if (message.text === '/start') {
        userSearchTerms[chatId] = null; // Reset search term for the new session
        console.log(`Search term reset for chatId ${chatId}`);
        await sendMessage(chatId, 'Hello! What do you want to search nearby? Please enter your query.');
    } else if (!userSearchTerms[chatId] && message.text) {
        userSearchTerms[chatId] = message.text.trim();
        console.log(`Search term set for chatId ${chatId}: ${userSearchTerms[chatId]}`);
        await sendMessage(chatId, 'Please share your location.');
    } else if (message.location) {
        await handleLocation(chatId, message.location.latitude, message.location.longitude);
    } else if (message.text && isValidCoordinates(message.text)) {
        const [latitude, longitude] = message.text.split(',').map(coord => parseFloat(coord.trim()));
        await handleLocation(chatId, latitude, longitude);
    } else {
        await sendMessage(chatId, 'Please send your location or coordinates in the format "latitude,longitude".');
    }
}

// Function to handle location messages
async function handleLocation(chatId, latitude, longitude) {
    console.log(`Received location: latitude=${latitude}, longitude=${longitude}`);
    const searchTerm = userSearchTerms[chatId];
    console.log(`Using search term for chatId ${chatId}: ${searchTerm}`);
    const places = await getNearbyPlaces(latitude, longitude, searchTerm);
    if (places.length === 0) {
        await sendMessage(chatId, `I couldn't find any nearby ${searchTerm}. Please try again later.`);
        return;
    }
    const suggestions = await getSuggestionsFromGPT3(places);
    await sendMessage(chatId, suggestions);
    userSearchTerms[chatId] = null; // Reset the search term after use
    console.log(`Search term reset after use for chatId ${chatId}`);
}

// Function to send a message
async function sendMessage(chatId, text) {
    console.log('Sending message to chatId:', chatId, 'text:', text);
    await fetch(`${TELEGRAM_API_URL}/sendMessage`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            chat_id: chatId,
            text: text
        })
    });
}

// Function to get nearby places using Foursquare SDK
async function getNearbyPlaces(latitude, longitude, query) {
    console.log(`Fetching places for location: latitude=${latitude}, longitude=${longitude}, query=${query}`);
    const radius = 5000; // Radius in meters
    
    try {
        const { data } = await sdk.placeSearch({
            query: query,
            ll: `${latitude},${longitude}`,
            radius: radius.toString()
        });

        console.log('Foursquare Places result:', data.results);
        return data.results;
    } catch (err) {
        console.error('Error fetching Foursquare Places data:', err);
        return [];
    }
}

// Function to get suggestions from GPT-3.5
async function getSuggestionsFromGPT3(places) {
    const placeNames = places.map(place => place.name).join(', ');
    const prompt = `Here are some nearby places: ${placeNames}. Please suggest the best ones to visit.`;

    console.log('Generating suggestions from GPT-3.5');
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: prompt }
    ];

    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: 150,
    });

    const suggestion = response.choices[0].message.content.trim();
    console.log('GPT-3.5 suggestion:', suggestion);
    return suggestion;
}

// Helper function to validate coordinates
function isValidCoordinates(text) {
    const regex = /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/;
    return regex.test(text);
}

// Start Express server
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
    setWebhook();
});

// Function to set webhook
async function setWebhook() {
    const webhookUrl = `${NGROK_URL}/webhook/${API_TOKEN}`;
    console.log('Setting webhook to URL:', webhookUrl);
    await fetch(`${TELEGRAM_API_URL}/setWebhook`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            url: webhookUrl
        })
    });
}
