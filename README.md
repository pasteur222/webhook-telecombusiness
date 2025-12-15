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

## Deployment on Render

1. Create a new Web Service on Render
2. Connect your repository
3. Configure the service:
   - Build Command: `npm install && npm run build`
   - Start Command: `npm start`
4. Add environment variables:
   - `VERIFY_TOKEN`: Your verification token for WhatsApp
   - `BOLT_WEBHOOK_ENDPOINT`: Your main application's base URL
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

## Message Routing

The webhook analyzes message content to determine which chatbot should handle it:

1. **Client Support Chatbot**: Default option, handles general inquiries and support requests
2. **Education Chatbot**: Handles learning-related messages and media (images, documents)
3. **Quiz Chatbot**: Handles quiz-related messages and game interactions

## Status Updates

The webhook forwards message status updates to your main application:
- Sent
- Delivered
- Read
- Failed

This allows your application to track message delivery and take appropriate actions.

## Customization

You can customize the trigger keywords for each chatbot type by modifying the `TRIGGER_KEYWORDS` object in `webhook.ts`.

## License

ISC