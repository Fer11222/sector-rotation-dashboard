const https = require('https');

const SECTORS = ['XLK', 'XLF', 'XLV', 'XLE', 'SMH'];

function fetchAlphaVantage(symbol, apiKey) {
    return new Promise((resolve, reject) => {
        const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${apiKey}&outputsize=compact`;
        https.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (json['Error Message']) {
                        reject(new Error(`Invalid symbol: ${symbol}`));
                        return;
                    }
                    if (json['Note']) {
                        reject(new Error('API rate limit reached'));
                        return;
                    }
                    const timeSeries = json['Time Series (Daily)'];
                    if (!timeSeries) {
                        reject(new Error(`No data for ${symbol}`));
                        return;
                    }
                    const prices = Object.entries(timeSeries).map(([date, values]) => ({
                        date: new Date(date),
                        close: parseFloat(values['4. close'])
                    })).sort((a, b) => a.date - b.date);
                    resolve({ symbol, prices });
                } catch (error) {
                    reject(error);
                }
            });
        }).on('error', reject);
    });
}

function calculateMomentum(prices, days) {
    if (prices.length <= days) return null;
    const current = prices[prices.length - 1].close;
    const past = prices[prices.length - days - 1].close;
    return ((current - past) / past) * 100;
}

function calculateAcceleration(prices) {
    if (prices.length < 7) return null;
    const current = prices[prices.length - 1].close;
    const mid = prices[prices.length - 4].close;
    const past = prices[prices.length - 7].close;
    const recentMom = ((current - mid) / mid) * 100;
    const prevMom = ((mid - past) / past) * 100;
    return recentMom - prevMom;
}

function calculateRelativeStrength(allData) {
    const returns = allData.map(data => {
        const mom = calculateMomentum(data.prices, 20);
        return mom || 0;
    });
    const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
    return allData.map(data => {
        const mom = calculateMomentum(data.prices, 20) || 0;
        return { symbol: data.symbol, rs: mom - avgReturn };
    });
}

function classifyRotation(mom3d, mom10d, acceleration, rs) {
    let signal = 'NEUTRAL';
    let strength = 0;
    let confidence = 0;
    if (mom3d > 2 && mom10d > 0 && acceleration > 1 && rs > 2) {
        signal = 'STRONG_INFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 15);
        confidence = 90;
    } else if (mom3d < -2 && mom10d < 0 && acceleration < -1 && rs < -2) {
        signal = 'STRONG_OUTFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 15);
        confidence = 90;
    } else if (mom3d > 1 && acceleration > 0.5) {
        signal = 'MODERATE_INFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 10);
        confidence = 65;
    } else if (mom3d < -1 && acceleration < -0.5) {
        signal = 'MODERATE_OUTFLOW';
        strength = Math.min(100, Math.abs(acceleration) * 10);
        confidence = 65;
    } else if (mom3d > 0.5) {
        signal = 'WEAK_INFLOW';
        strength = Math.min(100, Math.abs(mom3d) * 8);
        confidence = 40;
    } else if (mom3d < -0.5) {
        signal = 'WEAK_OUTFLOW';
        strength = Math.min(100, Math.abs(mom3d) * 8);
        confidence = 40;
    } else if (acceleration > 1 && mom10d > 0) {
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

function identifyRotationPairs(signals) {
    const inflow = signals.filter(s => s.signal.includes('INFLOW') && s.confidence >= 60).sort((a, b) => b.strength - a.strength);
    const outflow = signals.filter(s => s.signal.includes('OUTFLOW') && s.confidence >= 60).sort((a, b) => b.strength - a.strength);
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

exports.handler = async function(event, context) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers, body: '' };
    }
    try {
        const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
        if (!apiKey) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'API key not configured' }) };
        }
        const allData = [];
        for (let i = 0; i < SECTORS.length; i++) {
            try {
                const data = await fetchAlphaVantage(SECTORS[i], apiKey);
                allData.push(data);
                if (i < SECTORS.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, 12000));
                }
            } catch (error) {
                console.error(`Error: ${error.message}`);
            }
        }
        if (allData.length === 0) {
            return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch data' }) };
        }
        const rsData = calculateRelativeStrength(allData);
        const signals = allData.map(data => {
            const { symbol, prices } = data;
            if (prices.length < 20) return null;
            const mom3d = calculateMomentum(prices, 3) || 0;
            const mom10d = calculateMomentum(prices, 10) || 0;
            const mom20d = calculateMomentum(prices, 20) || 0;
            const acceleration = calculateAcceleration(prices) || 0;
            const rsItem = rsData.find(r => r.symbol === symbol);
            const rs = rsItem ? rsItem.rs : 0;
            const classification = classifyRotation(mom3d, mom10d, acceleration, rs);
            return {
                symbol, signal: classification.signal, strength: classification.strength,
                confidence: classification.confidence, momentum_3d: mom3d, momentum_10d: mom10d,
                momentum_20d: mom20d, acceleration, relative_strength: rs
            };
        }).filter(s => s !== null);
        const rotationPairs = identifyRotationPairs(signals);
        return {
            statusCode: 200, headers,
            body: JSON.stringify({ timestamp: new Date().toISOString(), sectors_analyzed: signals.length, signals, rotationPairs })
        };
    } catch (error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
    }
};
