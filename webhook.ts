import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Middleware
app.use(bodyParser.json());

// Add CORS middleware
app.use((req, res, next) => {
  Object.keys(corsHeaders).forEach(key => {
    res.setHeader(key, corsHeaders[key as keyof typeof corsHeaders]);
  });
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
    return;
  }
  
  next();
});

/**
 * Trigger keywords for different chatbot types
 */
const TRIGGER_KEYWORDS = {
  CLIENT: [
    'support', 'help', 'customer service', 'assistance', 'problem', 
    'issue', 'complaint', 'service client', 'aide', 'problème'
  ],
  EDUCATION: [
    'learn', 'study', 'course', 'education', 'school', 'homework', 
    'assignment', 'question', 'apprendre', 'étudier', 'cours', 'éducation', 
    'école', 'devoir', 'exercice'
  ],
  QUIZ: [
    'quiz', 'game', 'test', 'play', 'challenge', 'question', 'answer',
    'jeu', 'défi', 'réponse', 'questionnaire'
  ]
};

/**
 * Determine which chatbot should handle the message based on content analysis
 * @param message The message text to analyze
 * @returns The chatbot type: 'client', 'education', or 'quiz'
 */
function determineChatbotType(message: string): 'client' | 'education' | 'quiz' {
  const lowerMessage = message.toLowerCase();
  
  // Check for education keywords
  if (TRIGGER_KEYWORDS.EDUCATION.some(keyword => lowerMessage.includes(keyword))) {
    return 'education';
  }
  
  // Check for quiz keywords
  if (TRIGGER_KEYWORDS.QUIZ.some(keyword => lowerMessage.includes(keyword))) {
    return 'quiz';
  }
  
  // Default to client support if no other matches
  return 'client';
}

/**
 * GET endpoint for webhook verification
 * This is required by Meta to verify the webhook
 */
app.get('/webhook', (req: Request, res: Response) => {
  // Parse query parameters
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  // Check if a token and mode were sent
  if (mode && token) {
    // Check the mode and token sent are correct
    if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
      // Respond with the challenge token from the request
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      // Respond with '403 Forbidden' if verify tokens do not match
      console.error('Verification failed. Token mismatch.');
      res.sendStatus(403);
    }
  } else {
    // Missing required parameters - return success for health checks
    console.log('Webhook health check');
    res.status(200).json({ status: 'ok', message: 'Webhook is running' });
  }
});

/**
 * POST endpoint for receiving webhook events
 * This handles incoming messages and status updates from WhatsApp
 */
app.post('/webhook', async (req: Request, res: Response) => {
  try {
    // Check if this is a WhatsApp message event
    if (req.body.object === 'whatsapp_business_account') {
      // Process each entry in the webhook event
      for (const entry of req.body.entry || []) {
        // Process each change in the entry
        for (const change of entry.changes || []) {
          // Check if this is a messages event
          if (change.field === 'messages') {
            // Get the phone number ID (identifies the client)
            const phoneNumberId = change.value.metadata?.phone_number_id;
            
            if (!phoneNumberId) {
              console.error('Missing phone_number_id in webhook payload');
              continue;
            }

            // Handle message status updates
            if (change.value.statuses) {
              for (const status of change.value.statuses) {
                await handleStatusUpdate(phoneNumberId, status);
              }
            }

            // Process each message
            for (const message of change.value.messages || []) {
              // Handle text messages
              if (message.type === 'text' && message.text) {
                const from = message.from; // Sender's phone number
                const messageText = message.text.body; // Message content
                
                console.log(`Received message from ${from}: ${messageText}`);
                
                // Determine which chatbot should handle this message
                const chatbotType = determineChatbotType(messageText);
                
                // Forward the message to the appropriate endpoint
                await forwardMessage(chatbotType, {
                  phoneNumberId,
                  from,
                  text: messageText,
                  messageId: message.id,
                  timestamp: message.timestamp
                });
              } else if (message.type === 'image' || message.type === 'video' || message.type === 'document') {
                // Handle media messages
                const from = message.from;
                const mediaId = message[message.type].id;
                const mimeType = message[message.type].mime_type;
                
                console.log(`Received ${message.type} from ${from} with ID: ${mediaId}`);
                
                // For media messages, default to education chatbot as it's likely
                // students sending homework problems or educational content
                const chatbotType = 'education';
                
                // Forward the media message
                await forwardMessage(chatbotType, {
                  phoneNumberId,
                  from,
                  mediaType: message.type,
                  mediaId,
                  mimeType,
                  messageId: message.id,
                  timestamp: message.timestamp
                });
              }
            }
          }
        }
      }
      
      // Return a 200 OK response to acknowledge receipt
      res.status(200).send('EVENT_RECEIVED');
    } else {
      // Not a WhatsApp Business API event
      console.warn(`Received webhook event for ${req.body.object}`);
      res.sendStatus(404);
    }
  } catch (error) {
    console.error('Error processing webhook:', error);
    res.status(500).send('Error processing webhook');
  }
});

/**
 * Handle message status updates (delivered, read, failed)
 * @param phoneNumberId The phone number ID associated with the client
 * @param status The status update object from WhatsApp
 */
