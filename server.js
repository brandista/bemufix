require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const OpenAI = require('openai');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust Railway proxy (fixes rate-limit warning)
app.set('trust proxy', 1);

// Initialize OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(cors({
  origin: '*', // Allow all origins
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100 // limit each IP to 100 requests per windowMs
});
app.use('/api/', limiter);

// In-memory conversation storage (use Redis in production)
const conversations = new Map();

// BMW Knowledge Base
const BMW_KNOWLEDGE = {
  commonIssues: {
    'E46': ['Jäähdytysjärjestelmän viat', 'Ikkunannostinten ongelmat', 'Alatukivarren kiinnityspisteiden vauriot'],
    'E90': ['Jakohihnan venyminen', 'Korkean paineen polttoainepumppu (HPFP)', 'Vesipumpun ongelmat'],
    'E60': ['iDrive-järjestelmän ongelmat', 'Ilmajousituksen viat', 'Sähköisen seisontajarrun ongelmat'],
    'F30': ['Jakoketju', 'Turboahdin ongelmat', 'Anturiviat']
  },
  serviceIntervals: {
    oil: '15 000 km tai 1 vuosi',
    inspection: '30 000 km tai 2 vuotta',
    brakes: 'Tarkistus 20 000 km välein',
    coolant: '60 000 km tai 4 vuotta'
  },
  priceEstimates: {
    'oil_change': '€150-300',
    'brake_pads': '€400-800',
    'brake_discs': '€600-1200',
    'timing_chain': '€2000-4500',
    'water_pump': '€800-1500',
    'diagnostic': '€80-150'
  }
};

