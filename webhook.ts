import express, { Request, Response } from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

// Get Supabase service role key from environment variables
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Initialize Express app
const app = express();
const port = process.env.PORT || 3000;

// Supabase authentication
const SUPABASE_URL = 'https://tyeysspawsupdgaowrec.supabase.co';
const SUPABASE_FUNCTION_PATH = '/functions/v1/api-chatbot';

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
  
  // Check for client support keywords
  if (TRIGGER_KEYWORDS.CLIENT.some(keyword => lowerMessage.includes(keyword))) {
    return 'client';
  }
  
  // If the message is literally "client", "education", or "quiz", return that directly
  if (lowerMessage === 'client' || lowerMessage === 'service client') {
    return 'client';
  }
  if (lowerMessage === 'education') {
    return 'education';
  }
  if (lowerMessage === 'quiz') {
    return 'quiz';
  }
  
  // Default to education if no other matches (changed from client to ensure compatibility)
  return 'education';
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
                
                // Download the media file from WhatsApp API
                const mediaUrl = await downloadWhatsAppMedia(mediaId, phoneNumberId);
                
                // For media messages, default to education chatbot as it's likely
                // students sending homework problems or educational content
                const chatbotType = 'education';
                
                // Forward the media message
                await forwardMessage(chatbotType, {
                  phoneNumberId,
                  from,
                  text: `[${message.type.toUpperCase()}]`, // Placeholder text
                  imageUrl: mediaUrl, // Add the actual image URL
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
    console.error('Error processing webhook:');
    if (error instanceof Error) {
      console.error(error.message);
    } else {
      console.error(String(error));
    }
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
    
    // Hardcoded Supabase Edge Function URL
    const endpoint = `${SUPABASE_URL}${SUPABASE_FUNCTION_PATH}`;
    
    // Check if we have the service role key
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set in environment variables');
      return;
    }
    
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
      timestamp,
      // Add any additional data needed by the status handler
      phoneNumber: recipientId
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    
    console.log(`Status update forwarded successfully`);
  } catch (error) {
    console.error('Error handling status update:');
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('Response data:', error.response.data);
      } else {
        console.error('Error message:', error.message);
      }
    } else if (error instanceof Error) {
      console.error('Error message:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
  }
}

/**
 * Download media file from WhatsApp API and return public URL
 * @param mediaId The media ID from WhatsApp
 * @param phoneNumberId The phone number ID for API access
 * @returns Public URL of the downloaded media
 */
