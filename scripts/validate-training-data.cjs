/**
 * Validate all training samples in the combined JSONL file
 */
const fs = require('fs');
const path = require('path');

const file = path.join(__dirname, '..', 'data', 'training-data-combined.jsonl');
const lines = fs.readFileSync(file, 'utf8').trim().split('\n');

let errors = [];
let warnings = [];
let stats = {
    total: lines.length,
    full: 0, dismissal: 0, diagnostic: 0,
    shortPrompt: 0, detailedPrompt: 0,
    services: {}, severities: {}, confidences: {},
    outputLengths: [], instrLengths: [],
};
let uniqueOutputs = new Set();

for (let i = 0; i < lines.length; i++) {
    const lineLabel = `Sample ${i + 1}`;
    let d;

    // 1. JSON validity
    try { d = JSON.parse(lines[i]); } catch (e) {
        errors.push(`${lineLabel}: Invalid JSON — ${e.message}`);
        continue;
    }

    // 2. Required fields
    if (!d.instruction || typeof d.instruction !== 'string') {
        errors.push(`${lineLabel}: Missing or empty 'instruction' field`);
        continue;
    }
    if (d.input === undefined) {
        errors.push(`${lineLabel}: Missing 'input' field`);
    }
    if (!d.output || typeof d.output !== 'string') {
        errors.push(`${lineLabel}: Missing or empty 'output' field`);
        continue;
    }

    const instr = d.instruction;
    const out = d.output;
    stats.outputLengths.push(out.length);
    stats.instrLengths.push(instr.length);

    // 3. Check for 'undefined' or unexpected 'NaN'
    if (instr.includes('undefined')) errors.push(`${lineLabel}: 'undefined' in instruction`);
    if (out.includes('undefined')) errors.push(`${lineLabel}: 'undefined' in output`);
    if (out.includes('NaN')) errors.push(`${lineLabel}: 'NaN' in output`);
    // NaN in P99 field of instruction is expected for some Jaeger scenarios
    const instrWithoutP99 = instr.replace(/P99 Latency:.*$/m, '');
    if (instrWithoutP99.includes('NaN')) warnings.push(`${lineLabel}: 'NaN' in instruction (outside P99)`);

    // 4. Classify output type
    const hasSummary = out.includes('SUMMARY:');
    const hasCauses = out.includes('CAUSES:');
    const hasRecs = out.includes('RECOMMENDATIONS:');
    const hasConf = out.includes('CONFIDENCE:');
    const isFullAnalysis = hasSummary && hasCauses && hasRecs && hasConf;

    if (isFullAnalysis) {
        stats.full++;

        // Validate confidence value
        const confMatch = out.match(/CONFIDENCE:\s*(low|medium|high)/i);
        if (!confMatch) {
            errors.push(`${lineLabel}: Invalid or missing CONFIDENCE value`);
        } else {
            const c = confMatch[1].toLowerCase();
            stats.confidences[c] = (stats.confidences[c] || 0) + 1;
        }

        // Count bullet points (causes + recommendations)
        const bullets = (out.match(/^- /gm) || []).length;
        if (bullets < 4) errors.push(`${lineLabel}: Only ${bullets} bullet points (expected >= 4 causes+recs)`);
        if (bullets > 8) warnings.push(`${lineLabel}: Many bullet points (${bullets})`);

        // Check SUMMARY isn't empty
        const summaryMatch = out.match(/SUMMARY:\s*(.+)/);
        if (!summaryMatch || summaryMatch[1].trim().length < 20) {
            errors.push(`${lineLabel}: SUMMARY is too short or empty`);
        }
    } else if (out.length < 200) {
        stats.dismissal++;
        errors.push(`${lineLabel}: Dismissal output (${out.length} chars) — not a full analysis: "${out.substring(0, 60)}..."`);
    } else {
        stats.diagnostic++;
        errors.push(`${lineLabel}: Diagnostic output without required format (SUMMARY/CAUSES/RECOMMENDATIONS/CONFIDENCE missing)`);
    }

    // 5. Classify prompt type
    if (instr.includes('## Anomaly Details')) {
        stats.detailedPrompt++;
    } else {
        stats.shortPrompt++;
    }

    // 6. Extract service
    const svcMatch = instr.match(/Service:\s*(\S+)/);
    if (svcMatch) {
        stats.services[svcMatch[1]] = (stats.services[svcMatch[1]] || 0) + 1;
    }

    // 7. Extract severity
    const sevMatch = instr.match(/Severity:\s*SEV(\d)/);
    if (sevMatch) {
        const s = 'SEV' + sevMatch[1];
        stats.severities[s] = (stats.severities[s] || 0) + 1;
    }

    // 8. Track uniqueness
    uniqueOutputs.add(out);

    // 9. Semantic checks on output text
    if (out.toLowerCase().includes('as an ai') || out.toLowerCase().includes('i cannot')) {
        warnings.push(`${lineLabel}: Output contains AI self-reference language`);
    }
    if (out.includes('[') && out.includes(']') && !out.includes('[cause') && !out.includes('[your') && !out.includes('[recommendation')) {
        // This is fine, just checking for unfilled template placeholders
        if (out.match(/\[cause \d\]|\[recommendation \d\]|\[your summary\]/)) {
            errors.push(`${lineLabel}: Output contains unfilled template placeholder`);
        }
    }
}

