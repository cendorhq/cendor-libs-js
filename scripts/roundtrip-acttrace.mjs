/**
 * Cross-language round-trip check (the JS-3 exit criterion, reverse direction):
 * write a signed audit chain with the JS @cendor/acttrace, so the Python `cendor.acttrace.verify()`
 * can confirm it verifies. Run from the cendor-libs-js repo root so `@cendor/*` resolve:
 *
 *   node scripts/roundtrip-acttrace.mjs <out-export.jsonl>
 *
 * Then, in the Python workspace:
 *   uv run python -c "from cendor.acttrace import verify; print(verify('<out-export.jsonl>', key='roundtrip-key'))"
 */
// Import built dist directly: acttrace's own linked node_modules resolves its internal '@cendor/core'
// to the SAME packages/core/dist module instance, so the bus is shared.
import { bus, LLMCall, Money, ToolCall, Usage } from '../packages/core/dist/index.js';
import { AuditLog } from '../packages/acttrace/dist/index.js';

const exportPath = process.argv[2];
if (!exportPath) throw new Error('usage: node scripts/roundtrip-acttrace.mjs <out-export.jsonl>');
const KEY = 'roundtrip-key';

const rawPath = exportPath.replace(/\.jsonl$/, '.raw.jsonl');
const log = new AuditLog('js-refund-bot', { riskTier: 'high', path: rawPath, signingKey: KEY });

await log.decision(
  async (d) => {
    d.record({ step: 'policy-check', allowed: true });
    const call = new LLMCall({
      id: 'x',
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'I want a refund' }],
    });
    call.usage = new Usage({ inputTokens: 10, outputTokens: 5 });
    call.cost = new Money('0.00042');
    call.latencyMs = 12.5;
    bus.emit(call);
    bus.emit(new ToolCall({ id: 't', name: 'search', arguments: { args: ['refund'], kwargs: {} }, result: { hits: 2 } }));
    d.humanOversight('alice', 'approved', 'looks fine');
  },
  { input: { question: 'refund?' }, actor: 'agent' },
);

log.export(exportPath, 'eu_ai_act');
console.log(JSON.stringify({ head: log.head, key: KEY, exportPath }));
log.detach();