async function downloadWhatsAppMedia(mediaId: string, phoneNumberId: string): Promise<string | null> {
  try {
    console.log(`📥 [MEDIA] Downloading media with ID: ${mediaId}`);
    
    // Get access token from environment variables
    const accessToken = process.env.META_ACCESS_TOKEN;
    
    if (!accessToken) {
      console.error('❌ [MEDIA] META_ACCESS_TOKEN environment variable is not set');
      return null;
    }
    
    // Step 1: Get media URL from WhatsApp API
    const mediaInfoResponse = await axios.get(
      `https://graph.facebook.com/v19.0/${mediaId}`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        }
      }
    );
    
    if (!mediaInfoResponse.data.url) {
      console.error('❌ [MEDIA] No URL found in media info response');
      return null;
    }
    
    const mediaUrl = mediaInfoResponse.data.url;
    console.log(`📥 [MEDIA] Got media URL: ${mediaUrl}`);
    
    // Step 2: Download the actual media file
    const mediaResponse = await axios.get(mediaUrl, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      },
      responseType: 'arraybuffer'
    });
    
    // Step 3: Convert to base64 for transmission
    const base64Data = Buffer.from(mediaResponse.data).toString('base64');
    const mimeType = mediaResponse.headers['content-type'] || 'image/jpeg';
    const dataUrl = `data:${mimeType};base64,${base64Data}`;
    
    console.log(`✅ [MEDIA] Media downloaded and converted to base64`);
    return dataUrl;
    
  } catch (error) {
    console.error('❌ [MEDIA] Error downloading media:', error);
    return null;
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
    // Hardcoded Supabase Edge Function URL
    const endpoint = `${SUPABASE_URL}${SUPABASE_FUNCTION_PATH}`;
    
    // Check if we have the service role key
    if (!SUPABASE_SERVICE_ROLE_KEY) {
      console.error('SUPABASE_SERVICE_ROLE_KEY is not set in environment variables');
      await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
      return;
    }
    
    if (!endpoint) {
      console.warn(`No endpoint available for ${chatbotType} chatbot, sending auto-response instead`);
      await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
      return;
    }
    
    console.log(`Attempting to forward message to ${endpoint}`);
    
    // Ensure the chatbotType is correctly formatted for the API
    // The API expects 'client', 'education', or 'quiz'
    let formattedChatbotType = chatbotType;
    
    // Add chatbot type to the message data with proper validation
    const messageDataWithType = {
      ...messageData,
      chatbotType: formattedChatbotType,
      from: messageData.from,
      text: messageData.text || messageData.messageText,
      timestamp: messageData.timestamp,
      messageId: messageData.messageId
    };
    
    console.log('Sending payload to Edge Function:', JSON.stringify(messageDataWithType, null, 2));
    
    // Send the message to the appropriate endpoint
    const response = await axios.post(endpoint, {
      from: messageData.from,
      text: messageData.text || messageData.messageText,
      phoneNumberId: messageData.phoneNumberId,
      messageId: messageData.messageId,
      timestamp: messageData.timestamp,
      chatbotType: formattedChatbotType
    }, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
      }
    });
    
    console.log(`Message forwarded successfully: ${response.status}`);
    console.log('Edge Function response:', response.data);
    
    // ✅ NEW: Check if Edge Function returned a successful response with content
    if (response.data && response.data.success && response.data.response) {
      console.log(`📤 Edge Function provided response: "${response.data.response}"`);
      console.log(`📱 Sending response back to WhatsApp user: ${messageData.from}`);
      
      // Send the actual chatbot response directly
      await sendChatbotResponse(
        messageData.phoneNumberId, 
        messageData.from, 
        response.data.response
      );
      
      console.log(`✅ Chatbot response sent successfully to ${messageData.from}`);
    } else {
      console.log(`❌ Edge Function did not provide a valid response:`, response.data);
      
      // Fallback to auto-response if Edge Function failed
      await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
    }
  } catch (error) {
    console.error(`Error forwarding message:`);
    
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
      } else {
        console.error('Error message:', error.message);
      }
    } else if (error instanceof Error) {
      console.error('Error message:', error.message);
    } else {
      console.error('Unknown error:', error);
    }
    
    // ✅ UPDATED: Only send fallback auto-response if Edge Function completely failed
    console.log(`⚠️ Edge Function failed, sending fallback auto-response`);
    await sendAutoResponse(messageData.phoneNumberId, messageData.from, messageData.text, chatbotType);
  }
}

/**
 * Send the actual chatbot response to WhatsApp
 * @param phoneNumberId The phone number ID to use for sending
 * @param to The recipient's phone number
 * @param chatbotResponse The response generated by the chatbot
 */
