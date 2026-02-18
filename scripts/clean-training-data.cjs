/**
 * Clean Training Data — Remove Poisoned Examples
 * 
 * Strips examples whose output doesn't follow the expected
 * SUMMARY / CAUSES / RECOMMENDATIONS / CONFIDENCE format.
 * These are typically recycled bad model outputs (one-liners).
 *
 * Usage: node scripts/clean-training-data.cjs
 */
const fs = require('fs');
const path = require('path');

const COMBINED_FILE = path.join(__dirname, '..', 'data', 'training-data-combined.jsonl');
const AXOLOTL_FILE = path.join(__dirname, '..', 'data', 'training-data-axolotl.jsonl');

function isValidOutput(output) {
    const hasSummary = output.includes('SUMMARY:');
    const hasCauses = output.includes('CAUSES:');
    const hasRecs = output.includes('RECOMMENDATIONS:');
    const hasConf = output.includes('CONFIDENCE:');

    // Must have all four sections
    if (!(hasSummary && hasCauses && hasRecs && hasConf)) return false;

    // SUMMARY must be at least 20 chars
    const summaryMatch = output.match(/SUMMARY:\s*(.+)/);
    if (!summaryMatch || summaryMatch[1].trim().length < 20) return false;

    // Must have at least 4 bullet points (causes + recommendations)
    const bullets = (output.match(/^- /gm) || []).length;
    if (bullets < 4) return false;

    return true;
}

console.log('');
console.log('═══════════════════════════════════════════');
console.log('  Training Data Cleaner');
console.log('═══════════════════════════════════════════');
console.log('');

// Clean the combined file
for (const filePath of [COMBINED_FILE, AXOLOTL_FILE]) {
    const basename = path.basename(filePath);

    if (!fs.existsSync(filePath)) {
        console.log(`⏭️  ${basename} not found, skipping`);
        continue;
    }

    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    console.log(`📂 ${basename}: ${lines.length} samples`);

    const kept = [];
    const removed = [];

    for (let i = 0; i < lines.length; i++) {
        try {
            const d = JSON.parse(lines[i]);
            if (isValidOutput(d.output || '')) {
                kept.push(lines[i]);
            } else {
                removed.push({
                    line: i + 1,
                    instrPreview: (d.instruction || '').substring(0, 60),
                    outputPreview: (d.output || '').substring(0, 80),
                });
            }
        } catch (e) {
            removed.push({ line: i + 1, instrPreview: '(invalid JSON)', outputPreview: '' });
        }
    }

    console.log(`   ✅ Kept:    ${kept.length} valid examples`);
    console.log(`   ❌ Removed: ${removed.length} poisoned examples`);

    if (removed.length > 0) {
        console.log('');
        console.log('   Removed examples:');
        removed.forEach(r => {
            console.log(`     Line ${r.line}: "${r.outputPreview}..."`);
        });
    }

    // Write cleaned file
    fs.writeFileSync(filePath, kept.join('\n') + '\n');
    console.log(`   💾 Written: ${kept.length} samples → ${basename}`);
    console.log('');
}

console.log('═══════════════════════════════════════════');
console.log('  Done! Run the synthetic generator to backfill:');
console.log('  node scripts/generate-synthetic-training.cjs --count 150');
console.log('  Then validate: node scripts/validate-training-data.cjs');
console.log('═══════════════════════════════════════════');
console.log('');
