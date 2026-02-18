/**
 * Convert Training Data to Axolotl Format
 * 
 * Converts our JSONL training data to the format expected by Axolotl.
 * 
 * Usage: node scripts/convert-training-data.js
 */

const fs = require('fs');
const path = require('path');

const INPUT_FILE = path.join(__dirname, '../data/training-data.jsonl');
const OUTPUT_FILE = path.join(__dirname, '../data/training-data-axolotl.jsonl');

// Read input
if (!fs.existsSync(INPUT_FILE)) {
    // Try alternative location
    const altInput = path.join(__dirname, '../data/training-examples.json');
    if (fs.existsSync(altInput)) {
        convertFromJson(altInput);
    } else {
        console.error('No training data found. Export from the app first:');
        console.error('  curl http://localhost:5000/api/monitor/training/export > data/training-data.jsonl');
        process.exit(1);
    }
} else {
    convertFromJsonl(INPUT_FILE);
}

function convertFromJsonl(inputPath) {
    const lines = fs.readFileSync(inputPath, 'utf-8').split('\n').filter(l => l.trim());
    const output = [];

    for (const line of lines) {
        try {
            const example = JSON.parse(line);

            // Convert to Axolotl format
            output.push(JSON.stringify({
                instruction: example.prompt,
                input: '',
                output: example.completion
            }));
        } catch (e) {
            console.warn('Skipping invalid line:', e.message);
        }
    }

    fs.writeFileSync(OUTPUT_FILE, output.join('\n'));
    console.log(`Converted ${output.length} examples to ${OUTPUT_FILE}`);
}

function convertFromJson(inputPath) {
    const data = JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
    const output = [];

    for (const example of data) {
        // Skip bad examples without corrections
        if (example.rating === 'bad' && !example.correction) {
            continue;
        }

        const completion = example.rating === 'bad'
            ? example.correction
            : example.completion;

        output.push(JSON.stringify({
            instruction: example.prompt,
            input: '',
            output: completion
        }));
    }

    fs.writeFileSync(OUTPUT_FILE, output.join('\n'));
    console.log(`Converted ${output.length} examples to ${OUTPUT_FILE}`);
}
