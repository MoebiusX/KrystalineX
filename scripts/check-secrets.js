#!/usr/bin/env node
/**
 * Secret Detection Script
 * 
 * Scans the codebase for potential hardcoded secrets and credentials.
 * Run with: npm run security:secrets
 * 
 * Exit codes:
 *   0 - No secrets detected
 *   1 - Potential secrets found
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

// Patterns that indicate potential hardcoded secrets
const SECRET_PATTERNS = [
  // API keys and tokens
  { pattern: /(?:api[_-]?key|apikey)\s*[:=]\s*['"][^'"]{10,}['"]/gi, name: 'API Key' },
  { pattern: /(?:secret[_-]?key|secretkey)\s*[:=]\s*['"][^'"]{10,}['"]/gi, name: 'Secret Key' },
  { pattern: /(?:access[_-]?token|accesstoken)\s*[:=]\s*['"][^'"]{10,}['"]/gi, name: 'Access Token' },
  { pattern: /(?:auth[_-]?token|authtoken)\s*[:=]\s*['"][^'"]{10,}['"]/gi, name: 'Auth Token' },
  
  // Database credentials
  { pattern: /(?:password|passwd|pwd)\s*[:=]\s*['"][^'"]{4,}['"]/gi, name: 'Password', exclude: ['test', 'example', 'placeholder', 'your-', 'process.env', 'CHANGE_ME', 'change_me'] },
  
  // AWS
  { pattern: /AKIA[0-9A-Z]{16}/g, name: 'AWS Access Key ID' },
  { pattern: /(?:aws[_-]?secret|aws_secret_access_key)\s*[:=]\s*['"][^'"]{20,}['"]/gi, name: 'AWS Secret' },
  
  // Private keys
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, name: 'Private Key' },
  
  // JWT tokens (actual tokens, not variable references)
  { pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, name: 'JWT Token' },
  
  // Connection strings with embedded credentials
  { pattern: /(?:mongodb|postgres|mysql|redis):\/\/[^:]+:[^@\n]{4,}@/gi, name: 'Connection String with Password', exclude: ['test:test', 'user:password', 'username:password', '${', '${{'] },
];

// Files and directories to skip
const IGNORE_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist/,
  /build/,
  /coverage/,
  /\.env\.example/,
  /\.env\..*\.example/,
  /check-secrets\.js/, // This file itself
  /\.test\.(ts|js)$/,
  /\.spec\.(ts|js)$/,
  /tests\//,
  /playwright-report/,
  /test-results/,
  /k8s\/charts\/.*\/templates\/secrets\.yaml/, // K8s secret templates use placeholders
  /scripts\/.*demo.*\.ts$/, // Demo scripts may have example credentials
  /values-secrets\.yaml$/, // K8s secrets values file (gitignored, never committed)
];

// File extensions to scan
const SCAN_EXTENSIONS = ['.ts', '.js', '.tsx', '.jsx', '.json', '.yml', '.yaml', '.env', '.sh', '.ps1'];

let foundSecrets = [];

function shouldIgnore(filePath) {
  return IGNORE_PATTERNS.some(pattern => pattern.test(filePath));
}

function shouldScan(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return SCAN_EXTENSIONS.includes(ext);
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const relativePath = path.relative(ROOT_DIR, filePath);
  const lines = content.split('\n');
  
  SECRET_PATTERNS.forEach(({ pattern, name, exclude = [] }) => {
    // Reset regex state
    pattern.lastIndex = 0;
    
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const matchText = match[0];
      
      // Skip if matches any exclude pattern
      if (exclude.some(ex => matchText.toLowerCase().includes(ex.toLowerCase()))) {
        continue;
      }
      
      // Find line number
      const beforeMatch = content.substring(0, match.index);
      const lineNumber = beforeMatch.split('\n').length;
      const line = lines[lineNumber - 1] || '';
      
      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('#') || line.trim().startsWith('*')) {
        continue;
      }
      
      foundSecrets.push({
        file: relativePath,
        line: lineNumber,
        type: name,
        snippet: matchText.substring(0, 50) + (matchText.length > 50 ? '...' : ''),
      });
    }
  });
}

function scanDirectory(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    
    if (shouldIgnore(fullPath)) {
      continue;
    }
    
    if (entry.isDirectory()) {
      scanDirectory(fullPath);
    } else if (entry.isFile() && shouldScan(fullPath)) {
      scanFile(fullPath);
    }
  }
}

console.log('🔍 Scanning for potential hardcoded secrets...\n');
scanDirectory(ROOT_DIR);

if (foundSecrets.length > 0) {
  console.log(`⚠️  Found ${foundSecrets.length} potential secret(s):\n`);
  
  foundSecrets.forEach((secret, index) => {
    console.log(`${index + 1}. [${secret.type}] ${secret.file}:${secret.line}`);
    console.log(`   Snippet: ${secret.snippet}`);
    console.log('');
  });
  
  console.log('━'.repeat(60));
  console.log('Please review these findings and ensure no real secrets are committed.');
  console.log('If these are false positives, consider updating the exclude patterns.');
  console.log('━'.repeat(60));
  
  process.exit(1);
} else {
  console.log('✅ No hardcoded secrets detected!\n');
  process.exit(0);
}
