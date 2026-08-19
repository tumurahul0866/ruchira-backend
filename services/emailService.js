/**
 * Email Service using Brevo Transactional Email REST API v3
 * Official API Endpoint: https://api.brevo.com/v3/smtp/email
 */

export async function sendPasswordResetOTP(toEmail, otpCode) {
  const apiKey = process.env.BREVO_API_KEY;
  const senderEmail = process.env.BREVO_SENDER_EMAIL;
  const senderName = process.env.BREVO_SENDER_NAME || 'Ruchira Pickles';
  const maskEmail = (email) => {
    const [localPart, domain] = String(email).split('@');
    if (!localPart || !domain) return '[invalid-email]';
    return `${localPart.slice(0, 1)}***@${domain}`;
  };

  console.info('Brevo OTP request started', {
    BREVO_API_KEY: apiKey ? 'PRESENT' : 'MISSING',
    BREVO_SENDER_EMAIL: process.env.BREVO_SENDER_EMAIL ? 'PRESENT' : 'MISSING',
    sender: maskEmail(senderEmail),
    recipient: maskEmail(toEmail),
  });

  if (apiKey && senderEmail) {
    try {
      const response = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'api-key': apiKey,
        },
        body: JSON.stringify({
          sender: {
            name: senderName,
            email: senderEmail,
          },
          to: [
            {
              email: toEmail,
            },
          ],
          subject: 'Reset your Ruchira Pickles password',
          htmlContent: `
            <!DOCTYPE html>
            <html>
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1.0">
            </head>
            <body style="font-family: Arial, sans-serif; background-color: #F8F3E8; margin: 0; padding: 20px; color: #5C4033;">
              <div style="max-width: 560px; margin: 0 auto; background-color: #ffffff; border: 2px solid rgba(92, 64, 51, 0.15); border-radius: 20px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.05);">
                <div style="text-align: center; margin-bottom: 24px;">
                  <h1 style="color: #5C4033; font-family: Georgia, serif; margin: 0; font-size: 26px;">Ruchira Pickles</h1>
                  <p style="color: #D97706; font-size: 13px; font-weight: bold; margin-top: 4px; text-transform: uppercase; letter-spacing: 1px;">Crafted to Crave</p>
                </div>
                
                <h2 style="font-size: 18px; color: #5C4033; margin-bottom: 12px;">Hello,</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #5C4033; margin-bottom: 20px;">
                  We received a request to reset your Ruchira Pickles account password. Your verification code is:
                </p>
                
                <div style="background-color: #F8F3E8; border: 2px dashed #D97706; padding: 18px; text-align: center; margin: 24px 0; border-radius: 14px;">
                  <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #5C4033; font-family: monospace;">${otpCode}</span>
                </div>
                
                <p style="font-size: 13px; color: #5C4033; margin-bottom: 24px;">
                  This code expires in <strong>10 minutes</strong>. Please do not share this code with anyone.
                </p>
                
                <hr style="border: none; border-top: 1px solid #EAE0D0; margin: 24px 0;" />
                
                <p style="font-size: 12px; color: #8C7060; margin: 0; text-align: center;">
                  If you did not request a password reset, you can safely ignore this email.
                </p>
                <p style="font-size: 12px; color: #8C7060; margin-top: 8px; text-align: center;">
                  Regards,<br/><strong>Ruchira Pickles Team</strong>
                </p>
              </div>
            </body>
            </html>
          `,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        const safeMessage = String(errorData.message || errorData.code || 'Unknown Brevo error')
          .replaceAll(apiKey, '[REDACTED]')
          .replace(/\b\d{6}\b/g, '[REDACTED]');
        console.error('Brevo API email dispatch rejected', {
          status: response.status,
          code: errorData.code || 'UNKNOWN',
          message: safeMessage,
        });
        return { ok: false, reason: 'brevo_rejected', status: response.status };
      }

      console.info('Brevo API email dispatch accepted', { status: response.status });
      return { ok: true, reason: 'brevo_accepted', status: response.status };
    } catch (err) {
      console.error('Brevo network dispatch failed', {
        message: String(err.message || 'Unknown network error').replaceAll(apiKey, '[REDACTED]'),
      });
      return { ok: false, reason: 'network_error' };
    }
  }

  console.warn('Brevo OTP email unavailable', { reason: 'config_missing' });
  return { ok: false, reason: 'config_missing' };
}
