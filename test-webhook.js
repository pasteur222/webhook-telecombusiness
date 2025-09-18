// Test script to validate webhook functionality
const axios = require('axios');

const WEBHOOK_URL = 'http://localhost:3000/webhook';
const EDGE_FUNCTION_URL = process.env.BOLT_WEBHOOK_ENDPOINT + '/functions/v1/api-chatbot';

// Test data
const testMessage = {
  entry: [{
    changes: [{
      value: {
        messages: [{
          id: 'test_message_' + Date.now(),
          from: '+221123456789',
          timestamp: Date.now().toString(),
          text: {
            body: 'Hello, this is a test message'
          },
          type: 'text'
        }]
      }
    }]
  }]
};

const testStatusUpdate = {
  entry: [{
    changes: [{
      value: {
        statuses: [{
          id: 'test_status_' + Date.now(),
          status: 'delivered',
          timestamp: Date.now().toString(),
          recipient_id: '+221123456789'
        }]
      }
    }]
  }]
};

async function testWebhook() {
  console.log('🧪 [TEST] Starting webhook tests...');
  
  try {
    // Test 1: Health check
    console.log('\n1. Testing health endpoint...');
    const healthResponse = await axios.get('http://localhost:3000/health');
    console.log('✅ Health check passed:', healthResponse.data);
    
    // Test 2: Message processing
    console.log('\n2. Testing message processing...');
    const messageResponse = await axios.post(WEBHOOK_URL, testMessage);
    console.log('✅ Message processing passed:', messageResponse.status);
    
    // Test 3: Status update processing
    console.log('\n3. Testing status update processing...');
    const statusResponse = await axios.post(WEBHOOK_URL, testStatusUpdate);
    console.log('✅ Status update processing passed:', statusResponse.status);
    
    // Test 4: Direct Edge Function test
    console.log('\n4. Testing Edge Function directly...');
    const edgeResponse = await axios.post(EDGE_FUNCTION_URL, {
      phoneNumber: '+221123456789',
      source: 'whatsapp',
      text: 'Test direct edge function call',
      chatbotType: 'client',
      timestamp: Date.now().toString()
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        'Content-Type': 'application/json'
      }
    });
    console.log('✅ Edge Function test passed:', edgeResponse.data);
    
    console.log('\n🎉 All tests passed successfully!');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Run tests if this file is executed directly
if (require.main === module) {
  testWebhook();
}

module.exports = { testWebhook };