async function handleStatusUpdate(phoneNumberId: string, status: any): Promise<void> {
  try {
    const statusType = status.status; // delivered, read, sent, failed
    const messageId = status.id;
    const recipientId = status.recipient_id;
    const timestamp = status.timestamp;
    
    console.log(`Status update for message ${messageId}: ${statusType}`);
    
    // Forward the status update to the main application
    const baseUrl = process.env.BOLT_WEBHOOK_ENDPOINT;
    
    if (!baseUrl) {
      console.warn('BOLT_WEBHOOK_ENDPOINT not set or empty, skipping status update forwarding');
      return;
    }
    
    // Check if the URL is a local development URL
    if (baseUrl.includes('local-credentialless.webcontainer-api.io') || 
        baseUrl.includes('localhost') || 
        baseUrl.includes('127.0.0.1')) {
      console.warn('Local development URL detected in production environment, skipping status update forwarding');
      return;
    }
    
    // Use the Edge Function endpoint directly for status updates
    // The Edge Function will handle routing based on the request body
    const endpoint = baseUrl;
    
    if (!endpoint) {
      console.warn('No endpoint available for status updates, skipping');
      return;
    }
    
    // Send the status update
    await axios.post(endpoint, {
      type: 'status_update',
      phoneNumberId,
      messageId,
      recipientId,
      status: statusType,
      timestamp
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    console.log(`Status update forwarded successfully`);
  } catch (error) {
    console.error('Error handling status update:', error.response?.data || error.message);
  }
}

/**
 * Forward the message to the appropriate chatbot endpoint
 * @param chatbotType The type of chatbot to handle the message
 * @param messageData The message data to forward
 */
async function forwardMessage(
  chatbotType: 'client' | 'education' | 'quiz',
  messageData: any
): Promise<void> {
  try {
    // Get the base URL from environment variables
    const baseUrl = process.env.BOLT_WEBHOOK_ENDPOINT;
    
    if (!baseUrl) {
      console.warn('BOLT_WEBHOOK_ENDPOINT not set or empty, sending auto-response instead');
      await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
      return;
    }
    
    // Check if the URL is a local development URL
    if (baseUrl.includes('local-credentialless.webcontainer-api.io') || 
        baseUrl.includes('localhost') || 
        baseUrl.includes('127.0.0.1')) {
      console.warn('Local development URL detected in production environment, sending auto-response instead');
      await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
      return;
    }
    
    // Construct the endpoint URL
    const endpoint = baseUrl ? new URL(`/api/chatbot/${chatbotType}`, baseUrl).toString() : null;
    
    if (!endpoint) {
      console.warn(`No endpoint available for ${chatbotType} chatbot, sending auto-response instead`);
      await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
      return;
    }
    
    console.log(`Attempting to forward message to ${endpoint}`);
    
    // Send the message to the appropriate endpoint
    const response = await axios.post(endpoint, messageData, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.META_ACCESS_TOKEN || ''}`
      }
    });
    
    console.log(`Message forwarded successfully: ${response.status}`);
  } catch (error) {
    console.error(`Error forwarding message:`, error);
    console.log('Sending auto-response instead');
    await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
  }
}

/**
 * Send an automatic response when forwarding fails
 * @param phoneNumberId The phone number ID to use for sending
 * @param to The recipient's phone number
 * @param originalMessage The original message received
 * @param chatbotType The type of chatbot that would have handled the message
 */
async function sendAutoResponse(
  phoneNumberId: string,
  to: string,
  originalMessage: string,
  chatbotType: 'client' | 'education' | 'quiz'
): Promise<void> {
  try {
    // Get access token from environment variables
    const accessToken = process.env.META_ACCESS_TOKEN;
    
    if (!accessToken) {
      console.error('META_ACCESS_TOKEN environment variable is not set');
      return;
    }
    
    // Prepare response message based on chatbot type
    let responseMessage = '';
    
    switch (chatbotType) {
      case 'education':
        responseMessage = 'Merci pour votre message concernant l\'éducation. Votre question a été reçue et sera traitée par notre équipe. Nous vous répondrons dès que possible.';
        break;
      case 'quiz':
        responseMessage = 'Merci pour votre intérêt pour nos quiz. Votre demande a été enregistrée et sera traitée par notre équipe. Nous vous répondrons dès que possible.';
        break;
      default:
        responseMessage = 'Merci pour votre message au service client. Votre demande a été enregistrée et sera traitée par notre équipe. Nous vous répondrons dès que possible.';
    }
    
    // Send response via WhatsApp API
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: responseMessage }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`Auto-response sent successfully: ${response.status}`);
  } catch (error) {
    console.error(`Error sending auto-response:`, error);
  }
}

/**
 * Endpoint to fetch templates from Meta API
 * This allows the main application to retrieve templates through the webhook
 */
app.get('/templates/:businessAccountId', async (req: Request, res: Response) => {
  try {
    const { businessAccountId } = req.params;
    const accessToken = req.headers.authorization?.split(' ')[1];
    
    if (!accessToken) {
      return res.status(401).json({ error: 'Authorization token required' });
    }
    
    if (!businessAccountId) {
      return res.status(400).json({ error: 'WhatsApp Business Account ID required' });
    }
    
    // Fetch templates from Meta API
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${businessAccountId}/message_templates`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    res.status(200).json(response.data);
  } catch (error) {
    console.error('Error fetching templates:', error);
    
    if (axios.isAxiosError(error)) {
      const status = error.response?.status || 500;
      const errorData = error.response?.data || 'Error fetching templates';
      return res.status(status).json({ error: errorData });
    }
    
    res.status(500).json({ error: 'Error fetching templates' });
  }
});

/**
 * Health check endpoint
 */
app.get('/', (req: Request, res: Response) => {
  res.status(200).json({
    status: 'ok',
    message: 'WhatsApp webhook server is running',
    version: '1.0.0'
  });
});

// Start the server
app.listen(port, () => {
  console.log(`WhatsApp webhook server listening on port ${port}`);
});