// Vehicle lookup using Playwright (WORKS ON MAC!)
async function lookupVehicle(registrationNumber) {
  const { chromium } = require('playwright');
  
  let browser = null;
  
  try {
    const cleanReg = registrationNumber.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    let formattedReg = cleanReg;
    if (cleanReg.length === 6 && /^[A-Z]{3}\d{3}$/.test(cleanReg)) {
      formattedReg = `${cleanReg.substring(0, 3)}-${cleanReg.substring(3)}`;
    }
    
    console.log('\n==============================================');
    console.log('🚗 VEHICLE LOOKUP WITH PLAYWRIGHT');
    console.log('==============================================');
    console.log(`Registration: ${registrationNumber} → ${formattedReg}`);
    console.log('Launching browser...');
    
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    
    // Set up response interceptor to capture API call
    let vehicleData = null;
    let captureCount = 0;
    
    page.on('response', async (response) => {
      const url = response.url();
      console.log(`📡 Response from: ${url}`);
      
      if (url.includes('/api/enqueue_vehicle') || url.includes('kolariautot.com')) {
        try {
          const contentType = response.headers()['content-type'] || '';
          
          if (contentType.includes('application/json')) {
            const data = await response.json();
            console.log(`✅ Captured JSON response #${++captureCount}`);
            console.log('Response keys:', Object.keys(data));
            
            // Store if it has useful data
            if (data.seoCarName || (data.chassis && data.chassis.manufacturer)) {
              vehicleData = data;
              console.log('💾 Stored vehicle data!');
            } else {
              console.log('⚠️ Response has no useful vehicle data');
            }
          }
        } catch (e) {
          console.log('⚠️ Could not parse response as JSON:', e.message);
        }
      }
    });
    
    console.log(`🌐 Navigating to: https://kolariautot.com`);
    
    try {
      await page.goto('https://kolariautot.com', {
        waitUntil: 'networkidle',
        timeout: 30000
      });
      console.log('✅ Page loaded');
    } catch (e) {
      console.log('⚠️ Navigation timeout, but continuing...', e.message);
    }
    
    // Wait for the form to be ready
    console.log('⏳ Waiting for form to load...');
    await page.waitForTimeout(2000);
    
    // Find and fill the VIN/registration input field
    console.log(`📝 Filling registration number: ${formattedReg}`);
    try {
      const input = await page.locator('#vin');
      await input.fill(formattedReg);
      console.log('✅ Input filled');
      
      // Wait a moment for React state update
      await page.waitForTimeout(500);
      
      // Click the search button
      const searchButton = await page.locator('button[type="button"] svg[data-testid="SearchIcon"]').locator('..');
      await searchButton.click();
      console.log('✅ Search button clicked');
    } catch (e) {
      console.log('⚠️ Could not fill form:', e.message);
      // Try Enter as fallback
      try {
        const input = await page.locator('#vin');
        await input.press('Enter');
        console.log('✅ Fallback: Enter pressed');
      } catch (e2) {
        console.log('⚠️ Fallback failed:', e2.message);
      }
    }
    
    // Wait for API calls after form submission
    console.log('⏳ Waiting for API response (10 seconds)...');
    await page.waitForTimeout(10000);
    
    console.log('⏳ Final check (3 seconds)...');
    await page.waitForTimeout(3000);
    
    await browser.close();
    browser = null;
    
    console.log('🔒 Browser closed');
    console.log(`📊 Total API responses captured: ${captureCount}`);
    
    // Parse the data
    const result = {
      registrationNumber: formattedReg,
      make: '',
      model: '',
      year: '',
      generation: '',
      vin: '',
      found: false
    };
    
    if (vehicleData) {
      console.log('🔍 Parsing vehicle data...');
      
      if (vehicleData.seoCarName) {
        console.log('   seoCarName:', vehicleData.seoCarName);
        
        // Example: "BMW X5 (F15, F85) M 50 d (2014)"
        const complexMatch = vehicleData.seoCarName.match(/^([A-Z]+)\s+(.+?)\s*\(([^)]+)\)\s*(.+?)\s*\((\d{4})\)/);
        if (complexMatch) {
          result.make = complexMatch[1];
          result.model = `${complexMatch[2]} ${complexMatch[4]}`.trim();
          result.year = complexMatch[5];
          result.generation = complexMatch[3];
          result.found = true;
          console.log('   ✅ Parsed complex pattern');
        } else {
          // Simpler pattern: "BMW X5 (2014)"
          const simpleMatch = vehicleData.seoCarName.match(/^([A-Z]+)\s+(.+?)\s*\((\d{4})\)/);
          if (simpleMatch) {
            result.make = simpleMatch[1];
            result.model = simpleMatch[2];
            result.year = simpleMatch[3];
            result.found = true;
            console.log('   ✅ Parsed simple pattern');
          }
        }
      }
      
      if (vehicleData.vin) {
        result.vin = vehicleData.vin;
        console.log('   VIN:', vehicleData.vin);
      }
      
      // Try chassis data as fallback
      if (!result.found && vehicleData.chassis) {
        const chassis = vehicleData.chassis;
        if (chassis.manufacturer || chassis.model) {
          result.make = chassis.manufacturer || '';
          result.model = chassis.model || '';
          result.year = chassis.model_year || '';
          result.found = !!(result.make || result.model);
          console.log('   ✅ Used chassis data');
        }
      }
    } else {
      console.log('❌ No vehicle data was captured');
      console.log('   This might mean:');
      console.log('   - The registration number is not in their database');
      console.log('   - The website structure has changed');
      console.log('   - Network/timing issues');
    }
    
    console.log('\n==============================================');
    console.log('🏁 VEHICLE LOOKUP RESULT:');
    console.log('==============================================');
    console.log(JSON.stringify(result, null, 2));
    console.log('==============================================\n');
    
    return result;
    
  } catch (error) {
    console.log('\n==============================================');
    console.log('❌ VEHICLE LOOKUP ERROR:');
    console.log('==============================================');
    console.log('Error:', error.message);
    console.log('Stack:', error.stack);
    console.log('==============================================\n');
    
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.log('Error closing browser:', e.message);
      }
    }
    
    return {
      registrationNumber,
      error: 'Vehicle lookup failed',
      found: false
    };
  }
}

// Enhanced vehicle lookup with fallback to mock data for demo
async function getVehicleInfo(registrationNumber) {
  const vehicleData = await lookupVehicle(registrationNumber);
  
  // If not found, use mock data for demo purposes
  if (!vehicleData.found) {
    const cleanReg = registrationNumber.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return {
      registrationNumber: cleanReg,
      make: 'BMW',
      model: '320i',
      year: '2010',
      generation: 'E90',
      engineSize: '2.0L',
      fuelType: 'Bensiini',
      power: '170 hv',
      color: 'Musta',
      found: true,
      dataSource: 'demo',
      note: 'Demo data - oikea auton haku vaatii toimivan API-yhteyden'
    };
  }
  
  return vehicleData;
}

// Get BMW-specific recommendations
function getBMWRecommendations(vehicleInfo) {
  const generation = vehicleInfo.generation || 'E90';
  const issues = BMW_KNOWLEDGE.commonIssues[generation] || BMW_KNOWLEDGE.commonIssues['E90'];
  
  return {
    commonIssues: issues,
    serviceIntervals: BMW_KNOWLEDGE.serviceIntervals,
    recommendedServices: [
      'Öljyn ja suodattimen vaihto',
      'Jarrujen tarkistus',
      'Jäähdytysjärjestelmän tarkistus',
      'Diagnostiikka'
    ],
    estimatedCosts: BMW_KNOWLEDGE.priceEstimates
  };
}

