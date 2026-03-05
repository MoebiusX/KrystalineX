/**
 * Email Service
 * 
 * Send emails via Mailgun API.
 * Krystaline branding - Crystal Clear Crypto
 */

import FormData from 'form-data';
import Mailgun from 'mailgun.js';
import { config } from '../config';
import { createLogger } from '../lib/logger';

const logger = createLogger('email');

// Initialize Mailgun client (or null if no API key configured)
const mg = config.mailgun
    ? new Mailgun(FormData).client({
        username: 'api',
        key: config.mailgun.apiKey,
        url: config.mailgun.url,
    })
    : null;

const mailgunDomain = config.mailgun?.domain || 'mail.krystaline.io';
const emailFrom = config.mailgun?.from || '"Krystaline" <no-reply@krystaline.io>';

interface EmailOptions {
    to: string;
    subject: string;
    text?: string;
    html?: string;
}

// Krystaline brand colors
const BRAND = {
    name: 'Krystaline',
    tagline: 'Crystal Clear Crypto',
    primaryColor: '#8B5CF6', // Purple
    secondaryColor: '#EC4899', // Pink
    bgColor: '#0F172A', // Dark slate
};

// Email header/footer template
const emailWrapper = (content: string) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; margin: 0; padding: 0; background: #f4f4f5; }
        .container { max-width: 600px; margin: 0 auto; background: white; }
        .header { background: linear-gradient(135deg, ${BRAND.primaryColor}, ${BRAND.secondaryColor}); padding: 30px; text-align: center; }
        .header h1 { color: white; margin: 0; font-size: 28px; letter-spacing: 2px; }
        .header p { color: rgba(255,255,255,0.8); margin: 5px 0 0; font-size: 14px; }
        .content { padding: 40px 30px; }
        .footer { background: ${BRAND.bgColor}; padding: 20px 30px; text-align: center; }
        .footer p { color: rgba(255,255,255,0.6); margin: 5px 0; font-size: 12px; }
        .footer a { color: ${BRAND.primaryColor}; }
        .code-box { background: #f4f4f5; padding: 25px; text-align: center; font-family: monospace; font-size: 36px; letter-spacing: 8px; margin: 20px 0; border-radius: 8px; }
        .btn { display: inline-block; background: linear-gradient(135deg, ${BRAND.primaryColor}, ${BRAND.secondaryColor}); color: white; padding: 15px 30px; text-decoration: none; border-radius: 8px; font-weight: bold; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>💎 ${BRAND.name}</h1>
            <p>${BRAND.tagline}</p>
        </div>
        <div class="content">
            ${content}
        </div>
        <div class="footer">
            <p>© 2026 ${BRAND.name}. All rights reserved.</p>
            <p>Proof of Observability • Proof of Trust</p>
        </div>
    </div>
</body>
</html>
`;

export const emailService = {
    async send(options: EmailOptions): Promise<boolean> {
        if (!mg) {
            logger.warn({ to: options.to, subject: options.subject },
                'Mailgun not configured (no MAILGUN_API_KEY). Email not sent.');
            return false;
        }

        try {
            const data = await mg.messages.create(mailgunDomain, {
                from: emailFrom,
                to: [options.to],
                subject: options.subject,
                text: options.text,
                html: options.html,
            } as any);

            logger.info({
                to: options.to,
                subject: options.subject,
                messageId: data.id,
            }, 'Email sent successfully via Mailgun');
            return true;
        } catch (error: unknown) {
            logger.error({
                err: error,
                to: options.to,
                subject: options.subject
            }, 'Failed to send email via Mailgun');
            return false;
        }
    },

    async sendVerificationCode(email: string, code: string): Promise<boolean> {
        return this.send({
            to: email,
            subject: `Verify your email - ${BRAND.name}`,
            html: emailWrapper(`
                <h2 style="margin-top: 0;">Email Verification</h2>
                <p>Your verification code is:</p>
                <div class="code-box">${code}</div>
                <p style="color: #666;">This code expires in 10 minutes.</p>
                <p style="color: #999; font-size: 14px;">If you didn't request this, please ignore this email.</p>
            `),
            text: `Your ${BRAND.name} verification code is: ${code}\n\nThis code expires in 10 minutes.`
        });
    },

    async sendPasswordReset(email: string, code: string): Promise<boolean> {
        return this.send({
            to: email,
            subject: `Password Reset - ${BRAND.name}`,
            html: emailWrapper(`
                <h2 style="margin-top: 0;">Password Reset</h2>
                <p>Your password reset code is:</p>
                <div class="code-box">${code}</div>
                <p style="color: #666;">This code expires in 10 minutes.</p>
                <p style="color: #999; font-size: 14px;">If you didn't request this, please ignore this email.</p>
            `),
            text: `Your ${BRAND.name} password reset code is: ${code}\n\nThis code expires in 10 minutes.`
        });
    },

    async sendWelcome(email: string): Promise<boolean> {
        return this.send({
            to: email,
            subject: `Welcome to ${BRAND.name}! 💎`,
            html: emailWrapper(`
                <h2 style="margin-top: 0;">Welcome to ${BRAND.name}! 🎉</h2>
                <p>Your account has been verified and is ready to use.</p>
                <p>You've been credited with test funds to explore the platform:</p>
                <ul style="line-height: 2;">
                    <li><strong>10,000 USDT</strong> - for trading</li>
                    <li><strong>1 BTC</strong> - test Bitcoin</li>
                    <li><strong>10 ETH</strong> - test Ethereum</li>
                </ul>
                <p style="margin-top: 30px;">
                    <a href="http://localhost:5000/portfolio" class="btn">View Your Portfolio</a>
                </p>
                <p style="color: #666; margin-top: 30px; font-size: 14px;">
                    Crystal clear transparency. Every transaction, every trade, fully observable.
                    Want access to secured monitoring? use admin:askCarlos to access Grafana, Prometheus, GoAlert, and more!
                </p>
            `),
            text: `Welcome to ${BRAND.name}!\n\nYou've been credited with test funds:\n- 10,000 USDT\n- 1 BTC\n- 10 ETH\n\nStart trading at http://localhost:5000/portfolio`
        });
    }
};

export default emailService;
