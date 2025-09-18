# WhatsApp Webhook for Multi-Tenant SaaS

This webhook serves as a bridge between the WhatsApp Business API and your SaaS application. It receives messages from WhatsApp, analyzes their content, and forwards them to the appropriate chatbot endpoint in your main application.

## Features

- Handles webhook verification for WhatsApp Business API
- Processes incoming text and media messages
- Tracks message delivery status updates (delivered, read, failed)
- Analyzes message content to determine the appropriate chatbot (client support, education, or quiz)
- Forwards messages to the corresponding endpoint in your main application
- Provides an endpoint to fetch WhatsApp message templates
- Supports multi-tenant architecture with phone_number_id identification
- TypeScript support with strict error handling
- Comprehensive test suite for validation

## Setup

1. Clone this repository
2. Install dependencies:
   ```
   npm install
   ```
3. Create a `.env` file based on `.env.example`:
   ```
   cp .env.example .env
   ```
4. Edit the `.env` file with your configuration:
   ```
   VERIFY_TOKEN=your_verification_token_here
   BOLT_WEBHOOK_ENDPOINT=https://your-bolt-app.com
   SUPABASE_ANON_KEY=your_supabase_anon_key
   PORT=3000
   ```
5. Build the TypeScript code:
   ```
   npm run build
   ```
6. Start the server:
   ```
   npm start
   ```

## Testing

Run the test suite to validate webhook functionality:

```bash
# Start the webhook server in one terminal
npm run dev

# Run tests in another terminal
node test-webhook.js
```

The test suite validates:
- Health endpoint functionality
- Message processing and forwarding
- Status update handling
- Direct Edge Function communication

## Deployment on Render

1. Create a new Web Service on Render
2. Connect your repository
3. Configure the service:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
4. Add environment variables:
   - `VERIFY_TOKEN`: Your verification token for WhatsApp
   - `BOLT_WEBHOOK_ENDPOINT`: Your main application's base URL
   - `SUPABASE_ANON_KEY`: Your Supabase anonymous key
   - `PORT`: Port for the webhook server (Render will set this automatically)

## WhatsApp Business API Configuration

1. Go to your Meta for Developers dashboard
2. Navigate to your WhatsApp Business API app
3. Set up a webhook with the following:
   - Callback URL: `https://your-render-app.onrender.com/webhook`
   - Verify Token: The same value as your `VERIFY_TOKEN` environment variable
   - Subscribe to the following fields:
     - `messages` (for receiving messages)
     - `message_status_updates` (for delivery status updates)

## API Endpoints

### Webhook Verification
- **GET /webhook**: Used by Meta to verify your webhook

### Message Reception
- **POST /webhook**: Receives messages and status updates from WhatsApp

### Template Management
- **GET /templates/:businessAccountId**: Fetches message templates from Meta API
  - Requires Authorization header with Bearer token
  - Returns templates for the specified WhatsApp Business Account ID

### Health Check
- **GET /health**: Returns server health status and version information

## Message Routing

The webhook analyzes message content to determine which chatbot should handle it:

1. **Client Support Chatbot**: Default option, handles general inquiries and support requests
2. **Quiz Chatbot**: Handles quiz-related messages and game interactions

## Payload Structure

Messages forwarded to the Edge Function include:

```json
{
  "phoneNumber": "+221123456789",
  "source": "whatsapp",
  "text": "User message content",
  "chatbotType": "client",
  "timestamp": "1234567890"
}
```

Status updates are sent to the status handler:

```json
{
  "messageId": "wamid.xxx",
  "status": "delivered",
  "timestamp": "1234567890",
  "recipientId": "+221123456789"
}
```
## Status Updates

The webhook forwards message status updates to your main application:
- Sent
- Delivered
- Read
- Failed

This allows your application to track message delivery and take appropriate actions.

## Error Handling

The webhook implements comprehensive error handling:
- TypeScript strict mode for compile-time safety
- Proper error type narrowing for runtime safety
- Fallback responses when Edge Function fails
- Detailed logging for debugging
- Graceful degradation for non-critical failures

## Customization

The webhook automatically routes messages to the appropriate chatbot based on:
- Message content analysis
- Active quiz sessions
- Default routing to customer service

## Troubleshooting

Common issues and solutions:

1. **TypeScript build errors**: Ensure all dependencies are installed and TypeScript is configured correctly
2. **Edge Function forwarding fails**: Check BOLT_WEBHOOK_ENDPOINT and SUPABASE_ANON_KEY environment variables
3. **Status updates cause errors**: Verify that status updates are properly filtered and don't include text field
4. **Template fetching fails**: Ensure WhatsApp Business Account ID is correct and access token is valid

## License

ISC