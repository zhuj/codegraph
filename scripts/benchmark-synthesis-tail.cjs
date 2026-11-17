#!/usr/bin/env node
'use strict';
/**
 * Reproducible synthetic hotspots; no network, no source writes, no graph caps.
 * Build both revisions, then run this once against each dist directory:
 *   node scripts/benchmark-synthesis-tail.cjs /checkout/dist
 * Compare edge digests as well as medians. This is NOT a whole-project speedup.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const dist = path.resolve(process.argv[2] || 'dist');
const { SYNTH_PASSES } = require(path.join(dist, 'resolution/callback-synthesizer.js'));
const { DatabaseConnection } = require(path.join(dist, 'db/index.js'));
const { QueryBuilder } = require(path.join(dist, 'db/queries.js'));
const { SynthesisStage } = require(path.join(dist, 'db/synthesis-stage.js'));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const median = values => [...values].sort((a,b) => a-b)[Math.floor(values.length / 2)];
const method = (id, startLine, endLine) => ({
  id, kind:'method', name:id, qualifiedName:`Channels::${id}`, language:'swift',
  filePath:'Sources/Channels.swift', startLine, endLine, startColumn:0, endColumn:1, updatedAt:0,
});

async function sourceSlices() {
  const lines = ['class Channels {'];
  const nodes = [];
  for (let i=0; i<2500; i++) {
    lines.push(`var callbacks${i}: [() -> Void] = []`);
    for (const [name, body] of [
      [`register${i}`, `callbacks${i}.append(callback)`],
      [`dispatch${i}`, `callbacks${i}.forEach { $0() }`],
    ]) {
      const first = lines.length + 1;
      lines.push(`func ${name}() {`, `  ${body}`, '}');
      nodes.push(method(name, first, lines.length));
    }
  }
  lines.push('}');
  const source = lines.join('\n');
  const query = {
    *iterateNodesByKind(kind) { if (kind === 'method') yield* nodes; },
    *iterateNodesByKindIn(kind, languages) { if (languages.includes('swift')) yield* this.iterateNodesByKind(kind); },
  };
  const pass = SYNTH_PASSES.find(p => p.name === 'closureCollEdges');
  const samples = [];
  let digest;
  for (let run=0; run<3; run++) {
    const context = { readFile: () => source }; // new per-run cache, not a warm-cache-only benchmark
    const started = performance.now();
    const edges = await pass.run(query, context, () => null);
    samples.push(performance.now() - started);
    if (edges.length !== 2500) throw new Error(`Unexpected closure edges: ${edges.length}`);
    const next = hash(edges);
    if (digest && digest !== next) throw new Error('Non-deterministic synthesis');
    digest = next;
  }
  return { methods:nodes.length, sourceBytes:Buffer.byteLength(source), edges:2500, samplesMs:samples, medianMs:median(samples), digest };
}

async function replacement() {
  const samples = [];
  let digest;
  for (let run=0; run<3; run++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bench-publish-'));
    let connection, stage;
    try {
      connection = DatabaseConnection.initialize(path.join(root,'index.db'));
      const q = new QueryBuilder(connection.getDb());
      q.insertNodes([method('a',1,1), method('b',2,2)]);
      const db = connection.getDb();
      db.exec('BEGIN');
      const insert = db.prepare("INSERT INTO edges(source,target,kind,line,metadata) VALUES('a','b','calls',?,?)");
      for(let i=0;i<100000;i++) insert.run(i, '{}');
      for(let i=100000;i<112000;i++) insert.run(i, '{"synthesizedBy":"old"}');
      db.exec('COMMIT');
      stage = new SynthesisStage(connection.getPath());
      stage.queries.insertEdge({source:'a',target:'b',kind:'calls',line:200000,metadata:{synthesizedBy:'new'}});
      const started = performance.now();
      await stage.publish();
      samples.push(performance.now() - started);
      const result = db.prepare('SELECT source,target,kind,line,metadata FROM edges ORDER BY line').all();
      if(result.length !== 100001) throw new Error(`Wrong publication size: ${result.length}`);
      const next = hash(result);
      if(digest && digest!==next) throw new Error('Non-deterministic publication');
      digest = next;
    } finally {
      stage?.close(); connection?.close(); fs.rmSync(root,{recursive:true,force:true});
    }
  }
  return { baseEdges:100000, replacedEdges:12000, samplesMs:samples, medianMs:median(samples), digest };
}
(async () => {
  console.log(JSON.stringify({ engine:dist, node:process.version, sourceSlices:await sourceSlices(), replacement:await replacement() }, null, 2));
})().catch(error => { console.error(error); process.exitCode=1; });