// Chat endpoint with OpenAI
app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Message is required' });
    }

    // Get or create conversation
    const convId = sessionId || `session_${Date.now()}`;
    let conversation = conversations.get(convId) || {
      messages: [],
      vehicleInfo: null,
      context: {}
    };

    // Add user message
    conversation.messages.push({
      role: 'user',
      content: message
    });

    // Check if message contains registration number
    const regMatch = message.match(/[A-Z]{1,3}[-\s]?\d{1,3}/i);
    if (regMatch && !conversation.vehicleInfo) {
      const registrationNumber = regMatch[0];
      console.log(`🔍 Detected registration number: ${registrationNumber}`);
      
      const vehicleInfo = await getVehicleInfo(registrationNumber);
      conversation.vehicleInfo = vehicleInfo;
      if (vehicleInfo.found) {
        conversation.context.recommendations = getBMWRecommendations(vehicleInfo);
      }
    }

    // Build system prompt with context
    let systemPrompt = `Olet Bemufix BMW-korjaamon ammattitaitoinen asiakaspalveluassistentti. 

TEHTÄVÄSI:
- Auta asiakkaita BMW-autojen huolto- ja korjausasioissa
- Ole ystävällinen, ammattitaitoinen ja selkeä
- Vastaa aina suomeksi
- Anna konkreettisia neuvoja ja hinta-arvioita
- Ehdota ajanvarausta kun sopivaa

OSAAMINEN:
- BMW-autojen yleiset ongelmat ja ratkaisut
- Huoltoaikataulut ja -kustannukset
- Diagnostiikka ja vianmääritys
- Varaosien saatavuus ja hinnat

HINNAT (arviot):
- Öljynvaihto: €150-300
- Jarrupalat: €400-800
- Jarrulevyt: €600-1200
- Jakoketju: €2000-4500
- Vesipumppu: €800-1500
- Diagnostiikka: €80-150

YHTEYSTIEDOT:
- Puh: 050 547 7779
- Email: info@bemufix.fi
- Osoite: Mäkeläntie 2, 00510 Helsinki

Ole positiivinen ja auta asiakasta parhaasi mukaan!`;

    if (conversation.vehicleInfo && conversation.vehicleInfo.found) {
      systemPrompt += `\n\nASIAKKAAN AUTO:
- Rekisterinumero: ${conversation.vehicleInfo.registrationNumber}
- Merkki: ${conversation.vehicleInfo.make}
- Malli: ${conversation.vehicleInfo.model}
- Vuosimalli: ${conversation.vehicleInfo.year}
${conversation.vehicleInfo.generation ? `- Sukupolvi: ${conversation.vehicleInfo.generation}` : ''}

TÄMÄN AUTON YLEISET ONGELMAT:
${conversation.context.recommendations.commonIssues.map(issue => `- ${issue}`).join('\n')}

SUOSITELLUT HUOLLOT:
${conversation.context.recommendations.recommendedServices.map(service => `- ${service}`).join('\n')}

Käytä näitä tietoja vastatessasi asiakkaan kysymyksiin!`;
    }

    // Call OpenAI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4',
      messages: [
        { role: 'system', content: systemPrompt },
        ...conversation.messages.slice(-10) // Last 10 messages for context
      ],
      max_tokens: 500,
      temperature: 0.7
    });

    const assistantMessage = completion.choices[0].message.content;

    // Add assistant message
    conversation.messages.push({
      role: 'assistant',
      content: assistantMessage
    });

    // Store conversation
    conversations.set(convId, conversation);

    // Cleanup old conversations (keep only last hour)
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const [key, value] of conversations.entries()) {
      const sessionTime = parseInt(key.split('_')[1]);
      if (sessionTime < oneHourAgo) {
        conversations.delete(key);
      }
    }

    res.json({
      message: assistantMessage,
      sessionId: convId,
      vehicleInfo: conversation.vehicleInfo,
      recommendations: conversation.context.recommendations
    });

  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({
      error: 'Failed to process message',
      details: error.message
    });
  }
});

// Vehicle lookup endpoint
app.get('/api/vehicle/:registrationNumber', async (req, res) => {
  try {
    const { registrationNumber } = req.params;
    const vehicleInfo = await getVehicleInfo(registrationNumber);
    const recommendations = getBMWRecommendations(vehicleInfo);
    
    res.json({
      vehicle: vehicleInfo,
      recommendations
    });
  } catch (error) {
    console.error('Vehicle lookup error:', error);
    res.status(500).json({
      error: 'Failed to lookup vehicle',
      details: error.message
    });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    openaiConfigured: !!process.env.OPENAI_API_KEY
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Bemufix Chatbot Backend running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔑 OpenAI API Key: ${process.env.OPENAI_API_KEY ? '✅ Configured' : '❌ Missing'}`);
});
