import express from 'express';
import bodyParser from 'body-parser';
import axios, { AxiosError } from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// ✅ MINIMAL AUTONOMOUS WEBHOOK - Only static environment variables needed
// All user-specific credentials (access_token, phone_number_id, Groq key) are retrieved dynamically by Edge Function
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const BOLT_WEBHOOK_ENDPOINT = process.env.BOLT_WEBHOOK_ENDPOINT;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// Middleware
app.use(bodyParser.json());

// Type definitions
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
  phoneNumberId?: string; // WhatsApp Business Phone Number ID (for user identification)
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
              'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
              'Content-Type': 'application/json'
            }
          });
        }
        console.log('✅ [WEBHOOK] Status updates forwarded successfully');
      } catch (statusError) {
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

      // ✅ CRITICAL: Extract phone_number_id from metadata (identifies which business account received message)
      const phoneNumberId = body.entry[0].changes[0].value.metadata?.phone_number_id;

      if (!phoneNumberId) {
        console.error('❌ [WEBHOOK] CRITICAL: phone_number_id not found in webhook metadata');
        res.sendStatus(200); // Still acknowledge to prevent retries
        return;
      }

      console.log('📞 [WEBHOOK] WhatsApp Business Phone Number ID:', phoneNumberId);

      for (const message of messages) {
        await processIncomingMessage(message, contacts, phoneNumberId);
      }

      res.sendStatus(200);
      return;
    }

    // If no messages or statuses, just acknowledge
    console.log('ℹ️ [WEBHOOK] Received webhook with no messages or statuses');
    res.sendStatus(200);

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown webhook processing error';
    console.error('❌ [WEBHOOK] Error processing webhook:', errorMessage);
    res.sendStatus(500);
  }
});

// Process individual incoming message - MINIMAL FORWARDER
async function processIncomingMessage(message: WhatsAppMessage, contacts: any[], phoneNumberId: string): Promise<void> {
  try {
    // Extract message details
    const phoneNumber = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;

    // Only process text messages
    if (!message.text?.body) {
      console.log('ℹ️ [WEBHOOK] Skipping non-text message:', messageId);
      return;
    }

    const messageText = message.text.body;

    console.log('📨 [WEBHOOK] Processing incoming message:', {
      from: phoneNumber,
      messageId: messageId,
      phoneNumberId: phoneNumberId,
      textLength: messageText.length
    });

    // Create payload for Edge Function
    const edgeFunctionPayload: EdgeFunctionPayload = {
      phoneNumber: phoneNumber,
      phoneNumberId: phoneNumberId, // ✅ CRITICAL: For user identification in Edge Function
      webUserId: undefined,
      sessionId: undefined,
      source: "whatsapp",
      text: messageText,
      chatbotType: "client",
      userAgent: undefined,
      timestamp: timestamp
    };

    // Log the payload being forwarded
    console.log('📤 [WEBHOOK] Forwarding to Edge Function:', {
      phoneNumber: edgeFunctionPayload.phoneNumber,
      phoneNumberId: edgeFunctionPayload.phoneNumberId,
      text: `${edgeFunctionPayload.text.substring(0, 50)}...`,
      textLength: edgeFunctionPayload.text.length
    });

    // ✅ AUTONOMOUS: Forward to Edge Function - it handles EVERYTHING
    // - User identification via phone_number_id
    // - Retrieve user's Groq API key
    // - Retrieve user's WhatsApp credentials
    // - Generate AI response
    // - Send response to WhatsApp
    // - Log to database
    try {
      const response = await axios.post(
        `${BOLT_WEBHOOK_ENDPOINT}/functions/v1/api-chatbot`,
        edgeFunctionPayload,
        {
          timeout: 30000, // 30 second timeout
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPABASE_ANON_KEY}`
          }
        }
      );

      if (response.status === 200 && response.data?.success) {
        console.log('✅ [WEBHOOK] Edge Function processed and sent message successfully');
      } else {
        console.error('❌ [WEBHOOK] Edge Function returned error:', {
          status: response.status,
          responseData: response.data
        });
      }
    } catch (forwardError) {
      // Log detailed error information
      let errorDetails: {
        message: string;
        phoneNumber: string;
        messageId: string;
        phoneNumberId: string;
        status?: number;
        statusText?: string;
        responseData?: any;
      } = {
        message: 'Unknown forwarding error',
        phoneNumber: phoneNumber,
        messageId: messageId,
        phoneNumberId: phoneNumberId
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

      // ✅ AUTONOMOUS: Edge Function handles errors and fallback messages
      // Webhook doesn't need to send fallback - Edge Function owns the WhatsApp credentials
    }

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown message processing error';
    console.error('❌ [WEBHOOK] Error processing individual message:', errorMessage);
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
    version: '2.0.0-autonomous',
    config: {
      hasVerifyToken: !!VERIFY_TOKEN,
      hasBoltEndpoint: !!BOLT_WEBHOOK_ENDPOINT,
      hasSupabaseKey: !!SUPABASE_ANON_KEY
    }
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 [WEBHOOK] Autonomous webhook server running on port ${PORT}`);
  console.log(`📋 [WEBHOOK] Configuration:`, {
    hasVerifyToken: !!VERIFY_TOKEN,
    hasBoltEndpoint: !!BOLT_WEBHOOK_ENDPOINT,
    hasSupabaseKey: !!SUPABASE_ANON_KEY,
    boltEndpoint: BOLT_WEBHOOK_ENDPOINT
  });
  console.log('✅ [WEBHOOK] Running in AUTONOMOUS mode - all user credentials retrieved dynamically by Edge Function');
});

export default app;