async function sendChatbotResponse(
  phoneNumberId: string,
  to: string,
  chatbotResponse: string
): Promise<void> {
  try {
    console.log(`📤 [CHATBOT-RESPONSE] Sending chatbot response to ${to}`);
    console.log(`📤 [CHATBOT-RESPONSE] Response content: "${chatbotResponse.substring(0, 100)}${chatbotResponse.length > 100 ? '...' : ''}"`);
    
    // Get access token from environment variables
    const accessToken = process.env.META_ACCESS_TOKEN;
    
    if (!accessToken) {
      console.error('❌ [CHATBOT-RESPONSE] META_ACCESS_TOKEN environment variable is not set');
      return;
    }
    
    console.log(`📤 [CHATBOT-RESPONSE] Using phone number ID: ${phoneNumberId}`);
    console.log(`📤 [CHATBOT-RESPONSE] Access token exists: ${!!accessToken}`);
    
    // Send response via WhatsApp API
    const response = await axios.post(
      `https://graph.facebook.com/v19.0/${phoneNumberId}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: to,
        type: 'text',
        text: { body: chatbotResponse }
      },
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    
    console.log(`✅ [CHATBOT-RESPONSE] WhatsApp message sent successfully: ${response.status}`);
    console.log(`📱 [CHATBOT-RESPONSE] Exact message sent to ${to}: "${chatbotResponse}"`);
  } catch (error) {
    console.error(`❌ [CHATBOT-RESPONSE] Error sending WhatsApp message:`);
    
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('❌ [CHATBOT-RESPONSE] Response status:', error.response.status);
        console.error('❌ [CHATBOT-RESPONSE] Response data:', error.response.data);
      } else {
        console.error('❌ [CHATBOT-RESPONSE] Error message:', error.message);
      }
    } else if (error instanceof Error) {
      console.error('❌ [CHATBOT-RESPONSE] Error message:', error.message);
    } else {
      console.error('❌ [CHATBOT-RESPONSE] Unknown error:', error);
    }
  }
}

/**
 * Send an automatic fallback response when Edge Function fails
 * @param phoneNumberId The phone number ID to use for sending
 * @param to The recipient's phone number
 * @param originalMessage The original user message
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
    
    // This function is now only for fallback messages when Edge Function fails
    let responseMessage = '';
    console.log(`📤 [FALLBACK] Using fallback message for chatbot type: ${chatbotType}`);
    
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
    
    console.log(`✅ [FALLBACK] WhatsApp fallback message sent successfully: ${response.status}`);
    console.log(`📱 [FALLBACK] Fallback message sent to ${to}: "${responseMessage.substring(0, 50)}..."`);
  } catch (error) {
    console.error(`❌ [FALLBACK] Error sending WhatsApp fallback message:`);
    
    if (axios.isAxiosError(error)) {
      if (error.response) {
        console.error('❌ [FALLBACK] Response status:', error.response.status);
        console.error('❌ [FALLBACK] Response data:', error.response.data);
      } else {
        console.error('❌ [FALLBACK] Error message:', error.message);
      }
    } else if (error instanceof Error) {
      console.error('❌ [FALLBACK] Error message:', error.message);
    } else {
      console.error('❌ [FALLBACK] Unknown error:', error);
    }
  }
}

/**
 * Endpoint to fetch templates from Meta API
 * This allows the main application to retrieve templates through the webhook
 */
app.get('/templates/:businessAccountId', async (req: Request, res: Response) => {
  try {
    const { businessAccountId } = req.params;
    // Use the authorization header from the request or fall back to the environment variable
    let accessToken = req.headers.authorization?.split(' ')[1];
    
    // If no token in header, use the one from environment variables
    if (!accessToken) {
      accessToken = process.env.META_ACCESS_TOKEN;
    }
    
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
    console.error('Error fetching templates:');
    
    if (axios.isAxiosError(error)) {
      if (error.response) {
        // Log the error details
        console.error('Response status:', error.response.status);
        console.error('Response data:', error.response.data);
        
        // Return appropriate error response
        console.error('Response data:', error.response.data);
        console.error('Response status:', error.response.status);
        const status = error.response.status || 500;
        const errorData = error.response?.data || { error: 'Error fetching templates' };
        return res.status(status).json({ error: errorData });
      }
      return res.status(500).json({ error: String(error) || 'Error fetching templates' });
    } else {
      const status = 500;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return res.status(status).json({ error: errorMessage || 'Error fetching templates' });
    }
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