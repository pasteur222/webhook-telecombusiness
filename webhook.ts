import express from 'express';
import bodyParser from 'body-parser';
import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BOLT_WEBHOOK_ENDPOINT = process.env.BOLT_WEBHOOK_ENDPOINT;
const META_ACCESS_TOKEN = process.env.META_ACCESS_TOKEN;
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID;

// Middleware
app.use(bodyParser.json());

// Standard fallback message for when Edge Function forwarding fails
const FALLBACK_MESSAGE = " Merci pour votre message concernant le service client. Votre demande a été reçue et sera traitée par notre équipe. Nous reviendrons vers vous sous peu.";

// Type definitions for better error handling
interface WhatsAppMessage {
  id: string;
  from: string;
  timestamp: string;
  text?: {
    body: string;
  };
  type: string;
}

interface WhatsAppStatus {
  id: string;
  status: string;
  timestamp: string;
  recipient_id: string;
}

interface EdgeFunctionPayload {
  phoneNumber: string;
  webUserId?: string;
  sessionId?: string;
  source: "whatsapp";
  text: string;
  chatbotType: "client";
  userAgent?: string;
  timestamp: string;
}

interface StatusUpdatePayload {
  messageId: string;
  status: string;
  timestamp: string;
  recipientId: string;
}

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
      const statuses: WhatsAppStatus[] = body.entry[0].changes[0].value.statuses;
      
      // Forward status updates to Edge Function status handler
      try {
        for (const status of statuses) {
          const statusPayload: StatusUpdatePayload = {
            messageId: status.id,
            status: status.status,
            timestamp: status.timestamp,
            recipientId: status.recipient_id
          };

          await axios.post(`${BOLT_WEBHOOK_ENDPOINT}/functions/v1/status-handler`, statusPayload, {
            timeout: 10000,
            headers: {
                
              'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY || ''}`
            }
          });
        }
        console.log('✅ [WEBHOOK] Status updates forwarded successfully');
      } catch (statusError) {
        // ✅ FIX: Proper error type narrowing for TS18046
        const errorMessage = statusError instanceof Error 
          ? statusError.message 
          : statusError instanceof AxiosError 
            ? statusError.response?.data?.message || statusError.message
            : 'Unknown status forwarding error';
        
        console.error('❌ [WEBHOOK] Error forwarding status updates:', errorMessage);
      }
      
      res.sendStatus(200);
      return;
    }

    // Handle incoming messages
    if (body.entry?.[0]?.changes?.[0]?.value?.messages) {
      const messages: WhatsAppMessage[] = body.entry[0].changes[0].value.messages;
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
    // ✅ FIX: Proper error type narrowing for TS18046
    const errorMessage = error instanceof Error ? error.message : 'Unknown webhook processing error';
    console.error('❌ [WEBHOOK] Error processing webhook:', errorMessage);
    res.sendStatus(500);
  }
});

