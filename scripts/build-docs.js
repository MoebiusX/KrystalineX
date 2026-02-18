#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { marked } from 'marked';

// Documents to build: [markdown file, output file, title, subtitle]
const documents = [
  {
    md: 'TRACES-AND-ANOMALY-MONITORING.md',
    out: 'traces-and-anomaly.html',
    title: 'Traces & Anomaly Monitoring — A Practical Guide',
    subtitle: 'A compact, Medium-style walkthrough that explains the tracing decisions we made and the design/implementation of the time-aware + adaptive anomaly detection system.'
  },
  {
    md: 'observability-article.md',
    out: 'observability-article.html',
    title: 'Building Observable Microservices',
    subtitle: 'A practical guide to distributed tracing and intelligent anomaly detection.'
  },
  {
    md: 'Krystaline-Audit-Medium.md',
    out: 'krystaline-audit.html',
    title: 'Lessons from a Day: Auditing and Hardening a TypeScript Trading App',
    subtitle: 'How focused observability, safe fixes, and incremental monitoring made a complex app more resilient.'
  }
];

const tplPath = path.resolve('docs', 'template.html');

if (!fs.existsSync(tplPath)) {
  console.error('Template not found:', tplPath);
  process.exit(1);
}

const templateBase = fs.readFileSync(tplPath, 'utf8');

for (const doc of documents) {
  const mdPath = path.resolve('docs', doc.md);
  const outPath = path.resolve('docs', doc.out);

  if (!fs.existsSync(mdPath)) {
    console.warn(`Skipping ${doc.md} - file not found`);
    continue;
  }

  const mdRaw = fs.readFileSync(mdPath, 'utf8');
  // Remove leading H1 in the markdown (the template includes the page title already)
  const md = mdRaw.replace(/^\s*#\s.*(?:\r?\n)+/, '');
  if (md !== mdRaw) console.log(`Removed leading H1 from ${doc.md} during build.`);

  const htmlBody = marked(md, { mangle: false, headerIds: true });

  // Create customized template with correct title
  let tpl = templateBase
    .replace(/<title>.*<\/title>/, `<title>${doc.title}</title>`)
    .replace(/<h1>.*<\/h1>/, `<h1>${doc.title}</h1>`)
    .replace(/<p class="lede">.*<\/p>/, `<p class="lede">${doc.subtitle}</p>`)
    .replace(/Generated from <code>.*<\/code>/, `Generated from <code>docs/${doc.md}</code>`)
    .replace('{{content}}', htmlBody);

  fs.writeFileSync(outPath, tpl, 'utf8');
  console.log('Wrote', outPath);
}

console.log('Done! Built', documents.length, 'documents.');
