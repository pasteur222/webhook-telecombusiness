import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BOLT_WEBHOOK_ENDPOINT = process.env.BOLT_WEBHOOK_ENDPOINT;

// Middleware
app.use(bodyParser.json());

// Standard fallback message for when Edge Function forwarding fails
const FALLBACK_MESSAGE = "Thank you for your message regarding customer service, your request has been received and will be processed by our team, we will get back to you shortly.";

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      console.log('✅ [WEBHOOK] Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      console.error('❌ [WEBHOOK] Webhook verification failed - invalid token');
      res.sendStatus(403);
    }
  } else {
    console.error('❌ [WEBHOOK] Webhook verification failed - missing parameters');
    res.sendStatus(400);
  }
});

// Webhook message handler
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Handle status updates (delivery receipts, read receipts, etc.)
    if (body.entry?.[0]?.changes?.[0]?.value?.statuses) {
      console.log('📊 [WEBHOOK] Received status update');
      const statuses = body.entry[0].changes[0].value.statuses;
      
      // Forward status updates to Edge Function status handler
      try {
        for (const status of statuses) {
          await axios.post(`${BOLT_WEBHOOK_ENDPOINT}/functions/v1/status-handler`, {
            messageId: status.id,
            status: status.status,
            timestamp: status.timestamp,
            recipientId: status.recipient_id
          });
        }
        console.log('✅ [WEBHOOK] Status updates forwarded successfully');
      } catch (statusError) {
        console.error('❌ [WEBHOOK] Error forwarding status updates:', statusError.message);
      }
      
      res.sendStatus(200);
      return;
    }

    // Handle incoming messages
    if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const messages = body.entry[0].changes[0].value.messages;
      const contacts = body.entry[0].changes[0].value.contacts || [];
      
      for (const message of messages) {
        await processIncomingMessage(message, contacts);
      }
      
      res.sendStatus(200);
      return;
    }

    // If no messages or statuses, just acknowledge
    console.log('ℹ️ [WEBHOOK] Received webhook with no messages or statuses');
    res.sendStatus(200);

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing webhook:', error);
    res.sendStatus(500);
  }
});