// Process individual incoming message
async function processIncomingMessage(message: WhatsAppMessage, contacts: any[]): Promise<void> {
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

    // ✅ FIX: Always use correct payload structure with required fields
    const edgeFunctionPayload: EdgeFunctionPayload = {
      phoneNumber: phoneNumber,
      webUserId: undefined,
      sessionId: undefined,
      source: "whatsapp",  // ✅ CRITICAL: Always whatsapp for WhatsApp messages
      text: messageText,
      chatbotType: "client", // ✅ FIXED: Use "client" for customer service
      userAgent: undefined,
      timestamp: timestamp
    };

    // Log the final payload being sent to Edge Function
    console.log('📤 [WEBHOOK] Forwarding to Edge Function with payload:', {
      phoneNumber: edgeFunctionPayload.phoneNumber,
      text: `${edgeFunctionPayload.text.substring(0, 50)}...`,
      chatbotType: edgeFunctionPayload.chatbotType,
      source: edgeFunctionPayload.source,
      textLength: edgeFunctionPayload.text.length,
      timestamp: edgeFunctionPayload.timestamp
    });

    // Forward to Edge Function with timeout and retry logic
    let edgeFunctionSuccess = false;
    let edgeFunctionResponse: any = null;
    
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
        
        // ✅ NEW: Extract and send the bot's response to WhatsApp
        if (edgeFunctionResponse.response && edgeFunctionResponse.response.trim()) {
          console.log('📤 [WEBHOOK] Sending Edge Function response to WhatsApp:', {
            phoneNumber: phoneNumber,
            responseLength: edgeFunctionResponse.response.length,
            messageId: messageId
          });
          
          await sendBotResponseToWhatsApp(phoneNumber, edgeFunctionResponse.response, messageId);
        } else {
          console.warn('⚠️ [WEBHOOK] Edge Function succeeded but returned no response content');
        }
        
        edgeFunctionSuccess = true;
      } else {
        console.error('❌ [WEBHOOK] Edge Function returned error:', {
          status: response.status,
          responseData: edgeFunctionResponse
        });
        throw new Error(`Edge Function error: ${JSON.stringify(edgeFunctionResponse)}`);
      }

    } catch (forwardError) {
      // ✅ FIX: Proper error type narrowing for TS18046
      let errorDetails: {
        message: string;
        phoneNumber: string;
        messageId: string;
        status?: number;
        statusText?: string;
        responseData?: any;
      } = {
        message: 'Unknown forwarding error',
        phoneNumber: phoneNumber,
        messageId: messageId
      };

      if (forwardError instanceof AxiosError) {
        errorDetails.message = forwardError.message;
        errorDetails.status = forwardError.response?.status;
        errorDetails.statusText = forwardError.response?.statusText;
        errorDetails.responseData = forwardError.response?.data;
      } else if (forwardError instanceof Error) {
        errorDetails.message = forwardError.message;
      }

      console.error('❌ [WEBHOOK] Failed to forward to Edge Function:', errorDetails);
      
      edgeFunctionSuccess = false;
    }

    // If Edge Function forwarding failed, send fallback message directly
    if (!edgeFunctionSuccess) {
      console.log('🔄 [WEBHOOK] Edge Function failed, sending fallback message');
      await sendFallbackMessage(phoneNumber, messageId);
    }

  } catch (error) {
    // ✅ FIX: Proper error type narrowing for TS18046
    const errorMessage = error instanceof Error ? error.message : 'Unknown message processing error';
    console.error('❌ [WEBHOOK] Error processing individual message:', errorMessage);
    
    // Send fallback message even if processing fails
    try {
      await sendFallbackMessage(message.from, message.id);
    } catch (fallbackError) {
      const fallbackErrorMessage = fallbackError instanceof Error 
        ? fallbackError.message 
        : 'Unknown fallback error';
      console.error('❌ [WEBHOOK] Failed to send fallback message:', fallbackErrorMessage);
    }
  }
}

