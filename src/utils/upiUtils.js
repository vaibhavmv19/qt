import querystring from 'querystring';

/**
 * Create a standard UPI payment URI.
 * Format: upi://pay?pa=<upi_id>&pn=<name>&am=<amount>&cu=INR&tn=<note>
 */
export function createUpiUri(upiId, name, amount = null, note = "Payment") {
    const params = {
        pa: upiId,
        pn: name,
        cu: 'INR',
        tn: note
    };
    
    if (amount) {
        params.am = String(amount);
    }
    
    const queryString = querystring.stringify(params);
    return `upi://pay?${queryString}`;
}
