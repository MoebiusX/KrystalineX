#!/usr/bin/env node

/**
 * CI Guard: Confidential Documentation Leak Prevention
 * 
 * Checks that confidential documents (whitepapers, screenshots, zip bundles)
 * are not staged for commit. Run as part of CI pipeline or pre-commit hook.
 * 
 * Exit code 0 = clean, Exit code 1 = confidential files detected
 */

const { execSync } = require('child_process');
const path = require('path');

// Patterns for confidential files that must NEVER be committed
const CONFIDENTIAL_PATTERNS = [
  // Internal-only documentation
  'docs/OBSERVABILITY_ADOPTION_GUIDE.md',
  'docs/OBSERVABILITY_MATHEMATICS.md',

  // Screenshots and images (may contain proprietary UI)
  'docs/images/',

  // API documentation (internal specs)
  'docs/api/',

  // Documentation bundles
  'docs-bundle.zip',
  'docs/*.zip',
];

// Regex patterns for broader matching
const CONFIDENTIAL_REGEXES = [
  /^docs\/images\//,
  /^docs\/api\//,
  /^docs.*\.zip$/,
  /^docs-bundle\.zip$/,
  /^docs\/OBSERVABILITY_(?!WHITEPAPER)/,  // exclude whitepaper (public)
];

function getTrackedFiles() {
  try {
    const output = execSync('git ls-files', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    console.error('❌ Failed to list git tracked files. Are you in a git repository?');
    process.exit(1);
  }
}

function getStagedFiles() {
  try {
    const output = execSync('git diff --cached --name-only', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function checkForLeaks(files, label) {
  const violations = [];

  for (const file of files) {
    const normalizedFile = file.replace(/\\/g, '/');

    for (const regex of CONFIDENTIAL_REGEXES) {
      if (regex.test(normalizedFile)) {
        violations.push(normalizedFile);
        break;
      }
    }
  }

  return violations;
}

function main() {
  console.log('🔒 Confidential Documentation Leak Check');
  console.log('=========================================\n');

  // Check tracked files (already committed)
  const trackedFiles = getTrackedFiles();
  const trackedViolations = checkForLeaks(trackedFiles, 'tracked');

  // Check staged files (about to be committed)
  const stagedFiles = getStagedFiles();
  const stagedViolations = checkForLeaks(stagedFiles, 'staged');

  let hasViolations = false;

  if (trackedViolations.length > 0) {
    console.error('🚨 CONFIDENTIAL FILES ALREADY TRACKED IN GIT:\n');
    trackedViolations.forEach(f => console.error(`   ⚠️  ${f}`));
    console.error('\n   Run: git rm --cached <file> to untrack them.\n');
    hasViolations = true;
  }

  if (stagedViolations.length > 0) {
    console.error('🚨 CONFIDENTIAL FILES STAGED FOR COMMIT:\n');
    stagedViolations.forEach(f => console.error(`   ⚠️  ${f}`));
    console.error('\n   Run: git reset HEAD <file> to unstage them.\n');
    hasViolations = true;
  }

  if (hasViolations) {
    console.error('❌ Confidential document check FAILED.');
    console.error('   These files must not be committed to the repository.');
    console.error('   Ensure they are listed in .gitignore.\n');
    process.exit(1);
  }

  console.log('✅ No confidential documents detected in git.');
  console.log(`   Checked ${trackedFiles.length} tracked files and ${stagedFiles.length} staged files.`);
  process.exit(0);
}

main();