// ✅ NEW: Function to send bot response to WhatsApp
async function sendBotResponseToWhatsApp(phoneNumber: string, botMessage: string, originalMessageId: string): Promise<void> {
  try {
    console.log('📤 [WEBHOOK] Sending bot response to WhatsApp:', {
      phoneNumber,
      messageLength: botMessage.length
    });
    
    // Check if WhatsApp API credentials are configured
    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
      console.error('❌ [WEBHOOK] WhatsApp API credentials not configured for bot response');
      console.log('💬 [WEBHOOK] Bot response content (not sent):', botMessage.substring(0, 100) + '...');
      return;
    }
    
    // Validate and sanitize the bot message
    let sanitizedMessage = botMessage.trim();
    if (sanitizedMessage.length === 0) {
      console.error('❌ [WEBHOOK] Bot message is empty after sanitization');
      return;
    }
    
    // Ensure message doesn't exceed WhatsApp's 4096 character limit
    if (sanitizedMessage.length > 4096) {
      console.warn('⚠️ [WEBHOOK] Bot message too long, truncating');
      sanitizedMessage = sanitizedMessage.substring(0, 4093) + '...';
    }
    
    // Send bot response via WhatsApp API
    const whatsappResponse = await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'text',
        text: { body: sanitizedMessage }
      },
      {
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    if (whatsappResponse.status === 200) {
      const responseMessageId = whatsappResponse.data.messages?.[0]?.id;
      console.log('✅ [WEBHOOK] Bot response sent successfully to WhatsApp:', {
        phoneNumber,
        originalMessageId,
        responseMessageId,
        messageLength: sanitizedMessage.length
      });
    } else {
      throw new Error(`WhatsApp API returned status ${whatsappResponse.status}`);
    }
    
  } catch (error) {
    // ✅ FIX: Proper error type narrowing for TS18046
    const errorMessage = error instanceof Error 
      ? error.message 
      : error instanceof AxiosError 
        ? error.response?.data?.error?.message || error.message
        : 'Unknown bot response error';
    
    console.error('❌ [WEBHOOK] Error sending bot response to WhatsApp:', {
      phoneNumber,
      originalMessageId,
      error: errorMessage,
      botMessageLength: botMessage.length
    });
    
    // Don't throw here - we don't want to trigger fallback message
    // The Edge Function already processed successfully, just the WhatsApp send failed
  }
}

// Send fallback message when Edge Function fails
async function sendFallbackMessage(phoneNumber: string, originalMessageId: string): Promise<void> {
  try {
    console.log('📤 [WEBHOOK] Sending fallback message to:', phoneNumber);
    
    // Check if WhatsApp API credentials are configured
    if (!META_ACCESS_TOKEN || !META_PHONE_NUMBER_ID) {
      console.error('❌ [WEBHOOK] WhatsApp API credentials not configured for fallback');
      console.log('💬 [WEBHOOK] Fallback message content (not sent):', FALLBACK_MESSAGE);
      return;
    }
    
    // Send fallback message via WhatsApp API
    const whatsappResponse = await axios.post(
      `https://graph.facebook.com/v18.0/${META_PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to: phoneNumber,
        type: 'text',
        text: { body: FALLBACK_MESSAGE }
      },
      {
        headers: {
          'Authorization': `Bearer ${META_ACCESS_TOKEN}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    
    if (whatsappResponse.status === 200) {
      const messageId = whatsappResponse.data.messages?.[0]?.id;
      console.log('✅ [WEBHOOK] Fallback message sent successfully:', { phoneNumber, messageId });
    } else {
      throw new Error(`WhatsApp API returned status ${whatsappResponse.status}`);
    }
    
  } catch (error) {
    // ✅ FIX: Proper error type narrowing for TS18046
    const errorMessage = error instanceof Error 
      ? error.message 
      : error instanceof AxiosError 
        ? error.response?.data?.error?.message || error.message
        : 'Unknown fallback error';
    console.error('❌ [WEBHOOK] Error sending fallback message:', errorMessage);
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
    
    // ✅ FIX: Ensure businessAccountId is a string for TS2345
    const accountId = String(businessAccountId);
    
    // Fetch templates from Meta API
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${accountId}/message_templates`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`
        },
        timeout: 10000
      }
    );
    
    res.json(response.data);
    
  } catch (error) {
    // ✅ FIX: Proper error type narrowing for TS18046
    let errorMessage = 'Unknown template fetch error';
    let errorDetails = '';

    if (error instanceof AxiosError) {
      errorMessage = error.message;
      errorDetails = error.response?.data?.message || error.response?.statusText || '';
    } else if (error instanceof Error) {
      errorMessage = error.message;
    }

    console.error('Error fetching templates:', errorMessage);
    res.status(500).json({ 
      error: 'Failed to fetch templates',
      details: errorDetails
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