import express from 'express';
import bodyParser from 'body-parser';
import axios from 'axios';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Environment variables
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || 'your_verification_token_here';
const BOLT_WEBHOOK_ENDPOINT = process.env.BOLT_WEBHOOK_ENDPOINT || 'https://your-bolt-app.com';

// Logging utility
function logInfo(message: string, data?: any) {
  console.log(`[WEBHOOK] ${message}`, data ? JSON.stringify(data, null, 2) : '');
}

function logError(message: string, error?: any) {
  console.error(`[WEBHOOK] ERROR: ${message}`, error);
}

// Webhook verification endpoint
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logInfo('Webhook verification request received', { mode, token });

  if (mode && token) {
    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      logInfo('Webhook verified successfully');
      res.status(200).send(challenge);
    } else {
      logError('Webhook verification failed - invalid token');
      res.sendStatus(403);
    }
  } else {
    logError('Webhook verification failed - missing parameters');
    res.sendStatus(400);
  }
});

// Webhook message handler
app.post('/webhook', async (req, res) => {
  try {
    logInfo('Webhook POST request received');
    
    const body = req.body;
    
    if (!body.entry || !Array.isArray(body.entry)) {
      logError('Invalid webhook payload - missing entry array');
      return res.sendStatus(400);
    }

    // Process each entry
    for (const entry of body.entry) {
      if (entry.changes) {
        for (const change of entry.changes) {
          if (change.field === 'messages') {
            await processMessages(change.value);
          } else if (change.field === 'message_status_updates') {
            await processStatusUpdates(change.value);
          }
        }
      }
    }

    res.sendStatus(200);
  } catch (error) {
    // Fix TypeScript error: Type assertion for error handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const errorStack = error instanceof Error ? error.stack : undefined;
    
    logError('Webhook processing failed', {
      message: errorMessage,
      stack: errorStack
    });
    res.sendStatus(500);
  }
});

// Process incoming messages
async function processMessages(messageData: any) {
  try {
    logInfo('Processing messages', { messageCount: messageData.messages?.length || 0 });

    if (!messageData.messages || !Array.isArray(messageData.messages)) {
      logInfo('No messages to process');
      return;
    }

    for (const message of messageData.messages) {
      await processMessage(message, messageData.metadata?.phone_number_id);
    }
  } catch (error) {
    // Fix TypeScript error: Type assertion for error handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logError('Error processing messages', { error: errorMessage });
  }
}

// Process status updates
async function processStatusUpdates(statusData: any) {
  try {
    logInfo('Processing status updates', { statusCount: statusData.statuses?.length || 0 });

    if (!statusData.statuses || !Array.isArray(statusData.statuses)) {
      logInfo('No status updates to process');
      return;
    }

    for (const status of statusData.statuses) {
      try {
        // Forward status update to Bolt app
        await axios.post(`${BOLT_WEBHOOK_ENDPOINT}/api/webhook/status`, {
          messageId: status.id,
          status: status.status,
          timestamp: status.timestamp,
          recipientId: status.recipient_id
        }, {
          timeout: 10000,
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'WhatsApp-Webhook/1.0'
          }
        });

        logInfo('Status update forwarded successfully', {
          messageId: status.id,
          status: status.status
        });
      } catch (statusError) {
        // Fix TypeScript error: Type assertion for status error handling
        const errorMessage = statusError instanceof Error ? statusError.message : 'Unknown status error';
        const isAxiosError = axios.isAxiosError(statusError);
        const statusCode = isAxiosError ? statusError.response?.status : undefined;
        const responseData = isAxiosError ? statusError.response?.data : undefined;
        
        logError('Failed to forward status update', {
          messageId: status.id,
          error: errorMessage,
          statusCode,
          responseData
        });
      }
    }
  } catch (error) {
    // Fix TypeScript error: Type assertion for error handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logError('Error processing status updates', { error: errorMessage });
  }
}

