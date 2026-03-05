/**
 * Email Service Unit Tests
 * 
 * Tests for email sending functionality via Mailgun API
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Must use vi.hoisted so the mock fn is available when vi.mock is hoisted
const { mockCreate } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
}));

vi.mock('mailgun.js', () => {
  return {
    default: class MockMailgun {
      client() {
        return {
          messages: { create: mockCreate },
        };
      }
    },
  };
});

vi.mock('form-data', () => {
  return { default: class FormData { } };
});

// Mock config - provide mailgun config so client is initialized
vi.mock('../../server/config', () => ({
  config: {
    mailgun: {
      apiKey: 'test-api-key',
      domain: 'mail.krystaline.io',
      url: 'https://api.eu.mailgun.net',
      from: '"Krystaline" <no-reply@krystaline.io>',
    },
  },
}));

// Mock logger
vi.mock('../../server/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { emailService } from '../../server/auth/email-service';

describe('Email Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('send', () => {
    it('should send email successfully', async () => {
      mockCreate.mockResolvedValue({ id: 'test-123', message: 'Queued' });

      const result = await emailService.send({
        to: 'test@example.com',
        subject: 'Test Subject',
        text: 'Test body',
        html: '<p>Test body</p>',
      });

      expect(result).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith(
        'mail.krystaline.io',
        expect.objectContaining({
          to: ['test@example.com'],
          subject: 'Test Subject',
          text: 'Test body',
          html: '<p>Test body</p>',
        })
      );
    });

    it('should return false on send failure', async () => {
      mockCreate.mockRejectedValue(new Error('Mailgun API error'));

      const result = await emailService.send({
        to: 'test@example.com',
        subject: 'Test Subject',
        text: 'Test body',
      });

      expect(result).toBe(false);
    });

    it('should include from address', async () => {
      mockCreate.mockResolvedValue({ id: 'test-123', message: 'Queued' });

      await emailService.send({
        to: 'test@example.com',
        subject: 'Test',
        text: 'Test',
      });

      expect(mockCreate).toHaveBeenCalledWith(
        'mail.krystaline.io',
        expect.objectContaining({
          from: expect.stringContaining('Krystaline'),
        })
      );
    });
  });

  describe('sendVerificationCode', () => {
    it('should send verification email with code', async () => {
      mockCreate.mockResolvedValue({ id: 'verify-123', message: 'Queued' });

      const result = await emailService.sendVerificationCode('user@example.com', '123456');

      expect(result).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith(
        'mail.krystaline.io',
        expect.objectContaining({
          to: ['user@example.com'],
          subject: expect.stringContaining('Verify'),
        })
      );
    });

    it('should include code in email body', async () => {
      mockCreate.mockResolvedValue({ id: 'verify-123', message: 'Queued' });

      await emailService.sendVerificationCode('user@example.com', '654321');

      const callArgs = mockCreate.mock.calls[0][1];
      expect(callArgs.html).toContain('654321');
      expect(callArgs.text).toContain('654321');
    });

    it('should mention expiration in email', async () => {
      mockCreate.mockResolvedValue({ id: 'verify-123', message: 'Queued' });

      await emailService.sendVerificationCode('user@example.com', '123456');

      const callArgs = mockCreate.mock.calls[0][1];
      expect(callArgs.text).toContain('10 minutes');
    });
  });

  describe('sendPasswordReset', () => {
    it('should send password reset email', async () => {
      mockCreate.mockResolvedValue({ id: 'reset-123', message: 'Queued' });

      const result = await emailService.sendPasswordReset('user@example.com', '999888');

      expect(result).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith(
        'mail.krystaline.io',
        expect.objectContaining({
          to: ['user@example.com'],
          subject: expect.stringContaining('Password Reset'),
        })
      );
    });

    it('should include reset code in body', async () => {
      mockCreate.mockResolvedValue({ id: 'reset-123', message: 'Queued' });

      await emailService.sendPasswordReset('user@example.com', '777666');

      const callArgs = mockCreate.mock.calls[0][1];
      expect(callArgs.html).toContain('777666');
      expect(callArgs.text).toContain('777666');
    });
  });

  describe('sendWelcome', () => {
    it('should send welcome email', async () => {
      mockCreate.mockResolvedValue({ id: 'welcome-123', message: 'Queued' });

      const result = await emailService.sendWelcome('newuser@example.com');

      expect(result).toBe(true);
      expect(mockCreate).toHaveBeenCalledWith(
        'mail.krystaline.io',
        expect.objectContaining({
          to: ['newuser@example.com'],
          subject: expect.stringContaining('Welcome'),
        })
      );
    });

    it('should include test fund information', async () => {
      mockCreate.mockResolvedValue({ id: 'welcome-123', message: 'Queued' });

      await emailService.sendWelcome('newuser@example.com');

      const callArgs = mockCreate.mock.calls[0][1];
      expect(callArgs.html).toContain('10,000 USDT');
      expect(callArgs.html).toContain('1 BTC');
      expect(callArgs.html).toContain('10 ETH');
    });

    it('should include portfolio link', async () => {
      mockCreate.mockResolvedValue({ id: 'welcome-123', message: 'Queued' });

      await emailService.sendWelcome('newuser@example.com');

      const callArgs = mockCreate.mock.calls[0][1];
      expect(callArgs.html).toContain('portfolio');
    });
  });
});