// Print results
console.log('╔══════════════════════════════════════════════╗');
console.log('║     TRAINING DATA VALIDATION REPORT         ║');
console.log('╚══════════════════════════════════════════════╝');
console.log();
console.log(`Total samples: ${stats.total}`);
console.log(`Unique outputs: ${uniqueOutputs.size} / ${stats.total} (${((uniqueOutputs.size / stats.total) * 100).toFixed(1)}%)`);
console.log();

console.log('── Output Types ──');
console.log(`  Full analysis:   ${stats.full} (${((stats.full / stats.total) * 100).toFixed(1)}%)`);
console.log(`  Dismissal:       ${stats.dismissal} (${((stats.dismissal / stats.total) * 100).toFixed(1)}%)`);
console.log(`  Diagnostic:      ${stats.diagnostic} (${((stats.diagnostic / stats.total) * 100).toFixed(1)}%)`);
console.log();

console.log('── Prompt Types ──');
console.log(`  Detailed:        ${stats.detailedPrompt}`);
console.log(`  Short:           ${stats.shortPrompt}`);
console.log();

console.log('── Confidence Distribution ──');
Object.entries(stats.confidences).sort().forEach(([k, v]) => console.log(`  ${k}: ${v}`));
console.log();

console.log('── Service Distribution ──');
Object.entries(stats.services).sort((a, b) => b[1] - a[1]).forEach(([s, c]) => console.log(`  ${s}: ${c}`));
console.log();

console.log('── Severity Distribution ──');
Object.entries(stats.severities).sort().forEach(([s, c]) => console.log(`  ${s}: ${c}`));
console.log();

console.log('── Length Stats ──');
const avgOut = (stats.outputLengths.reduce((a, b) => a + b, 0) / stats.outputLengths.length).toFixed(0);
const minOut = Math.min(...stats.outputLengths);
const maxOut = Math.max(...stats.outputLengths);
const avgInstr = (stats.instrLengths.reduce((a, b) => a + b, 0) / stats.instrLengths.length).toFixed(0);
console.log(`  Instruction: avg=${avgInstr} chars, min=${Math.min(...stats.instrLengths)}, max=${Math.max(...stats.instrLengths)}`);
console.log(`  Output:      avg=${avgOut} chars, min=${minOut}, max=${maxOut}`);
console.log();

if (errors.length > 0) {
    console.log(`❌ ERRORS (${errors.length}):`);
    errors.forEach(e => console.log(`  ${e}`));
    console.log();
}
if (warnings.length > 0) {
    console.log(`⚠️  WARNINGS (${warnings.length}):`);
    warnings.forEach(w => console.log(`  ${w}`));
    console.log();
}

if (errors.length === 0) {
    console.log('✅ ALL SAMPLES PASSED VALIDATION');
} else {
    console.log(`❌ ${errors.length} ERROR(S) FOUND — fix before training`);
    process.exit(1);
}