// Process individual message
async function processMessage(message: any, phoneNumberId: string) {
  try {
    logInfo('Processing individual message', {
      messageId: message.id,
      from: message.from,
      type: message.type
    });

    // Determine chatbot type based on message content
    const chatbotType = determineChatbotType(message);
    
    // Prepare message data for forwarding
    const messagePayload = {
      messageId: message.id,
      from: message.from,
      timestamp: message.timestamp,
      type: message.type,
      phoneNumberId: phoneNumberId,
      chatbotType: chatbotType,
      content: extractMessageContent(message)
    };

    // Forward to appropriate Bolt app endpoint
    const endpoint = `${BOLT_WEBHOOK_ENDPOINT}/api/webhook/${chatbotType}`;
    
    try {
      const response = await axios.post(endpoint, messagePayload, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'WhatsApp-Webhook/1.0'
        }
      });

      logInfo('Message forwarded successfully', {
        messageId: message.id,
        chatbotType,
        endpoint,
        responseStatus: response.status
      });
    } catch (forwardError) {
      // Fix TypeScript error: Type assertion for forward error handling
      const errorMessage = forwardError instanceof Error ? forwardError.message : 'Unknown forward error';
      const isAxiosError = axios.isAxiosError(forwardError);
      const statusCode = isAxiosError ? forwardError.response?.status : undefined;
      const responseData = isAxiosError ? forwardError.response?.data : undefined;
      const requestConfig = isAxiosError ? {
        url: forwardError.config?.url,
        method: forwardError.config?.method,
        timeout: forwardError.config?.timeout
      } : undefined;
      
      logError('Failed to forward message to Bolt app', {
        messageId: message.id,
        endpoint,
        error: errorMessage,
        statusCode,
        responseData,
        requestConfig
      });

      // Try fallback processing
      await processFallbackMessage(message, chatbotType);
    }
  } catch (error) {
    // Fix TypeScript error: Type assertion for error handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logError('Error processing individual message', {
      messageId: message.id,
      error: errorMessage
    });
  }
}

// Determine chatbot type based on message content
function determineChatbotType(message: any): string {
  const content = extractMessageContent(message);
  const lowerContent = content.toLowerCase();

  // Quiz keywords
  const quizKeywords = ['quiz', 'game', 'test', 'play', 'challenge', 'jeu', 'défi'];
  if (quizKeywords.some(keyword => lowerContent.includes(keyword))) {
    return 'quiz';
  }

  // Education keywords
  const educationKeywords = ['learn', 'study', 'homework', 'apprendre', 'étudier', 'devoirs'];
  if (educationKeywords.some(keyword => lowerContent.includes(keyword))) {
    return 'education';
  }

  // Default to customer service
  return 'customer-service';
}

// Extract message content based on message type
function extractMessageContent(message: any): string {
  switch (message.type) {
    case 'text':
      return message.text?.body || '';
    case 'image':
      return message.image?.caption || '[Image]';
    case 'video':
      return message.video?.caption || '[Video]';
    case 'document':
      return message.document?.caption || '[Document]';
    case 'audio':
      return '[Audio]';
    default:
      return '[Unknown message type]';
  }
}

// Fallback message processing
async function processFallbackMessage(message: any, chatbotType: string) {
  try {
    logInfo('Processing fallback message', {
      messageId: message.id,
      chatbotType
    });

    // Simple fallback response based on chatbot type
    let fallbackResponse = '';
    
    switch (chatbotType) {
      case 'quiz':
        fallbackResponse = 'Bienvenue au quiz! Votre message a été reçu et sera traité bientôt.';
        break;
      case 'education':
        fallbackResponse = 'Bonjour! Votre question éducative a été reçue et sera traitée par notre équipe.';
        break;
      default:
        fallbackResponse = 'Merci pour votre message. Notre équipe vous répondra dans les plus brefs délais.';
    }

    // Log the fallback response (in a real implementation, you might send this back via WhatsApp API)
    logInfo('Fallback response generated', {
      messageId: message.id,
      response: fallbackResponse
    });
  } catch (error) {
    // Fix TypeScript error: Type assertion for error handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    logError('Error in fallback message processing', {
      messageId: message.id,
      error: errorMessage
    });
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

    logInfo('Fetching templates', { businessAccountId });

    // Fetch templates from Meta API
    const response = await axios.get(
      `https://graph.facebook.com/v19.0/${businessAccountId}/message_templates`,
      {
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    logInfo('Templates fetched successfully', {
      businessAccountId,
      templateCount: response.data.data?.length || 0
    });

    res.json(response.data);
  } catch (error) {
    // Fix TypeScript error: Type assertion for error handling
    const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
    const isAxiosError = axios.isAxiosError(error);
    const statusCode = isAxiosError ? error.response?.status : 500;
    const responseData = isAxiosError ? error.response?.data : undefined;
    
    logError('Error fetching templates', {
      businessAccountId: req.params.businessAccountId,
      error: errorMessage,
      statusCode,
      responseData
    });

    res.status(statusCode).json({
      error: 'Failed to fetch templates',
      details: errorMessage
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
  logInfo(`Webhook server running on port ${PORT}`);
  logInfo('Environment configuration', {
    hasVerifyToken: !!VERIFY_TOKEN,
    hasBoltEndpoint: !!BOLT_WEBHOOK_ENDPOINT,
    port: PORT
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logInfo('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logInfo('SIGINT received, shutting down gracefully');
  process.exit(0);
});