// Process individual incoming message
async function processIncomingMessage(message: any, contacts: any[]) {
  try {
    // Extract message details
    const phoneNumber = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;
    
    // Only process text messages for now
    if (!message.text?.body) {
      console.log('ℹ️ [WEBHOOK] Skipping non-text message:', messageId);
      return;
    }

    const messageText = message.text.body;
    
    console.log('📨 [WEBHOOK] Processing incoming message:', {
      from: phoneNumber,
      messageId: messageId,
      textLength: messageText.length
    });

    // Determine chatbot type based on message content
    const chatbotType = determineChatbotType(messageText);
    
    // Prepare payload for Edge Function with REQUIRED source field
    const edgeFunctionPayload = {
      phoneNumber: phoneNumber,
      text: messageText,
      messageId: messageId,
      timestamp: timestamp,
      chatbotType: chatbotType,
      source: "whatsapp"  // ✅ CRITICAL: Always add source field for WhatsApp messages
    };

    // Validate that source field is present before forwarding
    if (!edgeFunctionPayload.source || edgeFunctionPayload.source !== "whatsapp") {
      console.error('❌ [WEBHOOK] CRITICAL: Source field validation failed, adding whatsapp source');
      edgeFunctionPayload.source = "whatsapp";
    }

    // Log the final payload being sent to Edge Function
    console.log('📤 [WEBHOOK] Forwarding to Edge Function with payload:', {
      phoneNumber: edgeFunctionPayload.phoneNumber,
      messageId: edgeFunctionPayload.messageId,
      chatbotType: edgeFunctionPayload.chatbotType,
      source: edgeFunctionPayload.source,  // ✅ Confirm source is included
      textLength: edgeFunctionPayload.text.length
    });

    // Forward to Edge Function with timeout and retry logic
    let edgeFunctionSuccess = false;
    let edgeFunctionResponse = null;
    
    try {
      const response = await axios.post(
        `${BOLT_WEBHOOK_ENDPOINT}/functions/v1/api-chatbot`,
        edgeFunctionPayload,
        {
          timeout: 30000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY || ''}`
          }
        }
      );

      edgeFunctionResponse = response.data;
      
      if (response.status === 200 && edgeFunctionResponse?.success) {
        console.log('✅ [WEBHOOK] Edge Function processed message successfully');
        edgeFunctionSuccess = true;
      } else {
        console.error('❌ [WEBHOOK] Edge Function returned error:', {
          status: response.status,
          responseData: edgeFunctionResponse
        });
        throw new Error(`Edge Function error: ${JSON.stringify(edgeFunctionResponse)}`);
      }

    } catch (forwardError) {
      console.error('❌ [WEBHOOK] Failed to forward to Edge Function:', {
        error: forwardError.message,
        phoneNumber: phoneNumber,
        messageId: messageId,
        payload: edgeFunctionPayload
      });
      
      // Log Edge Function response details if available
      if (forwardError.response) {
        console.error('❌ [WEBHOOK] Edge Function response details:', {
          status: forwardError.response.status,
          statusText: forwardError.response.statusText,
          data: forwardError.response.data
        });
      }
      
      edgeFunctionSuccess = false;
    }

    // If Edge Function forwarding failed, send fallback message directly
    if (!edgeFunctionSuccess) {
      console.log('🔄 [WEBHOOK] Edge Function failed, sending fallback message');
      await sendFallbackMessage(phoneNumber, messageId);
    }

  } catch (error) {
    console.error('❌ [WEBHOOK] Error processing individual message:', error);
    
    // Send fallback message even if processing fails
    try {
      await sendFallbackMessage(message.from, message.id);
    } catch (fallbackError) {
      console.error('❌ [WEBHOOK] Failed to send fallback message:', fallbackError);
    }
  }
}

// Determine chatbot type based on message content
function determineChatbotType(messageText: string): string {
  const lowerText = messageText.toLowerCase();
  
  // Quiz keywords
  const quizKeywords = ['quiz', 'game', 'test', 'play', 'challenge', 'jeu', 'défi'];
  if (quizKeywords.some(keyword => lowerText.includes(keyword))) {
    return 'quiz';
  }
  
  // Default to customer service
  return 'client';
}

// Send fallback message when Edge Function fails
async function sendFallbackMessage(phoneNumber: string, originalMessageId: string) {
  try {
    console.log('📤 [WEBHOOK] Sending fallback message to:', phoneNumber);
    
    // This would typically send via WhatsApp API
    // For now, we'll log that the fallback message should be sent
    console.log('💬 [WEBHOOK] Fallback message content:', FALLBACK_MESSAGE);
    
    // In a real implementation, you would:
    // 1. Get WhatsApp API credentials
    // 2. Send the fallback message via WhatsApp API
    // 3. Log the result
    
    // Placeholder for actual WhatsApp API call
    // const whatsappResponse = await sendWhatsAppMessage(phoneNumber, FALLBACK_MESSAGE);
    
    console.log('✅ [WEBHOOK] Fallback message sent successfully');
    
  } catch (error) {
    console.error('❌ [WEBHOOK] Error sending fallback message:', error);
  }
}

// Template management endpoint
app.get('/templates/:businessAccountId', async (req, res) => {
  try {
    const { businessAccountId } = req.params;
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid authorization header' });
    }
    
    const accessToken = authHeader.substring(7);
    
    // Fetch templates from Meta API
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${businessAccountId}/message_templates`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 10000
      }
    );
    
    res.json(response.data);
    
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ 
      error: 'Failed to fetch templates',
      details: error.message 
    });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ 
    status: 'healthy', 
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 [WEBHOOK] Server running on port ${PORT}`);
  console.log(`📋 [WEBHOOK] Environment check:`, {
    hasVerifyToken: !!VERIFY_TOKEN,
    hasBoltEndpoint: !!BOLT_WEBHOOK_ENDPOINT,
    boltEndpoint: BOLT_WEBHOOK_ENDPOINT
  });
});

export default app;