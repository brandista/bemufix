const express = require('express');
const cors = require('cors');
const { chromium } = require('playwright');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// CORS - salli Railway domainit
app.use(cors({
  origin: [
    'https://bemufix.brandista.eu',
    'https://bmw-front-production.up.railway.app',
    /\.railway\.app$/,
    /\.brandista\.eu$/
  ],
  credentials: true
}));

app.use(express.json());
app.set('trust proxy', 1);

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    port: PORT
  });
});

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    
    console.log('📨 Request:', message);

    const regMatch = message.match(/([A-Z]{3}[-\s]?\d{3})/i);
    
    if (!regMatch) {
      return res.json({
        message: 'Anna rekisterinumero (esim. ABC-123)',
        source: 'system'
      });
    }

    const registration = regMatch[1].replace(/[-\s]/g, '').toUpperCase();
    console.log('🔍 Lookup:', registration);

    const browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    
    try {
      await page.goto(`https://kolariautot.com/${registration}`, {
        waitUntil: 'networkidle',
        timeout: 30000
      });

      await page.waitForTimeout(3000);

      const data = await page.evaluate(() => {
        const text = document.body.innerText;
        return {
          make: text.match(/Merkki[:\s]*([A-Z]+)/i)?.[1] || '',
          model: text.match(/Malli[:\s]*([^\n]+)/i)?.[1] || '',
          year: text.match(/Vuosimalli[:\s]*(\d{4})/i)?.[1] || ''
        };
      });

      await browser.close();

      const response = `Löysin: ${data.make} ${data.model} (${data.year})`;

      return res.json({
        message: response,
        source: 'agent',
        vehicleData: { registration, ...data }
      });

    } catch (error) {
      await browser.close();
      throw error;
    }

  } catch (error) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      message: 'Virhe haussa. Yritä uudelleen.',
      error: error.message
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Backend on port ${PORT}`);
});
