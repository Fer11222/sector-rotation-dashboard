// Netlify Function: getSectorData.js
// This function fetches sector data and calculates rotation signals

const https = require('https');

// All sectors from your project
const SECTORS = [
    'URA', 'OIH', 'XME', 'XLE', 'SIL', 'SMH', 'XOP', 'AAPD', 'SLX', 'PBW',
    'VEGI', 'GDX', 'TAN', 'XLB', 'ITA', 'XLP', 'XLI', 'KRE', 'ITB', 'IYZ',
    'QTUM', 'KBE', 'ROBO', 'BLOK', 'KWEB', 'IYT', 'PAVE', 'XBI', 'XLC', 'XLY',
    'XLU', 'XRT', 'IDRV', 'XLV', 'XLK', 'JETS', 'PEJ', 'XLF', 'KIE', 'FDN',
    'IHI', 'IGV'
];

// Helper: Fetch data from Alpha Vantage
function fetchAlphaVantage(symbol, apiKey) {
    return new Promise((resolve, reject) => {
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${apiKey}&outputsize=compact`;
        
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    
                    // Check for API errors
                    if (json['Error Message']) {
                        reject(new Error(`Invalid symbol: ${symbol}`));
                        return;
                    }
                    
                    if (json['Note']) {
                        reject(new Error('API rate limit reached. Please wait a minute.'));
                        return;
                    }
                    
                    const timeSeries = json['Time Series (Daily)'];
                    if (!timeSeries) {
                        reject(new Error(`No data for ${symbol}`));
                        return;
                    }
                    
                    // Convert to array and sort by date
                    const prices = Object.entries(timeSeries)
                        .map(([date, values]) => ({
                            date: new Date(date),
                            close: parseFloat(values['4. close'])
                        }))
                        .sort((a, b) => a.date - b.date);
                    
                    resolve({ symbol, prices });
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

// Calculate momentum for different periods
function calculateMomentum(prices, days) {
    if (prices.length <= days) return null;
    const current = prices[prices.length - 1].close;
    const past = prices[prices.length - days - 1].close;
    return ((current - past) / past) * 100;
}

// Calculate acceleration (momentum of momentum)
function calculateAcceleration(prices) {
    if (prices.length < 7) return null;
    
    const current = prices[prices.length - 1].close;
    const mid = prices[prices.length - 4].close;
    const past = prices[prices.length - 7].close;
    
    const recentMom = ((current - mid) / mid) * 100;
    const prevMom = ((mid - past) / past) * 100;
    
    return recentMom - prevMom;
}

// Calculate relative strength
function calculateRelativeStrength(allData) {
    const returns = allData.map(data => {
        const mom = calculateMomentum(data.prices, 20);
        return mom || 0;
    });
    
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    
    return allData.map(data => {
        const mom = calculateMomentum(data.prices, 20) || 0;
        return {
            symbol: data.symbol,
            rs: mom - avgReturn
        };
    });
}

// Classify rotation signal
function classifyRotation(mom3d, mom10d, acceleration, rs) {
    let signal = 'NEUTRAL';
    let strength = 0;
    let confidence = 0;
    
    // Strong signals
    if (mom3d > 2 && mom10d > 0 && acceleration > 1 && rs > 2) {
        signal = 'STRONG_INFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 15);
        confidence = 90;
    } else if (mom3d < -2 && mom10d < 0 && acceleration < -1 && rs < -2) {
        signal = 'STRONG_OUTFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 15);
        confidence = 90;
    }
    // Moderate signals
    else if (mom3d > 1 && acceleration > 0.5) {
        signal = 'MODERATE_INFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 10);
        confidence = 65;
    } else if (mom3d < -1 && acceleration < -0.5) {
        signal = 'MODERATE_OUTFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 10);
        confidence = 65;
    }
    // Weak signals
    else if (mom3d > 0.5) {
        signal = 'WEAK_INFLOW';
        strength = Math.min(100, Math.abs(mom3d) * 8);
        confidence = 40;
    } else if (mom3d < -0.5) {
        signal = 'WEAK_OUTFLOW';
        strength = Math.min(100, Math.abs(mom3d) * 8);
        confidence = 40;
    }
    // Acceleration/Deceleration
    else if (acceleration > 1 && mom10d > 0) {
        signal = 'ACCELERATING_UP';
        strength = Math.min(100, Math.abs(acceleration) * 12);
        confidence = 55;
    } else if (acceleration < -1 && mom10d < 0) {
        signal = 'ACCELERATING_DOWN';
        strength = Math.min(100, Math.abs(acceleration) * 12);
        confidence = 55;
    }
    
    return { signal, strength, confidence };
}

// Identify rotation pairs
function identifyRotationPairs(signals) {
    const inflow = signals.filter(s => 
        s.signal.includes('INFLOW') && s.confidence >= 60
    ).sort((a, b) => b.strength - a.strength);
    
    const outflow = signals.filter(s => 
        s.signal.includes('OUTFLOW') && s.confidence >= 60
    ).sort((a, b) => b.strength - a.strength);
    
    const pairs = [];
    const maxPairs = Math.min(5, Math.max(inflow.length, outflow.length));
    
    for (let i = 0; i < maxPairs; i++) {
        const from = outflow[i] || outflow[0];
        const to = inflow[i] || inflow[0];
        
        if (from && to) {
            pairs.push({
                from: from.symbol,
                to: to.symbol,
                confidence: (from.confidence + to.confidence) / 2,
                score: (from.strength + to.strength) / 2
            });
        }
    }
    
    return pairs;
}

// Main handler
exports.handler = async function(event, context) {
    // Enable CORS
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };
    
    // Handle OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    
    try {
        // Get API key from environment variable
        const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
        
        if (!apiKey) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: 'API key not configured. Please set ALPHA_VANTAGE_API_KEY environment variable.' 
                })
            };
        }
        
        console.log(`Fetching data for ${SECTORS.length} sectors...`);
        
        // Fetch data for all sectors (with delay to avoid rate limiting)
        const allData = [];
        
        for (let i = 0; i < SECTORS.length; i++) {
            try {
                const data = await fetchAlphaVantage(SECTORS[i], apiKey);
                allData.push(data);
                console.log(`✓ ${SECTORS[i]}: ${data.prices.length} days`);
                
                // Add delay between requests (Alpha Vantage free tier limit: 5 req/min)
                if (i < SECTORS.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 12000)); // 12 second delay
                }
            } catch (error) {
                console.error(`✗ ${SECTORS[i]}: ${error.message}`);
                // Continue with other sectors even if one fails
            }
        }
        
        if (allData.length === 0) {
            return {
                statusCode: 500,
                headers,
                body: JSON.stringify({ 
                    error: 'Failed to fetch data for any sectors. Check API key and rate limits.' 
                })
            };
        }
        
        // Calculate relative strength
        const rsData = calculateRelativeStrength(allData);
        
        // Calculate signals for each sector
        const signals = allData.map(data => {
            const { symbol, prices } = data;
            
            if (prices.length < 20) {
                return null;
            }
            
            const mom3d = calculateMomentum(prices, 3) || 0;
            const mom10d = calculateMomentum(prices, 10) || 0;
            const mom20d = calculateMomentum(prices, 20) || 0;
            const acceleration = calculateAcceleration(prices) || 0;
            
            const rsItem = rsData.find(r => r.symbol === symbol);
            const rs = rsItem ? rsItem.rs : 0;
            
            const classification = classifyRotation(mom3d, mom10d, acceleration, rs);
            
            return {
                symbol,
                signal: classification.signal,
                strength: classification.strength,
                confidence: classification.confidence,
                momentum_3d: mom3d,
                momentum_10d: mom10d,
                momentum_20d: mom20d,
                acceleration,
                relative_strength: rs
            };
        }).filter(s => s !== null);
        
        // Identify rotation pairs
        const rotationPairs = identifyRotationPairs(signals);
        
        // Return results
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                timestamp: new Date().toISOString(),
                sectors_analyzed: signals.length,
                signals,
                rotationPairs
            })
        };
        
    } catch (error) {
        console.error('Error:', error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({ 
                error: error.message 
            })
        };
    }
};
```

5. **Scroll down and click "Commit changes"**

6. **Done! ✅** The file is now in the correct location!

---

## ✅ **Option 3: Download and Upload Method**

1. **Download `getSectorData.js`** (from the file I just provided above)

2. **After uploading the 3 root files** (index.html, netlify.toml, package.json) to GitHub:

3. **Click "Add file" → "Create new file"**

4. **Type the path:**
```
   netlify/functions/getSectorData.js
```

5. **Copy the entire code** from the downloaded file

6. **Paste into GitHub's editor**

7. **Click "Commit changes"**

---

## 🎯 **Recommended: Use Option 2 (Create Directly in GitHub)**

**Why this is best:**
- ✅ No file to download
- ✅ No confusion about where to put it
- ✅ Creates folder structure automatically
- ✅ One less step

**Just copy-paste the code directly into GitHub!**

---

## 📋 **Updated Step 2D Instructions**

### **Step D: Create Netlify Function** (3 min)

1. **Make sure you've uploaded the 3 root files first:**
   - ✅ index.html
   - ✅ netlify.toml
   - ✅ package.json

2. **Click "Add file" → "Create new file"**

3. **In the filename box, type EXACTLY:**
```
   netlify/functions/getSectorData.js
```
   
   **As you type:**
   - After `netlify/` → Creates `netlify` folder
   - After `functions/` → Creates `functions` folder
   - After `getSectorData.js` → Names the file

4. **Copy ALL the code from Option 2 above**
   - Click in the code box
   - Press Ctrl+A (Select All)
   - Press Ctrl+C (Copy)

5. **Paste into GitHub's big text editor**
   - Click in the file content area
   - Press Ctrl+V (Paste)
   - You should see ~350 lines of code

6. **Scroll down**
   - Commit message: "Add sector data function"
   - Click "Commit changes"

7. **Verify:**
   - Go back to repository main page
   - Click on `netlify` folder
   - Click on `functions` folder
   - You should see `getSectorData.js`
   - Click on it to open - should show the code

8. **Perfect! ✅** Continue to Step 3 (Netlify deployment)

---

## 🔍 **Final File Check**

Your GitHub repository should now have:
```
✅ index.html (in root)
✅ netlify.toml (in root)
✅ package.json (in root)
✅ netlify/ (folder)
    ✅ functions/ (folder inside netlify)
        ✅ getSectorData.js (file inside functions)
