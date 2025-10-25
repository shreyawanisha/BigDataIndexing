// npm i google-auth-library
const { OAuth2Client } = require('google-auth-library');
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

module.exports = async function verifyGoogleToken(req, res, next) {
    try {
    const h = req.headers.authorization || '';
    if (!h.startsWith('Bearer ')) return res.status(401).json({ error: 'Missing bearer token' });
    const token = h.slice(7);

    // (hard check) alg must be RS256
    const [hdr] = token.split('.');
    const alg = JSON.parse(Buffer.from(hdr, 'base64').toString('utf8')).alg;
    if (alg !== 'RS256') return res.status(401).json({ error: 'Invalid alg, require RS256' });

    const ticket = await client.verifyIdToken({ idToken: token, audience: process.env.GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    const issOk = payload.iss === 'accounts.google.com' || payload.iss === 'https://accounts.google.com';
    if (!issOk) return res.status(401).json({ error: 'Invalid issuer' });

    req.user = { sub: payload.sub, email: payload.email, name: payload.name };
    next();
    } catch (e) {
    console.error('JWT verify failed:', e.message);
    res.status(401).json({ error: 'Unauthorized' });
    }
};