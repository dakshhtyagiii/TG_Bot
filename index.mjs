import express from 'express';
import bodyParser from 'body-parser';
import fetch from 'node-fetch';
import OpenAI from 'openai';
import { config } from 'dotenv';

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

let userState = {};

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
    const userText = message.text;

    if (userText === '/start') {
        userState[chatId] = { awaitingLocation: false, query: '' };
        console.log(`State reset for chatId ${chatId}`);
        await sendMessage(chatId, 'Hello! How can I assist you today? Ask me anything!');
    } else if (message.location) {
        if (userState[chatId]?.awaitingLocation) {
            const { query } = userState[chatId];
            const latitude = message.location.latitude;
            const longitude = message.location.longitude;
            await handleLocation(chatId, latitude, longitude, query);
        } else {
            await sendMessage(chatId, 'Thank you for sharing your location! What information do you need?');
        }
    } else if (isValidCoordinates(userText)) {
        const [latitude, longitude] = userText.split(',').map(coord => parseFloat(coord.trim()));
        if (userState[chatId]?.awaitingLocation) {
            const { query } = userState[chatId];
            await handleLocation(chatId, latitude, longitude, query);
        } else {
            await sendMessage(chatId, 'Thank you for sharing your coordinates! What information do you need?');
        }
    } else {
        // Check if the query is likely location-based or general
        const isLocationBased = checkIfLocationBased(userText);
        if (isLocationBased) {
            userState[chatId] = { awaitingLocation: true, query: userText.trim() };
            await sendMessage(chatId, 'Got it! Now, please share your location for more accurate suggestions.');
        } else {
            const response = await getChatGPTResponse(userText);
            await sendMessage(chatId, response);
        }
    }
}

// Function to check if a query is location-based
function checkIfLocationBased(query) {
    const locationKeywords = ['nearby', 'close to', 'around', 'location', 'near', 'place'];
    return locationKeywords.some(keyword => query.toLowerCase().includes(keyword));
}

// Function to get a response from ChatGPT 3.5
async function getChatGPTResponse(userQuery) {
    console.log('Sending query to GPT-3.5:', userQuery);
    const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: userQuery }
    ];

    const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: messages,
        max_tokens: 150,
    });

    const reply = response.choices[0].message.content.trim();
    console.log('GPT-3.5 response:', reply);
    return reply;
}

// Function to handle location messages
async function handleLocation(chatId, latitude, longitude, query) {
    console.log(`Received location: latitude=${latitude}, longitude=${longitude}`);
    console.log(`Using search term for chatId ${chatId}: ${query}`);
    const places = await getNearbyPlaces(latitude, longitude, query);
    if (!places || places.length === 0) {
        await sendMessage(chatId, `I couldn't find any nearby ${query}. Please try again later.`);
        return;
    }
    const suggestions = await getSuggestionsFromGPT3(places);
    await sendMessage(chatId, suggestions);
    userState[chatId] = { awaitingLocation: false, query: '' }; // Reset state after use
    console.log(`State reset after use for chatId ${chatId}`);
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

// Function to get nearby places using Foursquare API
async function getNearbyPlaces(latitude, longitude, query) {
    console.log(`Fetching places for location: latitude=${latitude}, longitude=${longitude}, query=${query}`);
    const radius = 5000; // Radius in meters

    try {
        const response = await fetch(`https://api.foursquare.com/v3/places/search?ll=${latitude},${longitude}&radius=${radius}&query=${query}`, {
            headers: {
                'Authorization': `Bearer ${FOURSQUARE_API_KEY}`
            }
        });
        const data = await response.json();
        console.log('Foursquare Places raw response:', data); // Log the raw response
        if (data && data.results) {
            return data.results;
        } else {
            console.error('Unexpected Foursquare response structure:', data);
            return [];
        }
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
 